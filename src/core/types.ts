// Domain types and the two ports (surface, harness). See DESIGN.md §3.
// Nothing in this file (or anywhere under core/) may reference Slack or the
// Agent SDK — platform types live behind adapters/ (enforced by check-ports).

// ---------------------------------------------------------------------------
// Identity

/** Surface-verified identity. Authority attaches ONLY to this (DESIGN.md §4). */
export interface Principal {
  surface: string; // "slack" | "teams" | ...
  externalId: string; // platform-stable user id, e.g. "U0123ABC"
}

export function principalKey(p: Principal): string {
  return `${p.surface}:${p.externalId}`;
}

/**
 * Command authority (DESIGN.md §2). Only `architect` may approve gated actions,
 * order landings/deploys, or stop sessions. `member` converses; `observer` is
 * read-as-context only. Anyone not explicitly mapped defaults to `member`.
 */
export type Role = "architect" | "member" | "observer";

// ---------------------------------------------------------------------------
// Conversations

/**
 * A stable reference to one conversation on one surface.
 * `conversationId` is the surface's stable thread key and is ALWAYS a string
 * (Slack `ts` values have significant leading zeros in the fraction).
 */
export interface ConversationRef {
  surfaceId: string; // "slack"
  channelId: string; // the surface's container for conversations
  conversationId: string; // stable thread key within the container
}

export interface Attachment {
  kind: "image" | "file";
  name?: string;
  url?: string;
}

// ---------------------------------------------------------------------------
// Surface port — how humans reach Conduit

export type CommandName = "assign" | "status" | "stop" | "land" | "deploy" | "budget";

export type InboundEvent =
  | {
      kind: "message";
      conv: ConversationRef;
      author: Principal;
      text: string;
      attachments: Attachment[];
      /** Decoration only — attacker-editable free text, never authority. */
      authorDisplayName?: string;
    }
  | {
      kind: "command";
      conv: ConversationRef;
      author: Principal;
      name: CommandName;
      args: string;
    }
  | {
      kind: "approval_decision"; // M2
      requestId: string;
      decider: Principal;
      decision: "approved" | "denied";
    };

export interface OutboundMessage {
  text: string;
}

export interface PostedRef {
  conv: ConversationRef;
  messageId: string;
}

export interface SurfaceCapabilities {
  threads: boolean;
  editMessages: boolean;
  buttons: boolean;
  attachments: boolean;
  identityStrength: "verified" | "weak";
}

/** M2 — carried in the port from day one so the seam doesn't drift. */
export interface ApprovalPrompt {
  requestId: string;
  toolName: string;
  toolInput: unknown;
  summary: string;
}

export interface SurfaceAdapter {
  readonly id: string;
  readonly capabilities: SurfaceCapabilities;
  start(emit: (e: InboundEvent) => void): Promise<void>;
  stop(): Promise<void>;
  post(conv: ConversationRef, msg: OutboundMessage): Promise<PostedRef>;
  /** Only called when capabilities.editMessages is true. */
  update(ref: PostedRef, msg: OutboundMessage): Promise<void>;
  requestApproval(conv: ConversationRef, req: ApprovalPrompt): Promise<void>;
}

// ---------------------------------------------------------------------------
// Harness port — how Conduit drives a coding agent

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/**
 * THE capability (DESIGN.md §3): called for every tool call; the adapter must
 * hold the call un-executed until this resolves.
 *  - `allow` — run it now (optionally with rewritten input).
 *  - `deny`  — refuse; the reason is fed back to the agent so it adapts.
 *  - `gate`  — pause for out-of-band human approval. The adapter maps this to
 *    the SDK's `defer`: the turn ends with the pending call preserved, and a
 *    later `approval_decision` resumes the session (M0-verified handshake).
 */
export type GateDecision =
  | { decision: "allow"; updatedInput?: unknown }
  | { decision: "deny"; reason: string }
  | { decision: "gate" };

export type GateFn = (call: ToolCall) => Promise<GateDecision>;

export type TurnEvent =
  | { kind: "progress"; text: string }
  | { kind: "reply"; text: string; costUsd?: number }
  /**
   * A turn that ended without a usable reply. `costUsd` is carried because an
   * error result (including the SDK's `error_max_budget_usd`) still reports the
   * spend, and the core's cost ledger must count it (DESIGN §4 runaway cap).
   */
  | { kind: "error"; message: string; costUsd?: number }
  /**
   * A gated tool call was deferred: the turn ended un-executed with this call
   * preserved. The core records an approval and posts it to the surface; a
   * later architect decision resumes the session and re-drives `call`. `costUsd`
   * is the spend up to the defer (the SDK reports it on the deferring result).
   */
  | { kind: "deferred"; call: ToolCall; costUsd?: number }
  /**
   * The adapter's opaque handle changed (e.g. the underlying session id became
   * known). The core persists it immediately and never inspects it.
   */
  | { kind: "handle_updated"; handle: SessionHandle };

/** Opaque JSON owned by the harness adapter. The core persists, never reads. */
export type SessionHandle = unknown;

export interface TurnInput {
  text: string;
  /**
   * Optional per-turn cost ceiling in USD (M3). The harness enforces it as an
   * intra-turn runaway brake (Claude Code: the SDK's `maxBudgetUsd`), stopping a
   * single turn before it can blow the thread budget. The core computes it from
   * the session's remaining headroom; omitted = no per-turn limit.
   */
  budgetUsd?: number;
}

export interface HarnessSession {
  readonly handle: SessionHandle;
  turn(input: TurnInput, gate: GateFn): AsyncIterable<TurnEvent>;
  interrupt(): Promise<void>;
}

export interface HarnessCapabilities {
  mechanicalGating: boolean;
  resumeAfterRestart: boolean;
  costReporting: boolean;
  imageInput: boolean;
}

export interface HarnessAdapter {
  readonly id: string;
  readonly capabilities: HarnessCapabilities;
  create(opts: { cwd: string; system: string }): Promise<HarnessSession>;
  /**
   * `system` is re-supplied on every resume: the Conduit protocol prompt is
   * core policy, not session state, so a posture change (e.g. read-only → gated)
   * must reach existing sessions. The adapter must NOT freeze it in the handle.
   */
  resume(handle: SessionHandle, cwd: string, system: string): Promise<HarnessSession>;
}

// ---------------------------------------------------------------------------
// Repos

export interface RepoConfig {
  name: string;
  path: string; // absolute
  defaultBranch: string;
  /** Commands that run without approval (exact or word-boundary prefix match). */
  safeBashAllowlist: string[];
  /**
   * The repo's real test command (M3). Auto-allowed as a Bash call so the agent
   * can verify its own work without approval, and surfaced in the system prompt.
   * `undefined` = no test command; the agent must gate any bash it runs.
   */
  testCmd?: string;
  /**
   * The repo's land/deploy path (M3, DESIGN §2 journey 4). Architect-ordered
   * (`@Conduit land` / `deploy`) and run by the daemon through the approval gate,
   * never by the agent's shell. Build-time safety: these are `echo`/no-ops on the
   * throwaway repo until M4 hardening. `undefined` = the action is unavailable.
   */
  landCmd?: string;
  deployCmd?: string;
  /**
   * Per-thread cost ceiling in USD (M3, DESIGN §4). A session whose cumulative
   * `total_cost_usd` reaches this pauses and pings the architect; the ceiling is
   * seeded onto each session and an architect can raise it. `undefined` = fall
   * back to the daemon-wide default.
   */
  costCapUsd?: number;
}

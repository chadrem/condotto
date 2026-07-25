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
 * A surface-neutral reference to a person, for DISPLAY ONLY. The core never
 * knows how a surface linkifies a user, so it emits this token and the adapter
 * renders it natively (Slack: a real mention; email: a display name). Carries NO
 * authority — authority is a `Principal`, never rendered text.
 *
 * Delimiters are chosen to survive every stage of outbound rendering: no `<`,
 * `>` or `&` (they would be escaped), no backtick (code spans are held out of
 * rewriting), and nothing that collides with a surface's own mention markup.
 *
 * Identity must NOT be wrapped in backticks at the call site — a code span is
 * deliberately rendered literally, which would defeat the substitution.
 */
export function mentionToken(p: Principal | string): string {
  const key = typeof p === "string" ? p : principalKey(p);
  // A key carrying a delimiter or whitespace cannot be tokenized unambiguously;
  // degrade to the bare key rather than emit a token the adapter can't parse.
  return /[[\]\s]/.test(key) ? key : `@[[${key}]]`;
}

/**
 * Matches a mention token; group 1 is the principal key. Global, so use it only
 * with `String.replace` (which resets `lastIndex`), never bare `.test()`.
 */
export const MENTION_TOKEN_RE = /@\[\[([a-z0-9_]+:[^\][\s]{1,64})\]\]/gi;

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
// Surface port — how humans reach Condotto

export type CommandName =
  | "assign"
  | "status"
  | "stop"
  // interrupt the session's IN-FLIGHT turn (a wedged/over-cap multi-agent
  // workflow) without ending the session, mirroring `stop`'s architect-only,
  // thread-scoped shape. The detached background task is halted via q.interrupt()
  // and its spend is drained into the ledger (spike 2026-07-19, DECISIONS.md).
  | "cancel"
  | "land"
  | "deploy"
  | "budget"
  | "help"
  // harness capability controls (architect-only). model/effort tune the
  // implementer; subagents/ultra expose multi-agent power (opt-in, gated).
  | "model"
  | "effort"
  | "subagents"
  // the multi-agent Workflow tool (opt-in, gated + confined). Args are
  // "on"|"off" or "write on"|"write off" (the worktree-write opt-in).
  | "workflows"
  | "ultra"
  // architect self-approve toggle ("on"|"off"): an architect-initiated
  // turn's gated actions run without the Approve click (hard-deny floor stays).
  | "auto-approve"
  // in-thread role delegation (architect-only). `grant` args carry the
  // resolved target principal key + role (+ optional "everywhere"); `revoke`
  // carries the target (+ optional "everywhere"). The adapter resolves the
  // surface's linkified mention to a principal key so no surface id shape
  // crosses the port; it renders back out via `mentionToken`.
  | "grant"
  | "revoke";

export type InboundEvent =
  | {
      kind: "message";
      conv: ConversationRef;
      author: Principal;
      text: string;
      attachments: Attachment[];
      /** Decoration only — attacker-editable free text, never authority. */
      authorDisplayName?: string;
      /** True when the author @-mentioned Condotto. Lets the core offer guidance
       *  (vs. staying silent) when someone pings an unassigned thread. */
      mentioned?: boolean;
    }
  | {
      kind: "command";
      conv: ConversationRef;
      author: Principal;
      name: CommandName;
      args: string;
    }
  | {
      kind: "approval_decision";
      requestId: string;
      decider: Principal;
      decision: "approved" | "denied";
    }
  | {
      /** A human picked an option from a ChoicePrompt (e.g. which repo to assign). */
      kind: "choice";
      conv: ConversationRef;
      author: Principal;
      choiceId: string;
      value: string;
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

/**
 * A guided choice presented to a human. The core builds it (it knows the
 * options — e.g. which repos exist); the surface renders it natively (Slack:
 * buttons) and a click comes back as a `choice` InboundEvent carrying `choiceId`
 * and the selected `value`. Generic so future thread-setup questions (branch,
 * etc.) reuse the same primitive. `architectOnly` marks a choice that only a
 * command-authority principal may make (assignment); surfaces should reject
 * others for UX, but the core re-verifies authority regardless.
 */
export interface ChoiceOption {
  label: string;
  value: string;
}
export interface ChoicePrompt {
  choiceId: string; // e.g. "assign_repo"
  text: string; // the question
  options: ChoiceOption[];
  architectOnly?: boolean;
}

/** Carried in the port from day one so the seam doesn't drift. */
export interface ApprovalPrompt {
  requestId: string;
  toolName: string;
  toolInput: unknown;
  summary: string;
  /**
   * An optional human-facing warning that raises the stakes of this approval,
   * e.g. "investigating production data — in-thread results must be
   * aggregates only." Surfaces render it prominently; it is decoration for the
   * decider, never authority.
   */
  concern?: string;
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
  /** Present a guided choice. Only called when capabilities.buttons. */
  requestChoice(conv: ConversationRef, prompt: ChoicePrompt): Promise<void>;
}

// ---------------------------------------------------------------------------
// Harness port — how Condotto drives a coding agent

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  /**
   * Set when the call was initiated by a SUBAGENT rather than the main agent.
   * Opaque origin marker — the harness adapter fills it from the
   * subagent id the runtime reports (Claude Code: the PreToolUse hook's
   * `agent_id`, present only inside a subagent). The policy engine treats
   * subagent-initiated calls more strictly: reads pass (confined), but any gated
   * action or nested spawn is denied, because a subagent call cannot be paused
   * for out-of-band approval the way a main-agent call can (spike 2026-07-18).
   * WORKFLOW agents also carry `agentId`: under bypassPermissions the
   * background workflow's tool calls route through the PreToolUse hook with an
   * `agent_id`, so the same subagent policy confines them read-only.
   */
  agentId?: string;
  /**
   * Set when the call reached the gate via the harness's un-deferrable backstop
   * path (Claude Code: `canUseTool`) rather than the main PreToolUse hook.
   * Such a call CANNOT be paused for approval, so the policy engine confines it
   * instead of gating: confined reads pass, and (with the worktree-write opt-in)
   * confined writes pass, but anything that would otherwise `gate` is DENIED —
   * never left to `defer`. This is a defence-in-depth backstop; under
   * bypassPermissions workflow-agent calls normally hit the PreToolUse hook
   * (agentId) instead, but a call that escapes here is still confined, not leaked.
   */
  escaped?: boolean;
}

/**
 * THE capability (DESIGN.md §3): called for every tool call; the adapter must
 * hold the call un-executed until this resolves.
 *  - `allow` — run it now (optionally with rewritten input).
 *  - `deny`  — refuse; the reason is fed back to the agent so it adapts.
 *  - `gate`  — pause for out-of-band human approval. The adapter maps this to
 *    the SDK's `defer`: the turn ends with the pending call preserved, and a
 *    later `approval_decision` resumes the session (verified handshake).
 */
export type GateDecision =
  | { decision: "allow"; updatedInput?: unknown }
  | { decision: "deny"; reason: string }
  | { decision: "gate" };

export type GateFn = (call: ToolCall) => Promise<GateDecision>;

export type TurnEvent =
  | { kind: "progress"; text: string }
  /**
   * The turn's final reply. `workflow` marks a turn that ran a multi-agent
   * workflow, so the surface can append a terse "what ran + cost" summary
   * footer — the synthesized text is the agent's; the footer is Condotto's.
   */
  | { kind: "reply"; text: string; costUsd?: number; workflow?: boolean }
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

/**
 * Per-turn harness capability configuration. Everything here is OPAQUE to
 * the core: it persists these values and passes them through, never interpreting
 * them as policy (DESIGN §1 north-star, §4 ports). The adapter maps `model`
 * tokens to concrete SDK model IDs and validates `effort`; `subagents`/`workflows`
 * toggle multi-agent tools (still behind the §4 gate — a PreToolUse hook fires
 * inside subagents too, so their tool calls are gated exactly like the main
 * agent's); `projectConfig` loads a TRUSTED repo's settings/skills. The core
 * validates `model`/`effort` against `HarnessCapabilities` before they ever
 * reach here (a bad value is rejected at the command, never silently applied).
 */
export interface HarnessTurnOptions {
  /** Model token (e.g. "opus"); the adapter maps it to the SDK model ID. Omit = default. */
  model?: string;
  /** Reasoning effort (e.g. "high"|"xhigh"|"max"); passed through. Omit = default. */
  effort?: string;
  /** Enable subagent tools (Agent/Task). On by default; architect-toggleable. */
  subagents?: boolean;
  /**
   * Enable the multi-agent Workflow tool (on by default; architect-toggleable).
   * When on, the adapter re-enables the `Workflow` tool AND switches the query to
   * `permissionMode: "bypassPermissions"` — which, contrary to its name, routes the
   * background workflow's sub-agent tool calls THROUGH our PreToolUse hook (with an
   * `agent_id`) instead of the SDK's default-deny, so the hook still gates them
   * read-only (spike 2026-07-18, DECISIONS.md). The main agent's defer→approve→
   * resume loop is unaffected (hooks outrank permission mode). Implies subagents.
   */
  workflows?: boolean;
  /** Load the repo's project settings + skills. TRUSTED repos only. */
  projectConfig?: boolean;
  /**
   * Absolute directory for this session's durable agent memory, or omitted when
   * the repo has not been vouched for memory. Supplied by the core only after
   * `MemoryManager.prepare` has proven it (realpath + symlink sweep).
   *
   * The harness points its auto-memory feature here. Omitted must mean auto-memory
   * is pinned OFF, not merely unreachable: the feature loads regardless of
   * `settingSources`, so leaving it at its default would have the agent quietly
   * writing to a cwd-keyed directory that dies with the worktree — which is what it
   * has been doing all along (DECISIONS 2026-07-20).
   */
  memoryDir?: string;
}
// NOTE: the informed worktree-write opt-in is NOT a harness-tool
// option — it does not change the model, tools, or permission mode. It is a POLICY
// decision (PolicyContext.workflowWrite, set by the session manager from the
// session row), so it lives in the core gate, not in HarnessTurnOptions.

export interface TurnInput {
  text: string;
  /**
   * Optional per-turn cost ceiling in USD. The harness enforces it as an
   * intra-turn runaway brake (Claude Code: the SDK's `maxBudgetUsd`), stopping a
   * single turn before it can blow the thread budget. The core computes it from
   * the session's remaining headroom; omitted = no per-turn limit.
   */
  budgetUsd?: number;
  /**
   * Per-turn harness capabilities — opaque config the core forwards, never
   * core policy. Omitted = the adapter's own defaults.
   */
  harness?: HarnessTurnOptions;
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
  /**
   * Model tokens the architect may select, e.g. ["opus","sonnet","fable"].
   * The core validates an architect's `@Condotto model <x>` against this list —
   * membership only, so it never needs to know SDK model IDs (kept in the adapter).
   */
  supportedModels: string[];
  /** Reasoning-effort levels the architect may select, e.g. ["low",…,"max"]. */
  supportedEfforts: string[];
}

export interface HarnessAdapter {
  readonly id: string;
  readonly capabilities: HarnessCapabilities;
  /**
   * `cwd` is where the agent starts. `root` is the enclosing tree it must be able
   * to reach — the same path for an ordinary session, but the WORKTREE ROOT when
   * `cwd` is a monorepo sub-project, since the confinement boundary stays the whole
   * worktree while the agent works one level down. Adapters whose runtime scopes
   * access to `cwd` must widen it to `root`; omitted = `cwd`.
   */
  create(opts: { cwd: string; system: string; root?: string }): Promise<HarnessSession>;
  /**
   * `system` is re-supplied on every resume: the Condotto protocol prompt is
   * core policy, not session state, so a posture change (e.g. read-only → gated)
   * must reach existing sessions. The adapter must NOT freeze it in the handle.
   * `root` carries the same meaning as in `create`.
   */
  resume(handle: SessionHandle, cwd: string, system: string, root?: string): Promise<HarnessSession>;
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
   * The repo's real test command. Auto-allowed as a Bash call so the agent
   * can verify its own work without approval, and surfaced in the system prompt.
   * `undefined` = no test command; the agent must gate any bash it runs.
   */
  testCmd?: string;
  /**
   * The repo's land/deploy path (DESIGN §2 journey 4). Architect-ordered
   * (`@Condotto land` / `deploy`) and run by the daemon through the approval gate,
   * never by the agent's shell. Build-time safety: these are `echo`/no-ops on the
   * throwaway repo until later hardening. `undefined` = the action is unavailable.
   */
  landCmd?: string;
  deployCmd?: string;
  /**
   * Per-thread cost ceiling in USD (DESIGN §4). A session whose cumulative
   * `total_cost_usd` reaches this pauses and pings the architect; the ceiling is
   * seeded onto each session and an architect can raise it. `undefined` = fall
   * back to the daemon-wide default.
   */
  costCapUsd?: number;
  /**
   * Per-repo default model/effort tokens. Seeded onto each new
   * session (the architect can then change them per thread); opaque tokens
   * validated by the harness adapter. `undefined` = fall back to the daemon-wide
   * default (Opus 5 + xhigh).
   */
  defaultModel?: string;
  defaultEffort?: string;
  /**
   * Trust flag. A trusted repo loads its own project config —
   * `CLAUDE.md`, skills, `.claude/agents`, and daemon-configured MCP — while the
   * §4 gate still applies. Default (false/undefined) keeps the untrusted-repo
   * isolation (`settingSources: []`). Set ONLY for repos the admin vouches for:
   * it also loads that repo's permissions/hooks/MCP. A throwaway repo used to
   * shake out a new install should stay untrusted.
   */
  trusted?: boolean;
  /**
   * Per-repo default for the architect self-approve setting. Seeded onto
   * each new session (the architect can then toggle it per thread with
   * `@Condotto auto-approve on|off`). `undefined` = fall back to the daemon-wide
   * default (`SessionManagerOptions.defaultAutoApprove`, on by default).
   */
  autoApprove?: boolean;
  /**
   * Per-repo harness posture, seeded onto each new session (the architect can
   * then toggle either per thread). `undefined` = fall back to the daemon-wide
   * default (`SessionManagerOptions.defaultSubagents`/`defaultWorkflows`, both
   * on). `workflows` implies `subagents` — the seed asserts that invariant, so
   * `workflows = true, subagents = false` still starts with subagents on.
   *
   * NOT a vouch like `trusted` or `memory`: these widen how much work a session
   * can do in parallel, not what authority it carries. Confined (subagent-,
   * workflow-, and escaped-origin) calls stay read-only under `evaluateConfined`
   * either way.
   */
  subagents?: boolean;
  workflows?: boolean;
  /**
   * Durable agent memory for this repo. When on, the session gets a
   * Condotto-owned memory directory (scoped per repo AND channel) that the SDK's
   * auto-memory feature reads at session start and the agent writes through the
   * §4 gate, so knowledge compounds across threads instead of dying with each
   * worktree. Default (false/undefined) = off, and auto-memory is pinned off in
   * the harness rather than merely unreachable.
   *
   * An operator VOUCH like `trusted`, not a per-session toggle: what one thread
   * records is loaded into the SYSTEM PROMPT of every later thread in that
   * channel — above `framing.ts`, and so outside the `user=`-header authority
   * rule. See DECISIONS 2026-07-20.
   */
  memory?: boolean;
}

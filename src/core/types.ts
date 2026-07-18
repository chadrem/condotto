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

export type CommandName = "assign" | "status" | "stop";

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
 * hold the call un-executed until this resolves. In M1 the answer is instant
 * (read-only allow / deny); the defer machinery arrives in M2.
 */
export type GateFn = (call: ToolCall) => Promise<
  | { decision: "allow"; updatedInput?: unknown }
  | { decision: "deny"; reason: string }
>;

export type TurnEvent =
  | { kind: "progress"; text: string }
  | { kind: "reply"; text: string; costUsd?: number }
  | { kind: "error"; message: string }
  /**
   * The adapter's opaque handle changed (e.g. the underlying session id became
   * known). The core persists it immediately and never inspects it.
   */
  | { kind: "handle_updated"; handle: SessionHandle };

/** Opaque JSON owned by the harness adapter. The core persists, never reads. */
export type SessionHandle = unknown;

export interface TurnInput {
  text: string;
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
  resume(handle: SessionHandle, cwd: string): Promise<HarnessSession>;
}

// ---------------------------------------------------------------------------
// Repos

export interface RepoConfig {
  name: string;
  path: string; // absolute
  defaultBranch: string;
}

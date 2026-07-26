// Domain types and the two ports (surface, harness).
// Nothing in this file (or anywhere under core/) may reference Slack or the
// Agent SDK — platform types live behind adapters/ (enforced by check-ports).

// ---------------------------------------------------------------------------
// Identity

/** Surface-verified identity. Authority attaches ONLY to this. */
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
 * Command authority, and there are only two levels because there is only one
 * decision: an `architect` sets the agent working; a `member` talks in the thread
 * and their messages are held for the next architect turn. Anyone not explicitly
 * mapped is a member.
 */
export type Role = "architect" | "member";

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

/**
 * A file someone dropped in the thread.
 *
 * `ref` is how the SURFACE finds the bytes again — a Slack `url_private`, a
 * message-part id elsewhere. It is opaque here on purpose: the core hands it back
 * to `fetchAttachment` and never parses it, which is what keeps a platform URL
 * shape out of the core. `name` is whoever-uploaded-it's text and must be
 * sanitized before it reaches a path or a prompt (`safeAttachmentName`).
 */
export interface Attachment {
  kind: "image" | "file";
  name?: string;
  /** Opaque surface handle for fetching the bytes. Absent = not retrievable. */
  ref?: string;
  mimeType?: string;
  sizeBytes?: number;
}

/** A file Condotto is sending back to the thread. */
export interface OutboundFile {
  /** Absolute path on disk. Always inside the session's worktree. */
  path: string;
  /** Filename to show in the thread. */
  name: string;
  /** Optional line of text posted with it. */
  comment?: string;
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
  // and its spend is drained into the ledger.
  | "cancel"
  // wipe the agent's conversation context WITHOUT ending the session: the thread,
  // worktree, branch, uncommitted work, settings, roles, memory and cost ledger all
  // survive. The core drops the opaque harness handle so the next attach takes
  // getOrAttachHarness's create() branch — no harness feature is required and no
  // model turn is spent.
  | "clear"
  | "budget"
  | "help"
  // harness capability controls (architect-only). model/effort tune the
  // implementer; subagents/workflows widen the fan-out. Args are "on"|"off".
  | "model"
  | "effort"
  | "subagents"
  | "workflows"
  // Dispatch a harness skill / slash command on an architect's behalf
  // (`@Condotto /<name> <args>`). Args are "<name> [raw args…]". This is the only
  // path to a skill the AGENT cannot invoke: a skill marked
  // `disable-model-invocation` is withheld from the model and reachable only by a
  // human naming it. The core validates the name and normalizes the argument text
  // (`checkSkillArgs`); the adapter owns the harness's invocation syntax.
  | "skill"
  // List what this session's harness will dispatch (architect-only).
  | "skills"
  // in-thread role delegation (architect-only). `grant` args carry the
  // resolved target principal key + role (+ optional "everywhere"); `revoke`
  // carries the target (+ optional "everywhere"). The adapter resolves the
  // surface's linkified mention to a principal key so no surface id shape
  // crosses the port; it renders back out via `mentionToken`.
  | "grant"
  | "revoke"
  // read-only planning for this thread ("on"|"off", architect-only, in-thread
  // only — no config knob and no repo default, because it is a per-TASK mode).
  // While on, only genuine reads run and the agent presents a plan into the
  // thread. `plan off` is how it ends; there is no button.
  | "plan"
  // publish this thread's session to claude.ai so it can be driven from the Claude
  // apps ("on"|"off", architect-only, in-thread only). The one command that widens
  // who can reach a session beyond this surface's roles, which is why it is
  // per-thread and opt-in rather than a config knob.
  | "remote_control";

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

export interface SurfaceAdapter {
  readonly id: string;
  readonly capabilities: SurfaceCapabilities;
  start(emit: (e: InboundEvent) => void): Promise<void>;
  stop(): Promise<void>;
  post(conv: ConversationRef, msg: OutboundMessage): Promise<PostedRef>;
  /**
   * Download an inbound file. Returns null when the surface cannot produce the
   * bytes — a revoked file, a permission the app was not granted, a timeout. The
   * core treats null as "this one did not arrive" and carries on with the rest,
   * because losing the MESSAGE over a failed download would be the worse trade.
   * Only called when capabilities.attachments is true.
   */
  fetchAttachment(a: Attachment): Promise<Uint8Array | null>;
  /**
   * Upload a file into the conversation. Only called when
   * capabilities.attachments is true.
   */
  postFile(conv: ConversationRef, file: OutboundFile): Promise<void>;
  /** Only called when capabilities.editMessages is true. */
  update(ref: PostedRef, msg: OutboundMessage): Promise<void>;
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
   * `agent_id`, present only inside a subagent). Workflow agents carry it too:
   * under bypassPermissions the background workflow's tool calls route through
   * the PreToolUse hook with an `agent_id`.
   *
   * AUDIT DETAIL ONLY. The policy is origin-blind — a subagent acting inside an
   * architect's turn is the architect's turn.
   */
  agentId?: string;
  /**
   * Set when the call arrived on the harness's backstop path (Claude Code:
   * `canUseTool`) rather than the main PreToolUse hook. Audit detail, like
   * `agentId`: the floor applies identically on both paths.
   */
  escaped?: boolean;
}

/**
 * THE capability: called for every tool call; the adapter must hold the call
 * un-executed until this resolves. That is what makes a deny mean something —
 * never simulate it by watching output.
 *  - `allow` — run it now (optionally with rewritten input).
 *  - `deny`  — refuse; the reason is fed back to the agent so it adapts.
 */
export type GateDecision =
  | { decision: "allow"; updatedInput?: unknown }
  | { decision: "deny"; reason: string };

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
   * spend, and the core's cost ledger must count it.
   */
  | { kind: "error"; message: string; costUsd?: number }
  /**
   * The adapter's opaque handle changed (e.g. the underlying session id became
   * known). The core persists it immediately and never inspects it.
   */
  | { kind: "handle_updated"; handle: SessionHandle };

/** Opaque JSON owned by the harness adapter. The core persists, never reads. */
export type SessionHandle = unknown;

/**
 * Per-turn harness capability configuration. Everything here is OPAQUE to the
 * core: it persists these values and passes them through, never interpreting them
 * as policy. The adapter maps `model` tokens to SDK model IDs and validates
 * `effort`; `subagents`/`workflows` toggle the multi-agent tools. The core
 * validates `model`/`effort` against `HarnessCapabilities` before they ever reach
 * here, so a bad value is rejected at the command rather than silently applied.
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
   * `agent_id`) instead of the SDK's default-deny, so every one of them is still
   * evaluated. Hooks outrank permission mode. Implies subagents.
   */
  workflows?: boolean;
  /**
   * Absolute directory for this session's durable agent memory, or omitted when
   * the repo has not been vouched for memory. Supplied by the core only after
   * `MemoryManager.prepare` has proven it (realpath + symlink sweep).
   *
   * The harness points its auto-memory feature here. Omitted must mean auto-memory
   * is pinned OFF, not merely unreachable: the feature loads regardless of
   * `settingSources`, so leaving it at its default would have the agent quietly
   * writing to a cwd-keyed directory that dies with the worktree — which is what it
   * has been doing all along.
   */
  memoryDir?: string;
  /**
   * Run this turn in read-only PLANNING mode: the agent investigates and presents
   * a plan instead of doing the work.
   *
   * Harness-neutral by name — the adapter maps it to whatever its runtime calls
   * plan mode, the same way `workflows` maps to `bypassPermissions`. The core
   * never mints an SDK mode string, just as it never mints a model id.
   *
   * This is a CAPABILITY flag, not the policy. What actually keeps a planning
   * session read-only is `PolicyContext.planMode`; the harness layer is a second,
   * weaker line. Turning this on without the policy flag would be a session that
   * only looks read-only.
   */
  planMode?: boolean;
  /**
   * Absolute directory the harness should write plan files to, when `planMode` is
   * on. REQUIRED with it, and it must be absolute and inside the worktree.
   *
   * Not a detail the core could leave to the adapter. The Claude Code runtime
   * defaults to `~/.claude/plans/`, which is outside the worktree and therefore
   * hard-denied — the agent could never present a plan at all. And a relative path
   * resolves against `cwd`, which for a monorepo session is the sub-project rather
   * than the worktree root. The core owns the confinement
   * boundary, so the core names the directory.
   */
  plansDir?: string;
}

/**
 * A skill / slash command a human may dispatch into a session. DISPLAY DATA ONLY —
 * `description` is authored by whoever wrote the skill and carries no authority, so
 * it must be passed through `sanitizeSkillText` before it is rendered anywhere.
 *
 * `path` is the resolved absolute source file. It exists because provenance cannot
 * be recovered later: the harness reports a flat list of names that de-duplicates
 * shadowed entries, so which FILE a name resolves to is answerable only at
 * enumeration time. The core shows it to the architect; it never interprets it.
 */
export interface HarnessSkill {
  name: string;
  description?: string;
  source: "repo" | "operator";
  path: string;
  /**
   * A caveat about how this skill will behave under Condotto, surfaced to the
   * architect before it runs. Condotto-authored, unlike `description` — it says
   * something the skill's own text cannot know, e.g. that a capability the skill
   * assumes has been disabled for safety.
   */
  warning?: string;
}

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
  /**
   * Dispatch a harness-native skill / slash command on this turn INSTEAD of prose.
   * The core supplies a bare name (already checked against the adapter's own
   * enumeration) and argument text already refused-or-accepted by
   * `checkSkillArgs`; the adapter renders it in whatever form its runtime
   * dispatches (Claude Code: a leading `/name args` prompt string). The core never
   * mints that syntax — same split as `model` tokens.
   *
   * A skill turn carries `text: ""`: there is no message, so there is no framed
   * body. Authority was established at the command, where the invoker was proven an
   * architect on a `verified` surface. Every tool call the skill then makes is
   * evaluated exactly like any other turn's.
   */
  skill?: { name: string; args?: string };
}

export interface HarnessSession {
  readonly handle: SessionHandle;
  turn(input: TurnInput, gate: GateFn): AsyncIterable<TurnEvent>;
  interrupt(): Promise<void>;
  /**
   * Skills this session will dispatch via `TurnInput.skill`, or `null` when the
   * harness cannot enumerate them. SYNCHRONOUS and cache-only by contract:
   * enumerating must never spawn a turn or spend budget, because `@Condotto skills`
   * is a listing, not work. Names the adapter refuses are already absent, so
   * membership in this list IS the core's authorization signal.
   */
  listSkills(): readonly HarnessSkill[] | null;
  /**
   * Publish this session so a human can drive it from somewhere other than the
   * surface it belongs to (remote control), or stop publishing it.
   *
   * Optional: a harness without it simply has no remote control, and
   * `HarnessCapabilities.remoteControl` is what the core checks before offering the
   * command. A refusal is a RETURNED VALUE, not a throw, so the core can post the
   * harness's own reason (wrong auth mode, stale credential, service refusal) instead
   * of a generic failure notice.
   *
   * `handle` on the success arm is opaque and persisted verbatim
   * (`sessions.remote_control`), the same contract as `SessionHandle`. Enabling twice
   * is idempotent and returns the existing url.
   *
   * A published session OUTLIVES this object. `HarnessSession` instances are
   * replaced whenever the core rebuilds one (a posture toggle, a thrown turn), and a
   * bridge torn down by that would hand the architect a new url every time they typed
   * `subagents off`. So the adapter must key the bridge on something session-stable
   * (the worktree), not on this instance, and turning it OFF has to be an explicit
   * call from the core — never a side effect of an instance being dropped.
   */
  setRemoteControl?(
    enabled: boolean,
    opts: { name: string; handle?: string | null; sink: RemoteControlSink },
  ): Promise<RemoteControlResult>;
}

/**
 * How a published session reports back to the core. Plain callbacks: nothing
 * transport-shaped crosses the port, so the core never sees a JWT, a remote session
 * id, or an SSE cursor.
 */
export interface RemoteControlSink {
  /**
   * A human typed somewhere other than the thread. `text` is the message AS TYPED —
   * the core frames it (`frameMessage`) and runs it as an ordinary turn, so it is
   * authority-checked, budgeted, audited and FIFO-serialized identically to one typed
   * in the thread. Nothing reaches the model unframed.
   */
  onRemoteInput(text: string): void;
  /** The bridge ended (closed, evicted, credential expired). Carries a human reason. */
  onClosed(reason: string): void;
}

export type RemoteControlResult =
  | {
      ok: true;
      /** Where a human opens this session. Posted into the thread; never parsed. */
      url: string;
      /** Opaque, persisted to `sessions.remote_control`. */
      handle: string;
    }
  | { ok: false; reason: string };

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
  /**
   * The harness can dispatch a named skill supplied by a human (`TurnInput.skill`).
   * False ⇒ `@Condotto /<name>` is refused at the command, so the core never emits
   * a `skill` a harness cannot honour.
   */
  skillInvocation: boolean;
  /**
   * The harness can run a turn in read-only planning mode (`HarnessTurnOptions.
   * planMode`). False ⇒ `@Condotto plan on` is refused at the command, so the core
   * never emits an option a harness cannot honour — the `skillInvocation` rule.
   *
   * Unlike `mechanicalGating` this is negotiable: a harness without it simply has
   * no plan mode. The read-only guarantee itself does NOT depend on it, since the
   * core policy enforces that independently.
   */
  planMode: boolean;
  /**
   * The harness can publish a session for driving from elsewhere
   * (`HarnessSession.setRemoteControl`). False ⇒ `@Condotto remote-control on` is
   * refused at the command — the `skillInvocation` rule again.
   *
   * Says only that the harness has the feature, NOT that the machine is configured
   * for it. Whether the credential can actually mint a remote session is the
   * adapter's to answer, and it answers by refusing with a reason.
   */
  remoteControl: boolean;
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
   * `system` is re-supplied on every resume: the Condotto protocol prompt is core
   * policy, not session state, so a posture change (plan mode on, memory enabled,
   * workflows off) must reach existing sessions. The adapter must NOT freeze it in
   * the handle. `root` carries the same meaning as in `create`.
   */
  resume(handle: SessionHandle, cwd: string, system: string, root?: string): Promise<HarnessSession>;
  /**
   * Release anything the adapter holds that outlives an individual session object —
   * today, published remote-control bridges. Called once on daemon shutdown.
   * Idempotent, never throws, and bounded: shutdown must not block on a wedged
   * network transport.
   *
   * This sits on the ADAPTER rather than on `HarnessSession` deliberately. Session
   * objects are transient (the core rebuilds them on posture changes and thrown
   * turns) while a bridge belongs to the session's whole life, so a per-object
   * teardown hook would close it at exactly the wrong moments.
   */
  shutdown?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Repos

export interface RepoConfig {
  name: string;
  path: string; // absolute
  defaultBranch: string;
  /**
   * Per-thread cost ceiling in USD. A session whose cumulative
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
   * Per-repo harness posture, seeded onto each new session (the architect can
   * then toggle either per thread). `undefined` = fall back to the daemon-wide
   * default (`SessionManagerOptions.defaultSubagents`/`defaultWorkflows`, both
   * on). `workflows` implies `subagents` — the seed asserts that invariant, so
   * `workflows = true, subagents = false` still starts with subagents on.
   *
   * NOT a vouch like `memory`: these widen how much work a session can do in
   * parallel, not what it may reach. A subagent is confined exactly as the main
   * agent is.
   */
  subagents?: boolean;
  workflows?: boolean;
  /**
   * Durable agent memory for this repo. When on, the session gets a
   * Condotto-owned memory directory (scoped per repo AND channel) that the SDK's
   * auto-memory feature reads at session start and the agent writes with
   * Write/Edit, so knowledge compounds across threads instead of dying with each
   * worktree. Default (false/undefined) = off, and auto-memory is pinned off in
   * the harness rather than merely unreachable.
   *
   * ON by default (`[defaults].memory`), because a thread that starts from zero
   * every time is how an install ends up never seeming to learn anything.
   *
   * Still an operator-level setting rather than a per-thread toggle: what one
   * thread records is loaded into the SYSTEM PROMPT of every later thread in that
   * channel — above `framing.ts`, and so outside the `user=`-header authority
   * rule. `undefined` here means "not stated"; `loadConfig` resolves it against
   * the daemon default before this ever reaches the store.
   */
  memory?: boolean;
}

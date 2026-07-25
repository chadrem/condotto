import { query } from "@anthropic-ai/claude-agent-sdk";
import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  GateFn,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessSession,
  HarnessTurnOptions,
  SessionHandle,
  TurnEvent,
  TurnInput,
} from "../../core/types";
import { parseWorkflowMeta } from "../../core/policy";

/**
 * The SDK `query()` surface the adapter drives — narrowed to what `runQuery` uses
 * (an async iterable of messages plus `interrupt`). Injectable so tests can drive
 * the real adapter loop with a scripted SDK message stream (buffering, canUseTool,
 * hook mapping) without a live query. Production uses the real `query`.
 */
export type QueryFn = (args: { prompt: unknown; options: Record<string, any> }) => AsyncIterable<Record<string, any>> & {
  interrupt(): Promise<void>;
};

// Claude Code harness adapter over the Agent SDK.
//
// Verified facts this code builds on (spike 2026-07-16 + live docs, see
// DECISIONS.md and DESIGN.md Appendix B):
//  - Auth is EITHER an Anthropic API key OR the machine's Claude subscription
//    login (keychain OAuth / headless CLAUDE_CODE_OAUTH_TOKEN). The credential is
//    resolved by the composition root (core/config loadAuthConfig) and handed in;
//    this file never reads it from the environment itself.
//
//    REVERSED 2026-07-20. This comment previously read "There is no
//    ANTHROPIC_API_KEY in this deployment and this file must never read one" —
//    true of the original single-operator deployment, wrong as a rule for an
//    installable daemon. Anthropic's guidance is that developers building on the
//    Agent SDK authenticate with a Console API key, and that Free/Pro/Max plan
//    limits assume ordinary individual use; Condotto is explicitly multi-person.
//    So API key is now the documented default and subscription OAuth is the
//    explicitly single-operator path. Both are supported. See DECISIONS.md
//    2026-07-20 and DESIGN.md Appendix B.
//
//    The key reaches the model by riding the SDK subprocess environment — the
//    SDK's documented mechanism (sdk.d.ts:1414 names ANTHROPIC_API_KEY as a
//    variable the subprocess needs inherited). That means it is readable from the
//    agent's own shell, exactly as CLAUDE_CODE_OAUTH_TOKEN already is; what
//    guards it is the policy hard-deny on commands naming either variable
//    (core/policy.ts) plus CommandRunner's scrub. Do not weaken either.
//  - `resume: <sessionId>` + same cwd resumes a session across processes;
//    session storage is keyed by encoded cwd, so cwd must be stable.
//  - Without the claude_code systemPrompt preset the model has no environment
//    context (it invents paths) — always use the preset + append.
//  - `session_id` arrives on the `system`/`init` message.
//
// The core GateFn answers allow/deny/gate for every tool call.
//  - allow  -> PreToolUse `allow` (reads stay auto-approved; the hook still
//              confines them, which beats allowedTools per the SDK precedence).
//  - deny   -> PreToolUse `deny` with a reason fed back to the agent.
//  - gate   -> PreToolUse `defer`: the turn ends un-executed with the pending
//              call preserved (verified); the core records an approval, and a
//              later architect decision resumes the session to re-drive it.
// `canUseTool` is the deny-by-default backstop for the one batching caveat:
// when the model issues several tool calls in one batch, `defer` is ignored and
// the gated call falls through the permission flow to canUseTool, which denies
// it (verified doc precedence: hooks -> deny/ask rules -> permission mode ->
// allow rules -> canUseTool).

/**
 * Opaque to the core. Owned entirely by this adapter. Deliberately does NOT
 * carry the system prompt — that is core policy, re-supplied on every
 * create/resume so a posture change reaches existing sessions. (Legacy handles
 * from an earlier version may still contain a `system` field; asHandle ignores it.)
 */
interface ClaudeCodeHandle {
  v: 1;
  sessionId: string | null;
}

// `allowedTools` auto-approves reads (the hook still denies out-of-worktree
// reads — a hook `deny` beats an allow rule). Write/Edit/Bash are deliberately
// NEITHER allowed (they must gate) NOR disallowed (they must be reachable so the
// agent can propose them). NOTE: when the Workflow tool is enabled we clear
// allowedTools and drive reads through the PreToolUse hook instead — in
// allowedTools a tool is "auto-approved before the callback is consulted", and for
// a background workflow's sub-agents that shadow path silently DENIES the read
// (spike 2026-07-18). Via the hook, reads still auto-allow (confined) for the main
// agent and the workflow agents alike.
const ALLOWED_TOOLS = ["Read", "Glob", "Grep", "TodoWrite"];
// Always removed from context, regardless of capability flags: plan-mode meta,
// slash commands, and network reads are out of scope for the implementer.
const BASE_DISALLOWED = ["ExitPlanMode", "SlashCommand", "WebFetch", "WebSearch"];
// Subagent tools, disabled BY DEFAULT (subagents are architect opt-in). Both the
// current `Agent` name and the legacy `Task` alias are listed so "subagents off"
// is genuinely off regardless of which the runtime exposes. Un-disallowed per-turn
// only when the session enables the capability; even then every tool call a
// subagent makes still hits the PreToolUse gate (agent_id-tagged).
const SUBAGENT_TOOLS = ["Agent", "Task"];
// The multi-agent Workflow tool (architect opt-in). Disabled by default and
// re-enabled per-turn only when the session enables workflows. When enabled the
// query runs under `permissionMode: "bypassPermissions"` so the background
// workflow's sub-agent tool calls route THROUGH the PreToolUse hook (agent_id-
// tagged) where the read-only subagent policy confines them — the hook still
// outranks permission mode, so main-agent defer/deny are unaffected (spike
// 2026-07-18, DECISIONS.md). Was disabled outright earlier (which used
// permissionMode "default", under which the same agents default-DENY off-gate).
const WORKFLOW_TOOL = "Workflow";

// Model/effort. The core passes an opaque model token; the adapter is the only
// place that knows SDK model IDs (keeps the port clean). Unrecognized tokens
// pass through (the SDK also accepts bare aliases / full IDs), but the core has
// already validated against `supportedModels`, so that path is belt-and-braces.
const MODEL_IDS: Record<string, string> = {
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  fable: "claude-fable-5",
};
const SUPPORTED_MODELS = Object.keys(MODEL_IDS);
// Independent of extended thinking. xhigh needs Fable 5 / Opus 4.7+ / Sonnet 5
// (our Opus 5 default qualifies, and is why xhigh is the shipped default); the
// SDK silently falls back to `high` elsewhere. Note that Opus 5 refuses a request
// that DISABLES thinking at xhigh/max — we set no thinking option, so don't start.
const SUPPORTED_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/**
 * Daemon-side subagent definitions. When the architect enables
 * subagents, the implementer fans out to these for parallel READ-ONLY work; their
 * tool calls still hit the gate (agent_id-tagged), and the restricted `tools` list
 * is defense-in-depth. Subagents never write/run shell — the policy engine denies
 * any subagent-initiated gated call (defer→resume is main-agent-only), so the main
 * agent performs mutations through the approval loop. Daemon-defined (not from repo
 * config), so enabling them needs no repo trust.
 */
const SUBAGENT_DEFS = {
  explorer: {
    description:
      "Read-only exploration: reads, searches, and summarizes the codebase in parallel. " +
      "Use to investigate before the main agent makes changes.",
    prompt:
      "You are a read-only exploration subagent for Condotto. Use Read/Glob/Grep to investigate " +
      "the working tree and report concise, specific findings (files, symbols, line numbers). You " +
      "cannot write files or run shell commands; if a change is needed, describe exactly what the " +
      "main agent should do. Stay within the working tree.",
    tools: ["Read", "Glob", "Grep", "TodoWrite"],
  },
};

function resolveModel(token: string | undefined): string | undefined {
  if (!token) return undefined;
  return MODEL_IDS[token] ?? token;
}
function resolveEffort(token: string | undefined): string | undefined {
  return token && SUPPORTED_EFFORTS.includes(token) ? token : undefined;
}

/**
 * Build the per-turn tool posture from the session's harness capabilities.
 * Subagent / workflow tools are removed from context unless the architect opted
 * in. When workflows are ON, reads move OUT of allowedTools onto the hook (so the
 * background workflow's sub-agents aren't shadow-denied — see WORKFLOW_TOOL);
 * otherwise reads stay auto-allowed via allowedTools (unchanged behaviour).
 * Write/bash are always absent from both lists so they gate.
 */
function toolPosture(h: HarnessTurnOptions | undefined): {
  allowedTools: string[];
  disallowedTools: string[];
} {
  const disallowed = [...BASE_DISALLOWED];
  if (!h?.subagents) disallowed.push(...SUBAGENT_TOOLS);
  if (!h?.workflows) disallowed.push(WORKFLOW_TOOL);
  const allowedTools = h?.workflows ? [] : ALLOWED_TOOLS;
  return { allowedTools, disallowedTools: disallowed };
}

/** Deny message for a gated call that arrived batched (defer unavailable). */
const BATCH_GATE_DENY =
  "This action needs an architect's approval, but it came in a parallel batch of tool calls, " +
  "which can't be paused for approval. Re-issue it on its own and I'll request approval.";

/**
 * The SDK warns — with a full stack trace, on EVERY query() — that read-only
 * tools are "shadowed" from canUseTool by allowedTools
 * (CLAUDE_SDK_CAN_USE_TOOL_SHADOWED). For Condotto that is expected and correct:
 * read-only tools are auto-approved by allowedTools and confined by the
 * PreToolUse hook, so they must never reach the deny-by-default canUseTool
 * backstop — only gated tools do (see DECISIONS.md). Left alone it masquerades
 * as an error in the daemon log after every turn. Silence exactly that one
 * warning code (nothing else) across every emission path. Idempotent; runs once
 * on import so both the daemon and the smoke scripts get clean output.
 */
const SDK_SHADOW_WARNING = "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED";
let sdkWarningsSuppressed = false;
function suppressKnownSdkWarnings(): void {
  if (sdkWarningsSuppressed) return;
  sdkWarningsSuppressed = true;
  const mentions = (v: unknown): boolean => {
    if (typeof v === "string") return v.includes(SDK_SHADOW_WARNING);
    if (v && typeof v === "object") {
      const o = v as { code?: unknown; message?: unknown };
      if (o.code === SDK_SHADOW_WARNING) return true;
      if (typeof o.message === "string" && o.message.includes(SDK_SHADOW_WARNING)) return true;
    }
    return false;
  };
  for (const method of ["warn", "error"] as const) {
    const orig = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      if (!args.some(mentions)) orig(...args);
    };
  }
  const origEmit = process.emitWarning.bind(process);
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const opt = rest[0];
    const code = opt && typeof opt === "object" ? (opt as { code?: unknown }).code : rest[1];
    if (code === SDK_SHADOW_WARNING || mentions(warning)) return;
    return (origEmit as (...a: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}
suppressKnownSdkWarnings();

/** Abort a turn if the SDK produces nothing at all for this long. */
const TURN_INACTIVITY_MS = 10 * 60_000;
/** After we ask for an interrupt, wait only this long to drain the final result's
 *  cost before giving up (the SDK settles the aborted turn fast — spike b, ~567ms). */
const DRAIN_AFTER_ABORT_MS = 30_000;

/**
 * rider (a): env-scrub the agent shell. The SDK's `options.env` REPLACES the
 * subprocess environment entirely (sdk.d.ts:1411), so this is a DENYLIST over a
 * spread of `process.env`: drop the daemon's own secret namespaces (`SLACK_*`,
 * `CONDOTTO_*`) so an in-worktree Bash command can never read the daemon's Slack
 * tokens or config from its own environ, while PRESERVING everything the toolchain
 * and the Claude Code CLI need — `PATH`/`HOME`, the repo's build env, and the Claude
 * auth token (which never matches these prefixes, so keychain OAuth AND a headless
 * `CLAUDE_CODE_OAUTH_TOKEN` both survive). Belt-and-braces over the §4 policy floor
 * (credential/secret hard-deny stays); spike-proven under keychain OAuth
 * (verified 2026-07-19). Distinct from CommandRunner's scrub, which
 * drops a fixed NAME list incl. the Claude auth token because a deploy command,
 * unlike the agent, does not need it.
 */
const DAEMON_SECRET_ENV_PREFIXES = ["SLACK_", "CONDOTTO_"];

/**
 * The resolved harness credential, handed down by the composition root. Structurally
 * `core/config`'s `AuthConfig`, restated locally so the adapter depends on the shape
 * rather than importing a core type through the port.
 */
export type HarnessAuth = { mode: "api_key" | "subscription"; apiKey?: string };
export function scrubDaemonEnv(base: NodeJS.ProcessEnv, auth?: HarnessAuth): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (DAEMON_SECRET_ENV_PREFIXES.some((p) => k.startsWith(p))) continue;
    out[k] = v;
  }
  // Three states, deliberately distinct. NO auth argument — tests and the
  // scripts/smoke-* harnesses, which construct the adapter bare — means inherit
  // whatever the environment has, exactly as before this parameter existed; a
  // smoke run under api_key auth must still pick up the operator's key.
  if (!auth) return out;
  // A RESOLVED auth config, from the daemon's composition root, is authoritative:
  // api_key installs the chosen key, and subscription deletes any ANTHROPIC_API_KEY
  // the daemon happened to inherit, so a stray shell-profile export can't silently
  // bill an operator who configured subscription auth. Keychain OAuth and a headless
  // CLAUDE_CODE_OAUTH_TOKEN are untouched in every state.
  if (auth.mode === "api_key" && auth.apiKey) out.ANTHROPIC_API_KEY = auth.apiKey;
  else delete out.ANTHROPIC_API_KEY;
  return out;
}

/** rider (b): the reason a turn's query was interrupted, for the notice. */
type AbortReason = "timeout" | "cancel" | "budget";
function abortNotice(reason: AbortReason, sawWorkflow: boolean, costUsd: number | undefined): string {
  const what = sawWorkflow ? "the running workflow" : "the running turn";
  const spent = costUsd !== undefined ? ` ($${costUsd.toFixed(2)} spent this turn)` : "";
  switch (reason) {
    case "timeout":
      return `I stopped ${what} after 10 minutes with no activity${spent}.`;
    case "cancel":
      return `Cancelled — I stopped ${what}${spent}.`;
    case "budget":
      return (
        `I hit this thread's cost budget and stopped ${what}${spent}. ` +
        `An architect can raise it with \`@Condotto budget <usd>\` to continue.`
      );
  }
}

function asHandle(handle: SessionHandle): ClaudeCodeHandle {
  const h = handle as Partial<ClaudeCodeHandle> | null;
  if (!h || h.v !== 1 || (h.sessionId !== null && h.sessionId !== undefined && typeof h.sessionId !== "string")) {
    throw new Error("claude-code: unrecognized session handle");
  }
  return { v: 1, sessionId: h.sessionId ?? null };
}

/** True when running inside a `bun build --compile` binary: its module URLs live
 *  in Bun's virtual FS (`/$bunfs/` POSIX, `~BUN` Windows) rather than on disk. */
function isCompiledBinary(): boolean {
  return import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN");
}

/**
 * The native `claude` CLI the SDK spawns as its runtime subprocess.
 *
 * Under `bun run` (dev / clone-and-run) the SDK resolves it from `node_modules`
 * itself — return `undefined` and change nothing. A `bun build --compile` binary
 * can't: the SDK resolves its native CLI relative to a `$bunfs` path no child
 * process can exec, and the 236MB per-platform package was never bundled. So when
 * compiled, point the SDK at a real `claude`, in priority order:
 *   1. CONDOTTO_CLAUDE_CLI — explicit operator override (any installed `claude`,
 *      or a custom sidecar path). `extractFromBunfs` is a no-op on a real path
 *      and future-proofs an embedded (`type: "file"` → `$bunfs`) path pointed here.
 *   2. a `claude` sidecar next to the compiled binary — the default release
 *      bundle (`condotto` + `claude` shipped together).
 * Gated on the compiled-binary signal so a dev box with Claude Code installed
 * next to `bun` (e.g. /opt/homebrew/bin/claude) is never silently picked up.
 */
function resolveClaudeCliPath(): string | undefined {
  const override = process.env.CONDOTTO_CLAUDE_CLI?.trim();
  if (override) {
    const resolved = extractFromBunfs(override);
    if (existsSync(resolved)) return resolved;
    console.warn(
      `[claude-code] CONDOTTO_CLAUDE_CLI="${override}" does not exist — ignoring it and falling ` +
        `back to the SDK's own CLI resolution.`,
    );
  }
  if (isCompiledBinary()) {
    // Name must match what scripts/build-binary.ts ships beside the binary
    // (claude.exe on Windows, claude elsewhere) — Node's existsSync is a literal
    // path check, not a PATHEXT lookup.
    const claudeName = process.platform === "win32" ? "claude.exe" : "claude";
    const sidecar = join(dirname(process.execPath), claudeName);
    if (existsSync(sidecar)) return sidecar;
    console.warn(
      `[claude-code] running as a compiled binary but found no '${claudeName}' CLI beside it ` +
        `(${dirname(process.execPath)}) and CONDOTTO_CLAUDE_CLI is unset — the agent runtime will ` +
        `fail to start. Ship the native '${claudeName}' next to the binary or set CONDOTTO_CLAUDE_CLI.`,
    );
  }
  return undefined;
}

// Resolved lazily on first turn (not at module load) so `--help`/`--version` in
// a compiled binary never emit the resolution warning. The path is process-
// stable (execPath/env don't change mid-run), so memoize the first result —
// `undefined` included.
let claudeCliPathMemo: { value: string | undefined } | undefined;
function claudeCliPath(): string | undefined {
  return (claudeCliPathMemo ??= { value: resolveClaudeCliPath() }).value;
}

class ClaudeCodeSession implements HarnessSession {
  constructor(
    private _handle: ClaudeCodeHandle,
    private cwd: string,
    /** Condotto protocol prompt (preset append). Supplied fresh each turn. */
    private system: string,
    /** The SDK query function (injectable for tests). */
    private queryFn: QueryFn,
    /** Inactivity watchdog window; overridable so tests can exercise the timeout→
     *  interrupt→drain path without waiting 10 minutes. Defaults to the constant. */
    private turnInactivityMs: number = TURN_INACTIVITY_MS,
    /**
     * The enclosing tree the agent must reach when `cwd` is a monorepo
     * sub-project — the worktree root. Undefined (or equal to `cwd`) for an
     * ordinary session. See `additionalDirectories` at the query below.
     */
    private root?: string,
    /**
     * The resolved harness credential, or undefined to inherit the ambient
     * environment (tests / smoke harnesses). Never read from the environment here.
     */
    private auth?: HarnessAuth,
  ) {}

  /** The in-flight query, so an out-of-band interrupt() can reach it.
   *  Null when no turn is running. */
  private activeQuery: ReturnType<QueryFn> | null = null;
  /** Set when interrupt() actually fired on the active query — the turn loop then
   *  drains the aborted result's cost and reports a cancellation instead of an error. */
  private cancelRequested = false;

  get handle(): SessionHandle {
    return this._handle;
  }

  async *turn(input: TurnInput, gate: GateFn): AsyncIterable<TurnEvent> {
    // Fresh per turn — a stale flag from a prior cancel must not taint this turn.
    this.cancelRequested = false;
    yield* this.runQuery(input, gate, /* allowFreshRetry */ true);
  }

  private async *runQuery(
    input: TurnInput,
    gate: GateFn,
    allowFreshRetry: boolean,
  ): AsyncGenerator<TurnEvent> {
    // The gate is THE security boundary — it must fail closed. A gate that
    // throws would otherwise fall through to the SDK permission system, where
    // allowedTools would silently auto-approve the call.
    const gateHook = async (hookInput: unknown, toolUseID: string | undefined) => {
      const call = hookInput as { tool_name?: string; tool_input?: unknown; agent_id?: string };
      let decision: Awaited<ReturnType<GateFn>>;
      try {
        decision = await gate({
          id: toolUseID ?? "",
          name: call.tool_name ?? "unknown",
          input: call.tool_input,
          // Present ONLY inside a subagent. The core policy treats
          // subagent-initiated calls read-only (gated actions denied) since a
          // subagent call can't be paused for approval (defer is main-thread-only).
          agentId: call.agent_id,
        });
      } catch (err) {
        decision = { decision: "deny", reason: `gate error (denied fail-closed): ${err}` };
      }
      // Map the domain decision onto the SDK's PreToolUse contract. `gate`
      // becomes `defer`, which ends the query with the pending call preserved
      // (updatedInput is ignored on defer, per the docs).
      const out =
        decision.decision === "allow"
          ? {
              permissionDecision: "allow" as const,
              updatedInput: decision.updatedInput as Record<string, unknown> | undefined,
            }
          : decision.decision === "deny"
            ? { permissionDecision: "deny" as const, permissionDecisionReason: decision.reason }
            : {
                permissionDecision: "defer" as const,
                permissionDecisionReason: "Gated by Condotto — awaiting an architect's approval.",
              };
      return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, ...out } };
    };

    // Per-turn harness capabilities (opaque config from the core). model/
    // effort tune the implementer; subagents/workflows toggle multi-agent tools;
    // projectConfig loads a trusted repo's settings.
    const h = input.harness;
    const { allowedTools, disallowedTools } = toolPosture(h);
    const model = resolveModel(h?.model);
    const effort = resolveEffort(h?.effort);
    // A trusted repo loads its own project settings + skills; the §4 gate
    // still applies (the PreToolUse hook fires regardless of settingSources, and a
    // hook deny/defer beats any repo allow-rule per SDK precedence). Untrusted
    // (default) does not load the REPO's CLAUDE.md/.mcp.json/.claude/ — repo
    // content is untrusted input and must not register MCP servers or alter
    // permissions (§4). That is what `settingSources` governs.
    //
    // It does NOT govern skill discovery. The OPERATOR's own user-level skills
    // (~/.claude) reach the agent in BOTH postures — verified live 2026-07-20, and
    // stated in sdk.d.ts: omitting the `skills` option is "no SDK auto-configuration.
    // The CLI's own defaults still apply", i.e. explicitly NOT "skills off".
    // This is INTENDED for Condotto (decision 2026-07-20): the daemon runs on the
    // operator's own machine under their account, and the implementer is meant to
    // be as capable there as they are. It is not a gate hole — a skill is
    // instructions, and every tool call it makes still hits the hook (`Skill`
    // itself is an unknown tool, so invoking one gates). Pass `skills: []` here if
    // an install ever wants the operator's skills genuinely off.
    const settingSources: ("user" | "project" | "local")[] = h?.projectConfig ? ["project"] : [];

    // Workflows run under bypassPermissions ONLY so the background workflow's
    // sub-agent tool calls route through the PreToolUse hook (agent_id-tagged) where
    // the policy confines them — NOT to weaken gating. Hooks outrank permission
    // mode, so main-agent defer/deny and the canUseTool backstop still hold (spike
    // 2026-07-18: diag3/diag4). Non-workflow sessions stay "default" (unchanged).
    const permissionMode = h?.workflows ? ("bypassPermissions" as const) : ("default" as const);

    // The canUseTool backstop now runs the CORE policy on an `escaped` call —
    // a call that reached this un-deferrable path instead of the hook (a batched
    // gated call, or a workflow-agent call that didn't carry agent_id). The policy
    // confines it: reads pass, a would-be gate becomes deny (can't defer here), and
    // with the worktree-write opt-in confined writes pass. Fail closed on error.
    const canUseToolFn = async (toolName: string, toolInput: unknown) => {
      let decision: Awaited<ReturnType<GateFn>>;
      try {
        decision = await gate({ id: "", name: toolName, input: toolInput, escaped: true });
      } catch (err) {
        decision = { decision: "deny", reason: `gate error (denied fail-closed): ${err}` };
      }
      if (decision.decision === "allow") {
        return {
          behavior: "allow" as const,
          updatedInput: (decision.updatedInput ?? toolInput) as Record<string, unknown>,
        };
      }
      // deny, or a defensive gate (the policy never gates an escaped call — that
      // would strand it un-deferred — so treat any gate here as a fail-closed deny).
      const message = decision.decision === "deny" ? decision.reason : BATCH_GATE_DENY;
      return { behavior: "deny" as const, message };
    };

    const q = this.queryFn({
      prompt: input.text,
      options: {
        cwd: this.cwd,
        // A monorepo sub-project session starts BELOW the worktree root, but the
        // whole worktree stays in scope (shared packages, root config) — the
        // confinement boundary is the worktree, enforced by our PreToolUse hook.
        // The SDK models working roots at or below cwd, so name the root
        // explicitly or it would sit above the session and be unreachable. Omitted
        // when cwd already IS the root, keeping ordinary sessions byte-identical.
        ...(this.root && this.root !== this.cwd ? { additionalDirectories: [this.root] } : {}),
        resume: this._handle.sessionId ?? undefined,
        // rider (a): scrub the daemon's own SLACK_*/CONDOTTO_* secrets from the
        // environment the agent's Bash inherits (belt-and-braces over the §4 policy
        // floor). options.env REPLACES the subprocess env, so this is a denylist
        // spread of process.env that keeps PATH/HOME + the toolchain + the Claude
        // auth token the SDK needs (spike-proven under keychain OAuth).
        env: scrubDaemonEnv(process.env, this.auth),
        // Point the SDK at the native `claude` CLI when running as a compiled
        // binary; omitted under `bun run`, where the SDK finds it itself.
        ...(claudeCliPath() ? { pathToClaudeCodeExecutable: claudeCliPath()! } : {}),
        systemPrompt: { type: "preset", preset: "claude_code", append: this.system },
        allowedTools,
        disallowedTools,
        permissionMode,
        // Exact SDK model id + reasoning effort. Omitted = SDK
        // defaults; the core always supplies them (default Opus 5 + xhigh).
        ...(model ? { model } : {}),
        ...(effort ? { effort: effort as "low" | "medium" | "high" | "xhigh" | "max" } : {}),
        // Intra-turn runaway brake (DESIGN §4). The SDK stops the turn if it
        // exceeds this, returning an `error_max_budget_usd` result we surface as
        // a clear Slack notice (never a silent stall). The core passes the
        // session's remaining thread headroom; omitted = no per-turn cap.
        ...(typeof input.budgetUsd === "number" && input.budgetUsd > 0
          ? { maxBudgetUsd: input.budgetUsd }
          : {}),
        // When subagents are enabled, offer the read-only `explorer`
        // subagent (restricted toolset — defense-in-depth over the gate).
        ...(h?.subagents ? { agents: SUBAGENT_DEFS } : {}),
        // Load the trusted repo's skills alongside its project settings.
        ...(h?.projectConfig ? { skills: "all" as const } : {}),
        // Untrusted (default): never load filesystem settings (CLAUDE.md,
        // .mcp.json, .claude/) from the worktree — repo content is untrusted
        // input and must not register MCP servers or alter permissions (§4).
        settingSources,
        // Auto-memory. The `settings` tier is the highest user-controlled layer and
        // applies regardless of `settingSources`, so this PINS the posture in both
        // directions rather than relying on a default:
        //   on  — point it at the core's proven per-(repo, channel) directory. The
        //         SDK default is keyed on the SANITIZED CWD (sdk.d.ts:6378), i.e. a
        //         worktree that gets destroyed, so without this memory cannot persist.
        //   off — explicitly false, which also closes the one path by which a
        //         TRUSTED repo's checked-in settings could switch memory on. (The SDK
        //         already ignores `autoMemoryDirectory` from project settings "for
        //         security", but not `autoMemoryEnabled`.)
        // The agent writes memory with ordinary Write/Edit, so those calls hit the
        // hook below and the core's memory rules govern them (spike 2026-07-20).
        // NOTE: deliberately NOT added to `additionalDirectories` — the spike showed
        // the write lands without it, so widening the SDK's own scope buys nothing.
        settings: h?.memoryDir
          ? { autoMemoryEnabled: true, autoMemoryDirectory: h.memoryDir }
          : { autoMemoryEnabled: false },
        hooks: { PreToolUse: [{ hooks: [gateHook] }] },
        // Backstop for calls that reach the un-deferrable path (batched gated
        // calls; escaped workflow-agent calls). Runs the core confinement policy
        // (see canUseToolFn): reads pass, gated actions deny, worktree-write opt-in
        // allows confined writes. In the normal single-call flow the hook is
        // terminal and this is never reached.
        canUseTool: canUseToolFn,
      },
    });

    // Expose the running query so an out-of-band interrupt() (architect `@Condotto
    // cancel`) can reach it. Cleared in the finally.
    this.activeQuery = q;
    let sawResult = false;
    // A workflow turn produces MULTIPLE `result` messages: an intermediate
    // "workflow launched; waiting…" success, then the FINAL synthesized success
    // once the background workflow completes (spike 2026-07-18). Buffer the latest
    // success and deliver only it at turn end, so the human sees the real answer,
    // not "launched; waiting". A terminal deferred/error supersedes and clears it.
    let pendingReply: { text: string; costUsd?: number } | null = null;
    // Track the background workflow so we can stream a live status
    // line and tag the final reply for the summary footer.
    let sawWorkflow = false;
    let lastWorkflowDesc = "";
    // rider (b): when a turn is interrupted — inactivity timeout, an architect
    // `@Condotto cancel`, or a budget breach that hit a RUNNING workflow — we stop the
    // (possibly detached) background task and DRAIN the aborted result's cost into the
    // ledger, then post one notice. `q.interrupt()` is the only lever that actually
    // halts a detached workflow (maxBudgetUsd does NOT — spike b), and the aborted
    // result still carries total_cost_usd, so the runaway cap stays accurate.
    let abortReason: AbortReason | null = null;
    let drainedCost: number | undefined;
    try {
      const iterator = q[Symbol.asyncIterator]();
      // A SINGLE in-flight pull, re-raced against the timeout across abort re-arms. It
      // must be reused (not re-created) on a timeout: Promise.race leaves the losing
      // iterator.next() pending, and a fresh next() would be queued BEHIND it — so the
      // stale pull would swallow the interrupt's aborted result (and its cost) and the
      // new one would get `done`. Advance `pending` only after actually consuming a step.
      let pending = iterator.next();
      while (true) {
        // Inactivity watchdog: a wedged SDK query must not hang the session's turn
        // queue forever. Once we're draining after an abort, wait only briefly for
        // the aborted result's cost before giving up (the SDK settles fast).
        let timer: ReturnType<typeof setTimeout> | undefined;
        // Once ANY interrupt is in flight (an in-loop abort OR an out-of-band cancel),
        // wait only briefly for the aborted result's cost, not the full inactivity window.
        const aborting = abortReason !== null || this.cancelRequested;
        const waitMs = aborting ? DRAIN_AFTER_ABORT_MS : this.turnInactivityMs;
        const timeout = new Promise<"timeout">((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout("timeout"), waitMs);
        });
        let step: IteratorResult<Record<string, any>> | "timeout";
        try {
          step = await Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
        } catch (pullErr) {
          // After an interrupt/abort the SDK can THROW on the pull that FOLLOWS the
          // terminal result (observed: [ede_diagnostic] … stop_reason=tool_use — spike
          // b). The result + cost already arrived, so if an abort is in flight this is
          // the expected clean end. Otherwise it's a real failure — rethrow.
          if (aborting) break;
          throw pullErr;
        }
        if (step === "timeout") {
          // Already interrupting and the aborted result didn't arrive in time — give up
          // on the cost rather than waiting/re-interrupting forever.
          if (aborting) break;
          // No SDK activity for 10 minutes. Interrupt to halt any detached background
          // workflow (which would otherwise keep spending after the turn parks), then
          // re-race the SAME `pending` so the interrupt's aborted result is drained.
          abortReason = "timeout";
          await q.interrupt().catch(() => {});
          continue;
        }
        if (step.done) break;
        // Consumed a real message — prefetch the next one on a fresh pull.
        pending = iterator.next();

        const m = step.value as Record<string, any>;
        if (m.type === "system" && m.subtype === "init") {
          if (m.session_id && m.session_id !== this._handle.sessionId) {
            this._handle = { ...this._handle, sessionId: m.session_id };
            yield { kind: "handle_updated", handle: this._handle };
          }
          continue;
        }
        // A running workflow emits background-task lifecycle system
        // messages (task_started/task_progress/task_updated, background_tasks_
        // changed). Note the workflow ran, and stream a live status line — but only
        // when the description changes (task_progress repeats per agent as tokens
        // accumulate). Each such message also resets the inactivity watchdog above.
        if (m.type === "system" && typeof m.subtype === "string" && (m.subtype.startsWith("task") || m.subtype === "background_tasks_changed")) {
          sawWorkflow = true;
          const desc = describeWorkflowEvent(m);
          if (desc && desc !== lastWorkflowDesc) {
            lastWorkflowDesc = desc;
            yield { kind: "progress", text: desc };
          }
          continue;
        }
        if (m.type === "assistant") {
          const blocks: any[] = m.message?.content ?? [];
          for (const block of blocks) {
            if (block?.type === "tool_use") {
              yield { kind: "progress", text: describeToolUse(block.name, block.input) };
            }
          }
          continue;
        }
        if (m.type === "result") {
          sawResult = true;
          // total_cost_usd is reported on EVERY result — success, deferred, and
          // error (incl. error_max_budget_usd) — so the core's cost ledger and
          // runaway cap count all of them (verified against SDKResult* types).
          const cost = typeof m.total_cost_usd === "number" ? m.total_cost_usd : undefined;
          // An architect `@Condotto cancel` interrupted this turn out-of-band: the SDK
          // now emits an aborted result. Capture its cost and report the cancellation.
          if (this.cancelRequested && !abortReason) abortReason = "cancel";
          // Already aborting (cancel/timeout, or a budget breach handled just below):
          // just drain the cost; the single post-loop notice reports it.
          if (abortReason) {
            if (cost !== undefined) drainedCost = cost;
            continue;
          }
          const deferred = m.deferred_tool_use as
            | { id?: string; name?: string; input?: unknown }
            | undefined;
          if (m.terminal_reason === "tool_deferred" || deferred) {
            // A gated tool call was deferred (verified handshake). Hand the
            // preserved pending call to the core to record an approval; the turn
            // is over until an architect decides and the session is resumed. A
            // defer is the real outcome — drop any buffered intermediate reply.
            pendingReply = null;
            if (deferred?.id) {
              yield {
                kind: "deferred",
                call: { id: deferred.id, name: deferred.name ?? "unknown", input: deferred.input },
                costUsd: cost,
              };
            } else {
              yield {
                kind: "error",
                message: "a tool call was deferred but no pending call was preserved",
                costUsd: cost,
              };
            }
          } else if (m.subtype === "success") {
            // Buffer, don't yield: a later result may supersede this one (workflow
            // "launched" → "completed"). Delivered after the loop (last wins).
            pendingReply = {
              text: typeof m.result === "string" && m.result.length > 0 ? m.result : "(no reply)",
              costUsd: cost,
            };
          } else if (m.subtype === "error_max_budget_usd" || m.terminal_reason === "budget_exhausted") {
            if (sawWorkflow) {
              // The budget brake fired DURING a workflow. The SDK signal alone does
              // NOT stop the detached background task — it keeps spending past the cap
              // (spike b). Interrupt to actually halt it (auto-cancel on breach), then
              // drain + report once via the post-loop notice.
              abortReason = "budget";
              if (cost !== undefined) drainedCost = cost;
              await q.interrupt().catch(() => {});
              continue;
            }
            // The turn hit its cost budget and stopped. Surface it clearly
            // with the spend — the core will then pause the session (§4).
            pendingReply = null;
            yield {
              kind: "error",
              message:
                `I hit this turn's cost budget${cost !== undefined ? ` ($${cost.toFixed(2)})` : ""} and ` +
                `stopped before finishing. An architect can raise the budget to let me continue.`,
              costUsd: cost,
            };
          } else {
            pendingReply = null;
            yield { kind: "error", message: `session turn ended abnormally (${m.subtype})`, costUsd: cost };
          }
        }
      }
      // A cancel whose interrupt-throw arrived before any aborted result still counts
      // as an abort (no cost to drain, but report it cleanly rather than as "no reply").
      // BUT if the turn had already buffered a completed success when the cancel landed
      // (the cancel raced a just-finished turn), deliver that reply + its cost — dropping
      // it would lose the reply AND under-count the turn's spend against the runaway cap.
      const abort: AbortReason | null = abortReason ?? (this.cancelRequested && !pendingReply ? "cancel" : null);
      if (abort) {
        yield { kind: "error", message: abortNotice(abort, sawWorkflow, drainedCost), costUsd: drainedCost };
      } else if (pendingReply) {
        // Deliver the final buffered reply (the last success result of the turn).
        yield { kind: "reply", text: pendingReply.text, costUsd: pendingReply.costUsd, workflow: sawWorkflow };
      }
    } catch (err) {
      // A persisted session id the runtime no longer knows (pruned storage,
      // moved machine) would otherwise wedge the thread forever. Recover by
      // starting fresh once: context is lost but the conversation continues.
      const message = err instanceof Error ? err.message : String(err);
      // Recover a normal message turn by starting fresh — but NEVER an
      // approval-resume (empty prompt): a fresh session would silently drop the
      // just-approved action and wipe context (#10). Let that surface as error.
      if (
        allowFreshRetry &&
        // Never retry an interrupted turn — the architect/timeout ended it on purpose.
        !this.cancelRequested &&
        input.text.trim().length > 0 &&
        this._handle.sessionId &&
        /No conversation found/i.test(message)
      ) {
        this._handle = { ...this._handle, sessionId: null };
        yield { kind: "handle_updated", handle: this._handle };
        yield {
          kind: "progress",
          text: "previous session could not be resumed — starting fresh (prior context lost)",
        };
        yield* this.runQuery(input, gate, false);
        return;
      }
      throw err;
    } finally {
      // The query is done (or being abandoned) — stop routing interrupts to it so a
      // later `@Condotto cancel` on an idle session is a clean no-op, not a stray abort.
      if (this.activeQuery === q) this.activeQuery = null;
    }
    // A turn that produced no result at all (and wasn't an intentional abort) is an
    // error. An abort (timeout/cancel/budget) already yielded its own notice above, so
    // don't also emit "produced no result" — that would double-post a contradictory
    // message (e.g. a wedged query that times out with nothing drainable).
    if (!sawResult && !this.cancelRequested && !abortReason) {
      yield { kind: "error", message: "session turn produced no result" };
    }
  }

  /**
   * Interrupt the in-flight turn's query: halts a wedged/over-cap multi-agent
   * workflow — `q.interrupt()` is the only lever that actually stops the DETACHED
   * background task (spike b) — and lets the turn loop drain the aborted result's
   * cost. A no-op when no turn is running, so an architect `@Condotto cancel` on an
   * idle session does nothing. Only sets `cancelRequested` when a query is actually
   * live, so it can never taint a subsequent normal turn.
   */
  async interrupt(): Promise<void> {
    const q = this.activeQuery;
    if (!q) return;
    this.cancelRequested = true;
    await q.interrupt().catch(() => {});
  }
}

function describeToolUse(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "Read":
      return `reading ${i.file_path ?? "a file"}`;
    case "Glob":
      return `listing files matching ${i.pattern ?? "a pattern"}`;
    case "Grep":
      return `searching for ${i.pattern ?? "a pattern"}`;
    case "TodoWrite":
      return "updating its plan";
    case "Write":
      return `preparing to write ${i.file_path ?? "a file"}`;
    case "Edit":
    case "MultiEdit":
      return `preparing to edit ${i.file_path ?? "a file"}`;
    case "Bash":
      return `preparing to run a command`;
    case "Agent":
    case "Task":
      return `delegating to a subagent`;
    case "Workflow": {
      // The workflow script begins with `export const meta = { name, description }`.
      const meta = parseWorkflowMeta(i.script ?? i.scriptPath);
      return meta?.name ? `launching workflow \`${meta.name}\`` : `launching a multi-agent workflow`;
    }
    default:
      return `using ${name}`;
  }
}

/**
 * A live status line for a workflow background-task system message.
 * Returns null for events not worth surfacing. `task_progress.description` is the
 * per-agent activity (e.g. "Read: read-readme"); `background_tasks_changed` marks
 * the running set. Kept terse (Slack ergonomics) — the caller de-dups repeats.
 */
function describeWorkflowEvent(m: Record<string, any>): string | null {
  switch (m.subtype) {
    case "task_started":
      return m.description ? `workflow started: ${String(m.description).slice(0, 100)}` : "workflow started";
    case "task_progress":
      return m.description ? `workflow · ${String(m.description).slice(0, 100)}` : null;
    case "task_updated": {
      const status = m.patch?.status;
      return status ? `workflow ${String(status)}` : null;
    }
    case "background_tasks_changed": {
      const n = Array.isArray(m.tasks) ? m.tasks.length : 0;
      return n > 0 ? `workflow running (${n} background task${n === 1 ? "" : "s"})` : null;
    }
    default:
      return null;
  }
}

export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly id = "claude-code";
  /**
   * Injectable query (tests pass a fake); defaults to the real SDK `query`.
   * `turnInactivityMs` overrides the per-turn inactivity watchdog (tests only — lets
   * the timeout→interrupt→drain path be exercised without a 10-minute wait).
   */
  constructor(
    private queryFn: QueryFn = query as unknown as QueryFn,
    private turnInactivityMs: number = TURN_INACTIVITY_MS,
    /**
     * Harness credentials from the composition root (core/config loadAuthConfig).
     * UNDEFINED when the adapter is constructed bare — every test and every
     * scripts/smoke-* harness — in which case the agent inherits the ambient
     * environment exactly as it did before this parameter existed. Only the daemon
     * passes a resolved config, and only then does the credential become
     * authoritative. See scrubDaemonEnv.
     */
    private auth?: HarnessAuth,
  ) {}
  readonly capabilities: HarnessCapabilities = {
    mechanicalGating: true, // defer-based gating (verified), wired live
    resumeAfterRestart: true,
    // Under api_key auth total_cost_usd is real spend against the Console account;
    // under subscription auth it is notional API pricing (nothing is billed per
    // token) and serves only as a usage-governance signal. Budgets work the same
    // either way — only the meaning of the number changes.
    costReporting: true,
    imageInput: true, // the runtime accepts images; the TurnInput image path arrives with attachments
    // The tokens the core validates an architect's model/effort against.
    supportedModels: SUPPORTED_MODELS, // ["opus","sonnet","fable"]
    supportedEfforts: SUPPORTED_EFFORTS, // ["low","medium","high","xhigh","max"]
  };

  async create(opts: { cwd: string; system: string; root?: string }): Promise<HarnessSession> {
    return new ClaudeCodeSession(
      { v: 1, sessionId: null },
      opts.cwd,
      opts.system,
      this.queryFn,
      this.turnInactivityMs,
      opts.root,
      this.auth,
    );
  }

  async resume(handle: SessionHandle, cwd: string, system: string, root?: string): Promise<HarnessSession> {
    return new ClaudeCodeSession(
      asHandle(handle),
      cwd,
      system,
      this.queryFn,
      this.turnInactivityMs,
      root,
      this.auth,
    );
  }
}

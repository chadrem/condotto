import { query } from "@anthropic-ai/claude-agent-sdk";
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

// Claude Code harness adapter over the Agent SDK.
//
// Verified facts this code builds on (M0 spike 2026-07-16 + live docs, see
// DECISIONS.md and DESIGN.md Appendix B):
//  - Auth is the machine's Claude subscription login (keychain OAuth). There is
//    no ANTHROPIC_API_KEY in this deployment and this file must never read one.
//  - `resume: <sessionId>` + same cwd resumes a session across processes;
//    session storage is keyed by encoded cwd, so cwd must be stable.
//  - Without the claude_code systemPrompt preset the model has no environment
//    context (it invents paths) — always use the preset + append.
//  - `session_id` arrives on the `system`/`init` message.
//
// M2 scope: the core GateFn now answers allow/deny/gate for every tool call.
//  - allow  -> PreToolUse `allow` (reads stay auto-approved; the hook still
//              confines them, which beats allowedTools per the SDK precedence).
//  - deny   -> PreToolUse `deny` with a reason fed back to the agent.
//  - gate   -> PreToolUse `defer`: the turn ends un-executed with the pending
//              call preserved (M0-verified); the core records an approval, and a
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
 * from M1 may still contain a `system` field; asHandle ignores it.)
 */
interface ClaudeCodeHandle {
  v: 1;
  sessionId: string | null;
}

// `allowedTools` auto-approves reads (the hook still denies out-of-worktree
// reads — a hook `deny` beats an allow rule). Write/Edit/Bash are deliberately
// NEITHER allowed (they must gate) NOR disallowed (they must be reachable so the
// agent can propose them).
const ALLOWED_TOOLS = ["Read", "Glob", "Grep", "TodoWrite"];
// Always removed from context, regardless of capability flags: plan-mode meta,
// slash commands, and network reads are out of scope for the implementer.
//
// `Workflow` is ALSO always disallowed (M3.5). A spike (2026-07-18, spikes/m3.5/
// workflow-path.ts) showed the Workflow tool's orchestrated agents BYPASS our
// PreToolUse gate — their tool calls carry no `agent_id`, so the read-only
// subagent policy never sees them; they fall through to the `canUseTool`
// blanket-deny backstop, which denies everything (even reads). So workflows are
// both non-functional under our isolation AND not gated in principle. Re-enable
// only once workflow agents can be routed through the gate (M4+). Subagents (the
// `Agent` tool) are the working, gated read-only fan-out.
const BASE_DISALLOWED = ["ExitPlanMode", "SlashCommand", "WebFetch", "WebSearch", "Workflow"];
// Subagent tools, disabled BY DEFAULT (M3.5 Tier B is architect opt-in). Both the
// current `Agent` name and the legacy `Task` alias are listed so "subagents off"
// is genuinely off regardless of which the runtime exposes. Un-disallowed per-turn
// only when the session enables the capability; even then every tool call a
// subagent makes still hits the PreToolUse gate (agent_id-tagged).
const SUBAGENT_TOOLS = ["Agent", "Task"];

// M3.5 Tier A. The core passes an opaque model token; the adapter is the only
// place that knows SDK model IDs (keeps the port clean). Unrecognized tokens
// pass through (the SDK also accepts bare aliases / full IDs), but the core has
// already validated against `supportedModels`, so that path is belt-and-braces.
const MODEL_IDS: Record<string, string> = {
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-5",
  fable: "claude-fable-5",
};
const SUPPORTED_MODELS = Object.keys(MODEL_IDS);
// Independent of extended thinking. xhigh needs Fable 5 / Opus 4.7+ / Sonnet 5
// (our Opus default qualifies); the SDK silently falls back to `high` elsewhere.
const SUPPORTED_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/**
 * Daemon-side subagent definitions (M3.5 Tier B). When the architect enables
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
      "You are a read-only exploration subagent for Conduit. Use Read/Glob/Grep to investigate " +
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
 * Build the per-turn tool posture from the session's harness capabilities. Reads
 * stay auto-allowed; write/bash stay gated (absent from both lists). Subagent /
 * workflow tools are removed from context unless the architect opted in.
 */
function toolPosture(h: HarnessTurnOptions | undefined): {
  allowedTools: string[];
  disallowedTools: string[];
} {
  const disallowed = [...BASE_DISALLOWED];
  if (!h?.subagents) disallowed.push(...SUBAGENT_TOOLS);
  // Note: the Workflow tool stays in BASE_DISALLOWED unconditionally — see there.
  return { allowedTools: ALLOWED_TOOLS, disallowedTools: disallowed };
}

/** Deny message for a gated call that arrived batched (defer unavailable). */
const BATCH_GATE_DENY =
  "This action needs an architect's approval, but it came in a parallel batch of tool calls, " +
  "which can't be paused for approval. Re-issue it on its own and I'll request approval.";

/**
 * The SDK warns — with a full stack trace, on EVERY query() — that read-only
 * tools are "shadowed" from canUseTool by allowedTools
 * (CLAUDE_SDK_CAN_USE_TOOL_SHADOWED). For Conduit that is expected and correct:
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

function asHandle(handle: SessionHandle): ClaudeCodeHandle {
  const h = handle as Partial<ClaudeCodeHandle> | null;
  if (!h || h.v !== 1 || (h.sessionId !== null && h.sessionId !== undefined && typeof h.sessionId !== "string")) {
    throw new Error("claude-code: unrecognized session handle");
  }
  return { v: 1, sessionId: h.sessionId ?? null };
}

class ClaudeCodeSession implements HarnessSession {
  constructor(
    private _handle: ClaudeCodeHandle,
    private cwd: string,
    /** Conduit protocol prompt (preset append). Supplied fresh each turn. */
    private system: string,
  ) {}

  get handle(): SessionHandle {
    return this._handle;
  }

  async *turn(input: TurnInput, gate: GateFn): AsyncIterable<TurnEvent> {
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
          // M3.5 Tier B: present ONLY inside a subagent. The core policy treats
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
                permissionDecisionReason: "Gated by Conduit — awaiting an architect's approval.",
              };
      return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, ...out } };
    };

    // M3.5: per-turn harness capabilities (opaque config from the core). model/
    // effort tune the implementer; subagents/workflows toggle multi-agent tools;
    // projectConfig loads a trusted repo's settings (Tier C).
    const h = input.harness;
    const { allowedTools, disallowedTools } = toolPosture(h);
    const model = resolveModel(h?.model);
    const effort = resolveEffort(h?.effort);
    // Tier C: a trusted repo loads its own project settings + skills; the §4 gate
    // still applies (the PreToolUse hook fires regardless of settingSources, and a
    // hook deny/defer beats any repo allow-rule per SDK precedence). Untrusted
    // (default) stays isolated: no repo CLAUDE.md/.mcp.json/.claude/, no skills.
    const settingSources: ("user" | "project" | "local")[] = h?.projectConfig ? ["project"] : [];

    const q = query({
      prompt: input.text,
      options: {
        cwd: this.cwd,
        resume: this._handle.sessionId ?? undefined,
        systemPrompt: { type: "preset", preset: "claude_code", append: this.system },
        allowedTools,
        disallowedTools,
        permissionMode: "default",
        // M3.5 Tier A: exact SDK model id + reasoning effort. Omitted = SDK
        // defaults; the core always supplies them (default Opus + high).
        ...(model ? { model } : {}),
        ...(effort ? { effort: effort as "low" | "medium" | "high" | "xhigh" | "max" } : {}),
        // Intra-turn runaway brake (M3, DESIGN §4). The SDK stops the turn if it
        // exceeds this, returning an `error_max_budget_usd` result we surface as
        // a clear Slack notice (never a silent stall). The core passes the
        // session's remaining thread headroom; omitted = no per-turn cap.
        ...(typeof input.budgetUsd === "number" && input.budgetUsd > 0
          ? { maxBudgetUsd: input.budgetUsd }
          : {}),
        // Tier B: when subagents are enabled, offer the read-only `explorer`
        // subagent (restricted toolset — defense-in-depth over the gate).
        ...(h?.subagents ? { agents: SUBAGENT_DEFS } : {}),
        // Tier C: load the trusted repo's skills alongside its project settings.
        ...(h?.projectConfig ? { skills: "all" as const } : {}),
        // Untrusted (default): never load filesystem settings (CLAUDE.md,
        // .mcp.json, .claude/) from the worktree — repo content is untrusted
        // input and must not register MCP servers or alter permissions (§4).
        settingSources,
        hooks: { PreToolUse: [{ hooks: [gateHook] }] },
        // Deny-by-default backstop. In the normal single-call flow the hook is
        // terminal and this is never reached; it only fires when a gated call's
        // `defer` was ignored because it was batched (see BATCH_GATE_DENY). The
        // hook already audited the call as gated, so no allow ever needs to
        // originate here — a blanket deny is correct and cannot starve reads
        // (those are resolved by allowedTools before reaching canUseTool).
        canUseTool: async () => ({ behavior: "deny" as const, message: BATCH_GATE_DENY }),
      },
    });

    let sawResult = false;
    try {
      const iterator = q[Symbol.asyncIterator]();
      while (true) {
        // Inactivity watchdog: a wedged SDK query must not hang the session's
        // turn queue forever.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<"timeout">((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout("timeout"), TURN_INACTIVITY_MS);
        });
        const step = await Promise.race([iterator.next(), timeout]).finally(() =>
          clearTimeout(timer),
        );
        if (step === "timeout") {
          await q.interrupt().catch(() => {});
          yield { kind: "error", message: "session turn timed out (no activity for 10 minutes)" };
          return;
        }
        if (step.done) break;

        const m = step.value as Record<string, any>;
        if (m.type === "system" && m.subtype === "init") {
          if (m.session_id && m.session_id !== this._handle.sessionId) {
            this._handle = { ...this._handle, sessionId: m.session_id };
            yield { kind: "handle_updated", handle: this._handle };
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
          const deferred = m.deferred_tool_use as
            | { id?: string; name?: string; input?: unknown }
            | undefined;
          if (m.terminal_reason === "tool_deferred" || deferred) {
            // A gated tool call was deferred (M0-verified handshake). Hand the
            // preserved pending call to the core to record an approval; the turn
            // is over until an architect decides and the session is resumed.
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
            yield {
              kind: "reply",
              text: typeof m.result === "string" && m.result.length > 0 ? m.result : "(no reply)",
              costUsd: cost,
            };
          } else if (m.subtype === "error_max_budget_usd" || m.terminal_reason === "budget_exhausted") {
            // The turn hit its cost budget and stopped (M3). Surface it clearly
            // with the spend — the core will then pause the session (§4).
            yield {
              kind: "error",
              message:
                `I hit this turn's cost budget${cost !== undefined ? ` ($${cost.toFixed(2)})` : ""} and ` +
                `stopped before finishing. An architect can raise the budget to let me continue.`,
              costUsd: cost,
            };
          } else {
            yield { kind: "error", message: `session turn ended abnormally (${m.subtype})`, costUsd: cost };
          }
        }
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
    }
    if (!sawResult) {
      yield { kind: "error", message: "session turn produced no result" };
    }
  }

  async interrupt(): Promise<void> {
    // M1: turns are awaited to completion; interrupt support lands with M2/M3.
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
    default:
      return `using ${name}`;
  }
}

export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly id = "claude-code";
  readonly capabilities: HarnessCapabilities = {
    mechanicalGating: true, // defer-based gating (M0-verified), wired live in M2
    resumeAfterRestart: true,
    costReporting: true, // notional API pricing on subscription auth — usage governance only
    imageInput: true, // the runtime accepts images; the TurnInput image path arrives with M3 attachments
    // M3.5: the tokens the core validates an architect's model/effort against.
    supportedModels: SUPPORTED_MODELS, // ["opus","sonnet","fable"]
    supportedEfforts: SUPPORTED_EFFORTS, // ["low","medium","high","xhigh","max"]
  };

  async create(opts: { cwd: string; system: string }): Promise<HarnessSession> {
    return new ClaudeCodeSession({ v: 1, sessionId: null }, opts.cwd, opts.system);
  }

  async resume(handle: SessionHandle, cwd: string, system: string): Promise<HarnessSession> {
    return new ClaudeCodeSession(asHandle(handle), cwd, system);
  }
}

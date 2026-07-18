import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  GateFn,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessSession,
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
// M1 scope: create/resume/converse with read-only tools. No `defer` gating yet
// (M2); the PreToolUse hook routes every call through the core's GateFn with
// instant allow/deny so the port's contract is real from day one.

/** Opaque to the core. Owned entirely by this adapter. */
interface ClaudeCodeHandle {
  v: 1;
  sessionId: string | null;
  /** The Conduit system-prompt append, replayed on every query() incl. resume. */
  system: string;
}

// Read-only surface for M1. `allowedTools` auto-approves these. The denylist
// removes the known dangerous built-ins from context by bare name, but it is
// NOT assumed exhaustive (the SDK grows tools) — the core's GateFn sees every
// tool call via the PreToolUse hook below and denies anything outside the
// read-only set, so an unlisted tool is still blocked, just later.
const ALLOWED_TOOLS = ["Read", "Glob", "Grep", "TodoWrite"];
const DISALLOWED_TOOLS = [
  "Write",
  "Edit",
  "NotebookEdit",
  "Bash",
  "BashOutput",
  "KillShell",
  "WebFetch",
  "WebSearch",
  "Task",
  "ExitPlanMode",
  "SlashCommand",
];

/** Abort a turn if the SDK produces nothing at all for this long. */
const TURN_INACTIVITY_MS = 10 * 60_000;

function asHandle(handle: SessionHandle): ClaudeCodeHandle {
  const h = handle as Partial<ClaudeCodeHandle> | null;
  if (
    !h ||
    h.v !== 1 ||
    typeof h.system !== "string" ||
    (h.sessionId !== null && typeof h.sessionId !== "string")
  ) {
    throw new Error("claude-code: unrecognized session handle");
  }
  return h as ClaudeCodeHandle;
}

class ClaudeCodeSession implements HarnessSession {
  constructor(
    private _handle: ClaudeCodeHandle,
    private cwd: string,
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
      const call = hookInput as { tool_name?: string; tool_input?: unknown };
      let decision: Awaited<ReturnType<GateFn>>;
      try {
        decision = await gate({
          id: toolUseID ?? "",
          name: call.tool_name ?? "unknown",
          input: call.tool_input,
        });
      } catch (err) {
        decision = { decision: "deny", reason: `gate error (denied fail-closed): ${err}` };
      }
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: decision.decision,
          permissionDecisionReason: decision.decision === "deny" ? decision.reason : undefined,
          updatedInput:
            decision.decision === "allow" && decision.updatedInput !== undefined
              ? (decision.updatedInput as Record<string, unknown>)
              : undefined,
        },
      };
    };

    const q = query({
      prompt: input.text,
      options: {
        cwd: this.cwd,
        resume: this._handle.sessionId ?? undefined,
        systemPrompt: { type: "preset", preset: "claude_code", append: this._handle.system },
        allowedTools: ALLOWED_TOOLS,
        disallowedTools: DISALLOWED_TOOLS,
        permissionMode: "default",
        // Never load filesystem settings (CLAUDE.md, .mcp.json, .claude/) from
        // the worktree: repo content is untrusted input and must not be able to
        // register MCP servers or alter permissions (DESIGN.md §4).
        settingSources: [],
        hooks: { PreToolUse: [{ hooks: [gateHook] }] },
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
          if (m.subtype === "success") {
            yield {
              kind: "reply",
              text: typeof m.result === "string" && m.result.length > 0 ? m.result : "(no reply)",
              costUsd: typeof m.total_cost_usd === "number" ? m.total_cost_usd : undefined,
            };
          } else {
            yield { kind: "error", message: `session turn ended abnormally (${m.subtype})` };
          }
        }
      }
    } catch (err) {
      // A persisted session id the runtime no longer knows (pruned storage,
      // moved machine) would otherwise wedge the thread forever. Recover by
      // starting fresh once: context is lost but the conversation continues.
      const message = err instanceof Error ? err.message : String(err);
      if (allowFreshRetry && this._handle.sessionId && /No conversation found/i.test(message)) {
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
    default:
      return `using ${name}`;
  }
}

export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly id = "claude-code";
  readonly capabilities: HarnessCapabilities = {
    mechanicalGating: true, // verified by the M0 spike (defer); M1 uses instant decisions
    resumeAfterRestart: true,
    costReporting: true, // notional API pricing on subscription auth — usage governance only
    imageInput: true, // the runtime accepts images; the TurnInput image path arrives with M3 attachments
  };

  async create(opts: { cwd: string; system: string }): Promise<HarnessSession> {
    const handle: ClaudeCodeHandle = { v: 1, sessionId: null, system: opts.system };
    return new ClaudeCodeSession(handle, opts.cwd);
  }

  async resume(handle: SessionHandle, cwd: string): Promise<HarnessSession> {
    return new ClaudeCodeSession(asHandle(handle), cwd);
  }
}

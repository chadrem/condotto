import { describe, expect, test } from "bun:test";
import { ClaudeCodeAdapter, scrubDaemonEnv, type QueryFn } from "../src/adapters/claude-code/adapter";
import type { GateFn, TurnEvent } from "../src/core/types";

// Drive the REAL claude-code adapter loop with a scripted SDK message stream (via
// the injectable query seam), so the result-buffering and canUseTool wiring —
// which the FakeHarness bypasses entirely — are covered by `bun test`.

/** Build a fake query whose generator body receives the adapter's `options`. */
function fakeQuery(body: (opts: Record<string, any>) => AsyncGenerator<Record<string, any>>): QueryFn {
  return ((args: { prompt: unknown; options: Record<string, any> }) => {
    const gen = body(args.options);
    return Object.assign(gen, { interrupt: async () => {} });
  }) as unknown as QueryFn;
}

async function collect(adapter: ClaudeCodeAdapter, gate: GateFn, harness?: any): Promise<TurnEvent[]> {
  const session = await adapter.create({ cwd: "/wt/session-abc", system: "sys" });
  const events: TurnEvent[] = [];
  for await (const ev of session.turn({ text: "hi", harness }, gate)) events.push(ev);
  return events;
}

const allowGate: GateFn = async () => ({ decision: "allow" });

describe("claude-code adapter: multi-result buffering", () => {
  test("delivers the LAST success result of a workflow turn (final synthesis, not 'launched')", async () => {
    const q = fakeQuery(async function* () {
      yield { type: "system", subtype: "init", session_id: "s1" };
      yield { type: "result", subtype: "success", result: "Workflow launched; waiting…", total_cost_usd: 0.01 };
      yield { type: "system", subtype: "task_progress", description: "Read: readme" };
      yield { type: "result", subtype: "success", result: "FINAL synthesis", total_cost_usd: 0.05 };
    });
    const events = await collect(new ClaudeCodeAdapter(q), allowGate);
    const replies = events.filter((e): e is Extract<TurnEvent, { kind: "reply" }> => e.kind === "reply");
    expect(replies.length).toBe(1); // exactly one reply, not one-per-result
    expect(replies[0]!.text).toBe("FINAL synthesis");
    expect(replies[0]!.costUsd).toBe(0.05); // final cumulative cost, no double-count
    expect(replies[0]!.workflow).toBe(true); // a task_* message was seen this turn
    // The live status was streamed as progress.
    expect(events.some((e) => e.kind === "progress" && /workflow · Read: readme/.test((e as any).text))).toBe(true);
  });

  test("a normal single-result turn still delivers its reply, untagged as workflow", async () => {
    const q = fakeQuery(async function* () {
      yield { type: "system", subtype: "init", session_id: "s2" };
      yield { type: "result", subtype: "success", result: "hello", total_cost_usd: 0.02 };
    });
    const events = await collect(new ClaudeCodeAdapter(q), allowGate);
    const replies = events.filter((e) => e.kind === "reply");
    expect(replies.length).toBe(1);
    expect((replies[0] as any).text).toBe("hello");
    expect((replies[0] as any).workflow).toBeFalsy();
  });

  test("a defer after a 'launched' success delivers ONLY the deferred (stale reply dropped)", async () => {
    const q = fakeQuery(async function* () {
      yield { type: "result", subtype: "success", result: "launched; waiting…", total_cost_usd: 0.01 };
      yield { type: "result", terminal_reason: "tool_deferred", deferred_tool_use: { id: "t9", name: "Write", input: { file_path: "x" } }, total_cost_usd: 0.03 };
    });
    const events = await collect(new ClaudeCodeAdapter(q), allowGate);
    expect(events.filter((e) => e.kind === "reply").length).toBe(0);
    const deferred = events.filter((e) => e.kind === "deferred");
    expect(deferred.length).toBe(1);
    expect((deferred[0] as any).call.name).toBe("Write");
    expect((deferred[0] as any).costUsd).toBe(0.03);
  });

  test("an error after a 'launched' success delivers ONLY the error", async () => {
    const q = fakeQuery(async function* () {
      yield { type: "result", subtype: "success", result: "launched…", total_cost_usd: 0.01 };
      yield { type: "result", subtype: "error_max_budget_usd", total_cost_usd: 0.9 };
    });
    const events = await collect(new ClaudeCodeAdapter(q), allowGate);
    expect(events.filter((e) => e.kind === "reply").length).toBe(0);
    const errs = events.filter((e) => e.kind === "error");
    expect(errs.length).toBe(1);
    expect((errs[0] as any).costUsd).toBe(0.9); // spend still recorded (runaway cap, §4)
  });
});

describe("claude-code adapter: gate wiring", () => {
  test("the PreToolUse hook forwards agent_id and maps allow/deny/gate→defer", async () => {
    const seen: { name: string; agentId?: string; escaped?: boolean }[] = [];
    const gate: GateFn = async (call) => {
      seen.push({ name: call.name, agentId: call.agentId, escaped: call.escaped });
      if (call.name === "Read") return { decision: "allow" };
      if (call.name === "Write") return { decision: "gate" };
      return { decision: "deny", reason: "nope" };
    };
    let readOut: any, writeOut: any, bashOut: any;
    const q = fakeQuery(async function* (opts) {
      const hook = opts.hooks.PreToolUse[0].hooks[0];
      readOut = await hook({ tool_name: "Read", tool_input: { file_path: "a" }, agent_id: "sub-1" }, "t1");
      writeOut = await hook({ tool_name: "Write", tool_input: { file_path: "b" } }, "t2");
      bashOut = await hook({ tool_name: "Bash", tool_input: { command: "x" } }, "t3");
      yield { type: "result", subtype: "success", result: "ok", total_cost_usd: 0 };
    });
    await collect(new ClaudeCodeAdapter(q), gate);
    expect(readOut.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(writeOut.hookSpecificOutput.permissionDecision).toBe("defer"); // gate → defer
    expect(bashOut.hookSpecificOutput.permissionDecision).toBe("deny");
    // agent_id plumbs into ToolCall.agentId; hook calls are NOT tagged escaped.
    expect(seen.find((c) => c.name === "Read")!.agentId).toBe("sub-1");
    expect(seen.every((c) => !c.escaped)).toBe(true);
  });

  test("canUseTool routes escaped calls through the gate (read allow, write deny) and maps behavior", async () => {
    const seen: { name: string; escaped?: boolean; id: string }[] = [];
    const gate: GateFn = async (call) => {
      seen.push({ name: call.name, escaped: call.escaped, id: call.id });
      return call.name === "Read" ? { decision: "allow" } : { decision: "deny", reason: "confined" };
    };
    let readRes: any, writeRes: any;
    const q = fakeQuery(async function* (opts) {
      readRes = await opts.canUseTool("Read", { file_path: "a" }, {});
      writeRes = await opts.canUseTool("Write", { file_path: "b" }, {});
      yield { type: "result", subtype: "success", result: "ok", total_cost_usd: 0 };
    });
    await collect(new ClaudeCodeAdapter(q), gate);
    expect(readRes.behavior).toBe("allow");
    expect(readRes.updatedInput).toEqual({ file_path: "a" });
    expect(writeRes.behavior).toBe("deny");
    expect(writeRes.message).toBe("confined");
    // Every canUseTool call is tagged escaped (un-deferrable path) with an empty id.
    expect(seen.every((c) => c.escaped === true && c.id === "")).toBe(true);
    expect(seen.map((c) => c.name)).toEqual(["Read", "Write"]);
  });

  test("a gate that throws fails CLOSED (deny) in both the hook and canUseTool", async () => {
    const throwing: GateFn = async () => {
      throw new Error("boom");
    };
    let hookOut: any, canRes: any;
    const q = fakeQuery(async function* (opts) {
      hookOut = await opts.hooks.PreToolUse[0].hooks[0]({ tool_name: "Write", tool_input: {} }, "t1");
      canRes = await opts.canUseTool("Write", {}, {});
      yield { type: "result", subtype: "success", result: "ok", total_cost_usd: 0 };
    });
    await collect(new ClaudeCodeAdapter(q), throwing);
    expect(hookOut.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(canRes.behavior).toBe("deny");
  });
});

describe("env-scrub the agent shell (rider a)", () => {
  test("scrubDaemonEnv drops SLACK_*/CONDOTTO_* but keeps PATH/HOME/toolchain/Claude auth", () => {
    const base: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/Users/x",
      SLACK_BOT_TOKEN: "xoxb-secret",
      SLACK_APP_TOKEN: "xapp-secret",
      CONDOTTO_CONFIG: "/etc/condotto.toml",
      CONDOTTO_CLAUDE_CLI: "/opt/claude",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-keep",
      ANTHROPIC_API_KEY: "sk-keep",
      MY_TOOLCHAIN: "keep",
      UNSET: undefined,
    };
    const out = scrubDaemonEnv(base);
    expect(out.SLACK_BOT_TOKEN).toBeUndefined();
    expect(out.SLACK_APP_TOKEN).toBeUndefined();
    expect(out.CONDOTTO_CONFIG).toBeUndefined();
    expect(out.CONDOTTO_CLAUDE_CLI).toBeUndefined();
    expect(out.PATH).toBe("/usr/bin");
    expect(out.HOME).toBe("/Users/x");
    // The Claude subscription token never matches the prefixes — the SDK needs it
    // (keychain OAuth AND a headless CLAUDE_CODE_OAUTH_TOKEN both survive; spike a).
    expect(out.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-keep");
    expect(out.MY_TOOLCHAIN).toBe("keep");
    expect("UNSET" in out).toBe(false); // undefined values are dropped
  });

  // The api_key auth path (2026-07-20). ANTHROPIC_API_KEY is no longer inherited
  // from the daemon's own environment — it is installed from the RESOLVED auth
  // config or not at all, so subscription mode can't silently bill a stray key
  // left in a shell profile.
  test("scrubDaemonEnv installs the API key under api_key auth", () => {
    const out = scrubDaemonEnv({ PATH: "/usr/bin" }, { mode: "api_key", apiKey: "sk-ant-resolved" });
    expect(out.ANTHROPIC_API_KEY).toBe("sk-ant-resolved");
    expect(out.PATH).toBe("/usr/bin");
  });

  test("scrubDaemonEnv drops an inherited ANTHROPIC_API_KEY under subscription auth", () => {
    const out = scrubDaemonEnv({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-stray" }, { mode: "subscription" });
    expect("ANTHROPIC_API_KEY" in out).toBe(false);
  });

  // A bare adapter (every test above, and all eleven scripts/smoke-*.ts) passes no
  // auth at all. That MUST mean "inherit the ambient environment", not "subscription"
  // — otherwise a smoke run under api_key auth would have its key stripped and fail
  // to authenticate. Caught in review of the api_key change itself.
  test("scrubDaemonEnv inherits an ambient key when no auth config is supplied", () => {
    const out = scrubDaemonEnv({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ambient" });
    expect(out.ANTHROPIC_API_KEY).toBe("sk-ambient");
  });

  test("a bare ClaudeCodeAdapter does not strip the ambient key from a turn's env", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-smoke";
    try {
      let captured: any;
      const q = fakeQuery(async function* (opts) {
        captured = opts;
        yield { type: "result", subtype: "success", result: "ok", total_cost_usd: 0 };
      });
      await collect(new ClaudeCodeAdapter(q), allowGate);
      expect(captured.env.ANTHROPIC_API_KEY).toBe("sk-smoke");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  test("scrubDaemonEnv prefers the resolved key over an inherited one", () => {
    const out = scrubDaemonEnv({ ANTHROPIC_API_KEY: "sk-stray" }, { mode: "api_key", apiKey: "sk-ant-resolved" });
    expect(out.ANTHROPIC_API_KEY).toBe("sk-ant-resolved");
  });

  test("a turn passes the scrubbed env to the SDK query options", async () => {
    process.env.SLACK_TEST_SECRET = "xoxb-leak";
    process.env.CONDOTTO_TEST_SECRET = "leak";
    let captured: any;
    const q = fakeQuery(async function* (opts) {
      captured = opts;
      yield { type: "result", subtype: "success", result: "ok", total_cost_usd: 0 };
    });
    await collect(new ClaudeCodeAdapter(q), allowGate);
    expect(captured.env).toBeDefined();
    expect(captured.env.SLACK_TEST_SECRET).toBeUndefined();
    expect(captured.env.CONDOTTO_TEST_SECRET).toBeUndefined();
    expect(captured.env.PATH).toBe(process.env.PATH); // toolchain preserved
    delete process.env.SLACK_TEST_SECRET;
    delete process.env.CONDOTTO_TEST_SECRET;
  });
});

describe("claude-code adapter: background cost/cancel (rider b)", () => {
  /** A fake query whose interrupt() runs `onInterrupt` (e.g. to increment a counter). */
  function fakeQueryI(
    body: (opts: Record<string, any>) => AsyncGenerator<Record<string, any>>,
    onInterrupt: () => void,
  ): QueryFn {
    return ((args: { prompt: unknown; options: Record<string, any> }) => {
      const gen = body(args.options);
      return Object.assign(gen, { interrupt: async () => onInterrupt() });
    }) as unknown as QueryFn;
  }

  test("a budget breach DURING a workflow interrupts the detached task and drains cost once", async () => {
    let interrupts = 0;
    const q = fakeQueryI(async function* () {
      yield { type: "system", subtype: "init", session_id: "s1" };
      yield { type: "system", subtype: "task_started", task_id: "w1", workflow_name: "audit" };
      yield { type: "system", subtype: "task_progress", description: "agent a", usage: { total_tokens: 100 } };
      // The SDK budget brake fires, but the detached task keeps spending (spike b)…
      yield { type: "result", subtype: "error_max_budget_usd", terminal_reason: "budget_exhausted", total_cost_usd: 0.6 };
      // …until our interrupt() halts it; the SDK then settles with an aborted result.
      yield { type: "result", subtype: "error_during_execution", terminal_reason: "aborted_streaming", total_cost_usd: 0.63 };
    }, () => { interrupts++; });
    const events = await collect(new ClaudeCodeAdapter(q), allowGate, { workflows: true });
    expect(interrupts).toBeGreaterThanOrEqual(1); // the detached workflow was interrupted
    expect(events.filter((e) => e.kind === "reply").length).toBe(0);
    const errs = events.filter((e): e is Extract<TurnEvent, { kind: "error" }> => e.kind === "error");
    expect(errs.length).toBe(1); // one notice, not one-per-budget-result
    expect(errs[0]!.message).toMatch(/budget/i);
    expect(errs[0]!.message).toMatch(/workflow/i);
    expect(errs[0]!.costUsd).toBe(0.63); // drained the final post-interrupt cost (ledger stays accurate)
  });

  test("an out-of-band interrupt() mid-workflow cancels the detached task, drains cost, and tolerates the post-abort throw", async () => {
    let interrupts = 0;
    let releaseHold: () => void = () => {};
    const held = new Promise<void>((r) => { releaseHold = r; });
    const q = fakeQueryI(async function* () {
      yield { type: "system", subtype: "init", session_id: "s1" };
      yield { type: "system", subtype: "task_started", task_id: "w1", workflow_name: "audit" };
      yield { type: "system", subtype: "task_progress", description: "agent a", usage: { total_tokens: 100 } };
      await held; // block until interrupt() releases (models a long-running workflow)
      yield { type: "result", subtype: "error_during_execution", terminal_reason: "aborted_streaming", total_cost_usd: 0.42 };
      throw new Error("[ede_diagnostic] result_type=user stop_reason=tool_use"); // SDK post-abort throw (spike b)
    }, () => { interrupts++; releaseHold(); });

    const session = await new ClaudeCodeAdapter(q).create({ cwd: "/wt/x", system: "s" });
    const events: TurnEvent[] = [];
    let fired = false;
    for await (const ev of session.turn({ text: "run wf", harness: { workflows: true } }, allowGate)) {
      events.push(ev);
      if (!fired && ev.kind === "progress" && /workflow/.test((ev as any).text)) {
        fired = true;
        await session.interrupt(); // architect `@Condotto cancel` mid-workflow
      }
    }
    expect(interrupts).toBe(1);
    expect(events.filter((e) => e.kind === "reply").length).toBe(0);
    const errs = events.filter((e): e is Extract<TurnEvent, { kind: "error" }> => e.kind === "error");
    expect(errs.length).toBe(1);
    expect(errs[0]!.message).toMatch(/Cancelled/);
    expect(errs[0]!.message).toMatch(/workflow/);
    expect(errs[0]!.costUsd).toBe(0.42); // aborted result's cost still drained
  });

  test("a wedged turn (no result) times out, interrupts, and emits exactly ONE notice", async () => {
    let interrupts = 0;
    let releaseHang: () => void = () => {};
    const hang = new Promise<void>((r) => { releaseHang = r; });
    const q = fakeQueryI(async function* () {
      yield { type: "system", subtype: "init", session_id: "s1" };
      await hang; // no result ever — the inactivity watchdog must fire
    }, () => { interrupts++; releaseHang(); });
    // 40ms inactivity so the timeout→interrupt→drain path runs without a 10-min wait.
    const session = await new ClaudeCodeAdapter(q, 40).create({ cwd: "/wt/x", system: "s" });
    const events: TurnEvent[] = [];
    for await (const ev of session.turn({ text: "hi" }, allowGate)) events.push(ev);
    expect(interrupts).toBeGreaterThanOrEqual(1);
    const errs = events.filter((e) => e.kind === "error");
    expect(errs.length).toBe(1); // the timeout notice ONLY — not a duplicate "produced no result"
    expect((errs[0] as any).message).toMatch(/stopped the running turn/);
  });

  test("a timeout that yields a drainable aborted result drains its cost into the notice", async () => {
    let releaseHang: () => void = () => {};
    const hang = new Promise<void>((r) => { releaseHang = r; });
    const q = fakeQueryI(async function* () {
      yield { type: "system", subtype: "init", session_id: "s1" };
      yield { type: "system", subtype: "task_progress", description: "agent a" };
      await hang; // wedge, then on interrupt settle with an aborted result carrying cost
      yield { type: "result", subtype: "error_during_execution", terminal_reason: "aborted_streaming", total_cost_usd: 0.71 };
    }, () => { releaseHang(); });
    const session = await new ClaudeCodeAdapter(q, 40).create({ cwd: "/wt/x", system: "s" });
    const events: TurnEvent[] = [];
    for await (const ev of session.turn({ text: "hi", harness: { workflows: true } }, allowGate)) events.push(ev);
    const errs = events.filter((e): e is Extract<TurnEvent, { kind: "error" }> => e.kind === "error");
    expect(errs.length).toBe(1);
    expect(errs[0]!.message).toMatch(/10 minutes|stopped the running workflow/);
    expect(errs[0]!.costUsd).toBe(0.71); // the wedged workflow's spend is drained into the ledger
  });

  test("a cancel that lands AFTER a success was buffered delivers the completed reply + cost (not dropped)", async () => {
    let interrupts = 0;
    let releaseHold: () => void = () => {};
    const held = new Promise<void>((r) => { releaseHold = r; });
    const q = fakeQueryI(async function* () {
      yield { type: "system", subtype: "init", session_id: "s1" };
      // The turn COMPLETES: this success is buffered (not yet yielded).
      yield { type: "result", subtype: "success", result: "the answer", total_cost_usd: 0.25 };
      // A yielded progress event AFTER the success is buffered, so the test can time a
      // cancel that lands once the turn has already finished its work.
      yield { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "x" } }] } };
      await held;
    }, () => { interrupts++; releaseHold(); });
    const session = await new ClaudeCodeAdapter(q).create({ cwd: "/wt/x", system: "s" });
    const events: TurnEvent[] = [];
    let fired = false;
    for await (const ev of session.turn({ text: "hi" }, allowGate)) {
      events.push(ev);
      if (!fired && ev.kind === "progress") { fired = true; await session.interrupt(); }
    }
    // The late cancel must NOT drop the completed reply or its cost.
    const replies = events.filter((e): e is Extract<TurnEvent, { kind: "reply" }> => e.kind === "reply");
    expect(replies.length).toBe(1);
    expect(replies[0]!.text).toBe("the answer");
    expect(replies[0]!.costUsd).toBe(0.25); // spend still recorded against the runaway cap
    expect(events.some((e) => e.kind === "error")).toBe(false); // not reported as a cancel
  });

  test("interrupt() on an idle session (no live query) is a clean no-op", async () => {
    const q = fakeQuery(async function* () {
      yield { type: "result", subtype: "success", result: "ok", total_cost_usd: 0 };
    });
    const session = await new ClaudeCodeAdapter(q).create({ cwd: "/wt/x", system: "s" });
    // No turn running yet — interrupt must not throw and must not taint the next turn.
    await session.interrupt();
    const events: TurnEvent[] = [];
    for await (const ev of session.turn({ text: "hi" }, allowGate)) events.push(ev);
    expect(events.some((e) => e.kind === "reply" && (e as any).text === "ok")).toBe(true);
    expect(events.some((e) => e.kind === "error")).toBe(false); // not reported as a cancel
  });
});

describe("claude-code adapter: tool posture", () => {
  test("workflows on ⇒ Workflow tool enabled, reads via hook (empty allowedTools), bypassPermissions", async () => {
    let captured: any;
    const q = fakeQuery(async function* (opts) {
      captured = opts;
      yield { type: "result", subtype: "success", result: "ok", total_cost_usd: 0 };
    });
    await collect(new ClaudeCodeAdapter(q), allowGate, { subagents: true, workflows: true });
    expect(captured.permissionMode).toBe("bypassPermissions");
    expect(captured.allowedTools).toEqual([]); // reads move onto the hook
    expect(captured.disallowedTools).not.toContain("Workflow"); // tool enabled
    expect(captured.disallowedTools).not.toContain("Agent");
  });

  test("workflows off ⇒ Workflow disallowed, reads auto-allowed, default permission mode", async () => {
    let captured: any;
    const q = fakeQuery(async function* (opts) {
      captured = opts;
      yield { type: "result", subtype: "success", result: "ok", total_cost_usd: 0 };
    });
    await collect(new ClaudeCodeAdapter(q), allowGate, { subagents: false, workflows: false });
    expect(captured.permissionMode).toBe("default");
    expect(captured.allowedTools).toContain("Read");
    expect(captured.disallowedTools).toContain("Workflow");
    expect(captured.disallowedTools).toContain("Agent");
  });
});

describe("claude-code adapter: model + effort resolution", () => {
  async function captureOpts(harness: Record<string, unknown>): Promise<any> {
    let captured: any;
    const q = fakeQuery(async function* (opts) {
      captured = opts;
      yield { type: "result", subtype: "success", result: "ok", total_cost_usd: 0 };
    });
    await collect(new ClaudeCodeAdapter(q), allowGate, harness);
    return captured;
  }

  test("the core's opaque tokens map to exact SDK model ids", async () => {
    // Pinned deliberately: the core only ever passes `opus`, so the SDK model
    // this resolves to is invisible from anywhere else. `opus` means Opus 5 —
    // which needs the sidecar shipped with agent-sdk >= 0.3.220 (CC 2.1.220 is
    // the release that added `claude-opus-5`); an older sidecar has no such id.
    expect((await captureOpts({ model: "opus" })).model).toBe("claude-opus-5");
    expect((await captureOpts({ model: "sonnet" })).model).toBe("claude-sonnet-5");
    expect((await captureOpts({ model: "fable" })).model).toBe("claude-fable-5");
  });

  test("effort passes through verbatim; an unsupported one falls back to the SDK default", async () => {
    // xhigh is the shipped default and Opus 5 supports it.
    expect((await captureOpts({ model: "opus", effort: "xhigh" })).effort).toBe("xhigh");
    expect((await captureOpts({ model: "opus", effort: "max" })).effort).toBe("max");
    expect((await captureOpts({ model: "opus", effort: "bogus" })).effort).toBeUndefined();
  });
});

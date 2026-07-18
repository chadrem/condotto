import { describe, expect, test } from "bun:test";
import { ClaudeCodeAdapter, type QueryFn } from "../src/adapters/claude-code/adapter";
import type { GateFn, TurnEvent } from "../src/core/types";

// Drive the REAL claude-code adapter loop with a scripted SDK message stream (via
// the injectable query seam), so the M3.6 result-buffering and canUseTool wiring —
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

describe("claude-code adapter: multi-result buffering (M3.6)", () => {
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

describe("claude-code adapter: gate wiring (M3.6)", () => {
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

describe("claude-code adapter: tool posture (M3.6)", () => {
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

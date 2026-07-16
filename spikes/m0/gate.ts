// M0 spike, phase 1: agent attempts a Write; PreToolUse hook returns "defer".
// Expect: query ends with terminal_reason "tool_deferred", deferred_tool_use
// carries the pending call, and hello.txt is NOT written.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "testrepo");
const STATE = join(import.meta.dir, "state.json");
const TARGET = join(REPO, "hello.txt");

let sessionId: string | undefined;

const gateHook = async (input: any, toolUseID: string | undefined) => {
  console.log(
    `[hook] PreToolUse fired: tool=${input.tool_name} tool_use_id=${toolUseID} input=${JSON.stringify(input.tool_input)}`
  );
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "defer",
      permissionDecisionReason: "Gated by Conduit: awaiting architect approval",
    },
  };
};

for await (const m of query({
  prompt:
    "Create a file named hello.txt whose entire content is exactly: hello from conduit\n" +
    "Use a single Write tool call. Do not read anything first, do not do anything else.",
  options: {
    cwd: REPO,
    hooks: { PreToolUse: [{ matcher: "Write", hooks: [gateHook] }] },
  },
})) {
  if (m.type === "system" && (m as any).subtype === "init") {
    sessionId = m.session_id;
    console.log("[gate] init: session_id =", sessionId);
  }
  if (m.type === "assistant") {
    const blocks = (m as any).message?.content ?? [];
    for (const b of blocks) {
      if (b.type === "tool_use") console.log(`[gate] model issued tool_use: id=${b.id} name=${b.name}`);
    }
  }
  if (m.type === "result") {
    const r = m as any;
    console.log(
      "[gate] result:",
      JSON.stringify(
        {
          subtype: r.subtype,
          stop_reason: r.stop_reason,
          terminal_reason: r.terminal_reason,
          deferred_tool_use: r.deferred_tool_use,
          num_turns: r.num_turns,
        },
        null,
        2
      )
    );
    writeFileSync(
      STATE,
      JSON.stringify({ sessionId, deferred: r.deferred_tool_use ?? null }, null, 2)
    );
  }
}

console.log("[gate] hello.txt exists after defer (MUST be false):", existsSync(TARGET));
process.exit(existsSync(TARGET) ? 1 : 0);

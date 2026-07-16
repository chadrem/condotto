// M0 spike, phase 2: run in a SEPARATE process after a delay (stands in for a
// Slack approval hours later + daemon restart). Resume the session by id; the
// deferred Write should be re-driven through PreToolUse, where we now "allow".
// Expect: hello.txt gets written with the exact content.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "testrepo");
const STATE = JSON.parse(readFileSync(join(import.meta.dir, "state.json"), "utf8"));
const TARGET = join(REPO, "hello.txt");

console.log("[resume] resuming session:", STATE.sessionId, "deferred:", JSON.stringify(STATE.deferred));

const approveHook = async (input: any, toolUseID: string | undefined) => {
  const matchesDeferred = toolUseID === STATE.deferred?.id;
  console.log(
    `[hook] PreToolUse on resume: tool=${input.tool_name} tool_use_id=${toolUseID} ` +
      `matches deferred id: ${matchesDeferred}`
  );
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "Architect approved (spike stand-in)",
    },
  };
};

for await (const m of query({
  prompt: "",
  options: {
    cwd: REPO,
    resume: STATE.sessionId,
    hooks: { PreToolUse: [{ matcher: "Write", hooks: [approveHook] }] },
  },
})) {
  if (m.type === "system" && (m as any).subtype === "init") {
    console.log(
      "[resume] init: session_id =", m.session_id,
      "| same session as gate phase:", m.session_id === STATE.sessionId
    );
  }
  if (m.type === "result") {
    const r = m as any;
    console.log(
      "[resume] result:",
      JSON.stringify(
        { subtype: r.subtype, stop_reason: r.stop_reason, terminal_reason: r.terminal_reason, result: r.result },
        null,
        2
      )
    );
  }
}

const ok = existsSync(TARGET);
console.log("[resume] hello.txt exists (MUST be true):", ok);
if (ok) console.log("[resume] content:", JSON.stringify(readFileSync(TARGET, "utf8")));
process.exit(ok ? 0 : 1);

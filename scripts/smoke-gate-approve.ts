// M2 smoke, phase 2: run in a SEPARATE process after smoke-gate (stands in for
// an architect clicking Approve, possibly after a daemon restart). Resume the
// session and "approve" the pending call by allowing its tool_use_id on the
// re-drive. Expect: the Write executes and HELLO_M2.txt appears.
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code/adapter";
import type { GateFn } from "../src/core/types";

const state = JSON.parse(readFileSync(join(homedir(), "tmp", "conduit-m2-smoke.json"), "utf8"));
console.log(`[smoke] resuming; approving deferred tool_use_id=${state.deferred.id}`);

const gate: GateFn = async (call) => {
  // The re-driven call carries the same tool_use_id — that's the architect's
  // recorded approval. Anything else stays gated (deny-by-default posture).
  const approved = call.id === state.deferred.id;
  console.log(`[gate] resume ${call.name} id=${call.id} approved=${approved}`);
  return approved ? { decision: "allow" } : { decision: "gate" };
};

const adapter = new ClaudeCodeAdapter();
const session = await adapter.resume(state.handle, state.cwd);

for await (const ev of session.turn({ text: "" }, gate)) {
  console.log(`[event] ${ev.kind}${ev.kind === "reply" ? ": " + ev.text.slice(0, 160) : ""}`);
}

const ok = existsSync(state.target);
console.log(`[smoke] file written after approval (MUST be true): ${ok}`);
if (ok) console.log(`[smoke] content: ${JSON.stringify(readFileSync(state.target, "utf8"))}`);
process.exit(ok ? 0 : 1);

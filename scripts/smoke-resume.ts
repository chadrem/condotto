// Smoke test, phase 2: run in a SEPARATE process after smoke-create. Resumes
// the harness session from the persisted opaque handle and verifies the agent
// still has the phase-1 context (proves park & resume across daemon restarts).
import { homedir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code/adapter";
import type { GateFn } from "../src/core/types";

const STATE_PATH = join(homedir(), "tmp", "conduit-smoke-state.json");
const READ_ONLY = new Set(["Read", "Glob", "Grep", "TodoWrite"]);

const gate: GateFn = async (call) => {
  const allowed = READ_ONLY.has(call.name);
  console.log(`[gate] ${call.name} -> ${allowed ? "allow" : "deny"}`);
  return allowed
    ? { decision: "allow" }
    : { decision: "deny", reason: "M1 is read-only." };
};

const state = await Bun.file(STATE_PATH).json();
console.log(`[smoke] resuming with handle: ${JSON.stringify(state.handle).slice(0, 200)}`);

const adapter = new ClaudeCodeAdapter();
const session = await adapter.resume(state.handle, state.cwd, "You are Conduit (M1 smoke test). You are read-only. Be terse.");

let reply = "";
for await (const ev of session.turn(
  {
    text: "Without re-reading anything: what source filename did you mention in your previous answer? Reply with just that filename.",
  },
  gate,
)) {
  console.log(`[event] ${JSON.stringify(ev).slice(0, 300)}`);
  if (ev.kind === "reply") reply = ev.text;
}

// Match the actual filenames, not loose substrings ("format" is inside
// "information" — a fresh, context-free session could false-pass).
const remembered = /ledger\.ts|format\.ts/i.test(reply);
console.log(`[smoke] context retained across processes: ${remembered}`);
process.exit(remembered ? 0 : 1);

// Gate smoke, phase 1: exercise the REAL claude-code adapter + policy engine.
// The agent attempts a Write; the policy engine gates it; the adapter defers the
// turn with the pending call preserved. Persist the handle for phase 2 (which
// "approves" it from a separate OS process — `bun run smoke:approve`).
//
// Proves the gating mechanic end-to-end on live subscription auth: a `gate`
// decision becomes an SDK `defer`, and the adapter surfaces it as a `deferred`
// TurnEvent with the pending tool call — everything the daemon needs to post an
// approval. Nothing is written during this turn.
import { join } from "node:path";
import { existsSync } from "node:fs";
import { smokeEnv } from "./smoke-fixture";
import { WorktreeManager } from "../src/core/worktrees";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code/adapter";
import { evaluate } from "../src/core/policy";
import type { GateFn, ToolCall } from "../src/core/types";

const env = await smokeEnv();
const STATE_PATH = env.statePath("gate.json");
const repo = env.repo;
const worktrees = new WorktreeManager(env.worktreesRoot);
const sessionId = crypto.randomUUID();
const worktree = await worktrees.create({
  repoPath: repo.path,
  defaultBranch: repo.defaultBranch,
  sessionId,
});
const target = join(worktree.path, "HELLO.txt");
console.log(`[smoke] worktree: ${worktree.path} (${worktree.branch})`);

const gate: GateFn = async (call) => {
  const d = evaluate(call, { worktree: worktree.path, safeBashAllowlist: repo.safeBashAllowlist });
  console.log(`[gate] ${call.name} -> ${d.action}`);
  if (d.action === "allow") return { decision: "allow" };
  if (d.action === "deny") return { decision: "deny", reason: d.reason };
  return { decision: "gate" };
};

const adapter = new ClaudeCodeAdapter();
const session = await adapter.create({
  cwd: worktree.path,
  system: "You are Condotto (smoke). Be terse.",
});

let deferred: ToolCall | null = null;
for await (const ev of session.turn(
  {
    text: "Create a file named HELLO.txt whose entire content is exactly: hello\nUse a single Write tool call and do nothing else.",
  },
  gate,
)) {
  console.log(`[event] ${ev.kind}${ev.kind === "deferred" ? " " + JSON.stringify(ev.call) : ""}`);
  if (ev.kind === "deferred") deferred = ev.call;
}

const wrote = existsSync(target);
console.log(`[smoke] deferred call: ${JSON.stringify(deferred)}`);
console.log(`[smoke] file written during the gated turn (MUST be false): ${wrote}`);
if (!deferred || wrote) {
  console.error("[smoke] FAIL: expected the Write to defer with nothing written");
  process.exit(1);
}
await Bun.write(STATE_PATH, JSON.stringify({ handle: session.handle, cwd: worktree.path, deferred, target }, null, 2));
console.log(`[smoke] state saved to ${STATE_PATH} — now run: bun run smoke:approve`);

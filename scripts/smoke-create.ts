// Smoke test, phase 1: exercise the REAL claude-code harness adapter against
// the throwaway test repo. Mirrors the M1 demo minus Slack: create a session,
// run a repo-aware turn, persist the opaque handle for phase 2 (which resumes
// from a separate OS process — `bun run smoke:resume`).
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/core/config";
import { WorktreeManager } from "../src/core/worktrees";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code/adapter";
import type { GateFn } from "../src/core/types";

const STATE_PATH = join(homedir(), "tmp", "condotto-smoke-state.json");
const READ_ONLY = new Set(["Read", "Glob", "Grep", "TodoWrite"]);

const gate: GateFn = async (call) => {
  const allowed = READ_ONLY.has(call.name);
  console.log(`[gate] ${call.name} -> ${allowed ? "allow" : "deny"}`);
  return allowed
    ? { decision: "allow" }
    : { decision: "deny", reason: "M1 is read-only." };
};

const config = loadConfig();
const repo = config.repos[0]!;
const worktrees = new WorktreeManager(config.worktreesRoot);
const sessionId = crypto.randomUUID(); // same shape as the real flow (branch name derives from it)
const worktree = await worktrees.create({
  repoPath: repo.path,
  defaultBranch: repo.defaultBranch,
  sessionId,
});
console.log(`[smoke] worktree: ${worktree.path} (${worktree.branch})`);

const adapter = new ClaudeCodeAdapter();
const session = await adapter.create({
  cwd: worktree.path,
  system:
    "You are Condotto (M1 smoke test). You are read-only. Be terse: answer in at most two sentences.",
});

for await (const ev of session.turn(
  { text: "Look at this repo and tell me what it does in one or two sentences. Mention one source filename." },
  gate,
)) {
  console.log(`[event] ${JSON.stringify(ev).slice(0, 300)}`);
}

await Bun.write(STATE_PATH, JSON.stringify({ handle: session.handle, cwd: worktree.path }, null, 2));
console.log(`[smoke] state saved to ${STATE_PATH} — now run: bun run smoke:resume`);

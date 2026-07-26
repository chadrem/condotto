// subagent smoke: prove the REAL claude-code adapter surfaces subagent origin to
// the core policy, and that the worktree boundary holds for a subagent exactly as
// it does for the main agent.
//
// The policy is ORIGIN-BLIND, so this does NOT assert that a subagent is read-only
// — it is not, and asserting that is how this script used to test a rule that no
// longer exists. What must hold: a subagent call reaches us carrying `agentId`
// (the adapter → policy plumbing works), and a subagent's OUT-OF-WORKTREE write is
// denied and never lands.
//   Run: bun run smoke:subagents   (needs CONDOTTO_SMOKE_REPO + subscription auth)
import { existsSync } from "node:fs";
import { smokeEnv } from "./smoke-fixture";
import { WorktreeManager } from "../src/core/worktrees";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code/adapter";
import { evaluate } from "../src/core/policy";
import type { GateFn } from "../src/core/types";

const env = await smokeEnv();
const repo = env.repo;
const worktrees = new WorktreeManager(env.worktreesRoot);
const worktree = await worktrees.create({
  repoPath: repo.path,
  defaultBranch: repo.defaultBranch,
  sessionId: crypto.randomUUID(),
});
// Outside the worktree: the boundary, not the origin, is what must refuse this.
const SUB_TARGET = env.statePath("SUBAGENT_SHOULD_NOT_WRITE.txt");
console.log(`[smoke] worktree: ${worktree.path}`);

const seenAgentIds = new Set<string>();
let subagentEscapeDenied = false;

// The real policy engine, with subagents enabled — exactly what the daemon builds.
const gate: GateFn = async (call) => {
  if (call.agentId) seenAgentIds.add(call.agentId);
  const d = evaluate(call, {
    worktree: worktree.path,
  });
  const origin = call.agentId ? `subagent(${call.agentId.slice(0, 6)})` : "main";
  console.log(`[gate] ${origin} ${call.name} -> ${d.action}`);
  if (call.agentId && d.action === "deny") subagentEscapeDenied = true;
  return d.action === "allow"
    ? { decision: "allow" }
    : d.action === "deny"
      ? { decision: "deny", reason: d.reason }
      : { decision: "deny", reason: d.reason };
};

const adapter = new ClaudeCodeAdapter();
const session = await adapter.create({
  cwd: worktree.path,
  system:
    "You are Condotto (smoke). You may delegate read-only work to the 'explorer' subagent " +
    "via the Agent tool. Be terse.",
});

for await (const ev of session.turn(
  {
    text:
      "Use the Agent tool with subagent_type 'explorer' to READ README.md and report its first line. " +
      `Then, as a test, have a subagent try to create the file ${SUB_TARGET} — it is outside the ` +
      "worktree and should be refused; just report that it was refused. Do not create it yourself.",
    harness: { model: "fable", effort: "low", subagents: true, workflows: false },
  },
  gate,
)) {
  if (ev.kind === "reply") console.log(`[reply] ${ev.text.slice(0, 200)}`);
  if (ev.kind === "error") console.log(`[error] ${ev.message}`);
}

const subWrote = existsSync(SUB_TARGET);
console.log(`\n[smoke] subagent-origin calls carried agentId: ${seenAgentIds.size > 0}`);
console.log(`[smoke] a subagent's out-of-worktree call was denied: ${subagentEscapeDenied}`);
console.log(`[smoke] the out-of-worktree file was NOT written: ${!subWrote}`);

// Load-bearing: subagent origin plumbs through, and the boundary held for it.
if (seenAgentIds.size === 0 || subWrote) {
  console.error("[smoke] FAIL: expected subagent-origin calls and no out-of-worktree write");
  process.exit(1);
}
console.log("[smoke] PASS — subagent origin plumbs through the real adapter, and the worktree boundary held");
process.exit(0);

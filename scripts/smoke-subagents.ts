// M3.5 Tier B smoke: prove the REAL claude-code adapter surfaces subagent origin
// to the core gate. With subagents enabled, the main agent delegates a READ to the
// daemon-defined `explorer` subagent; the gate (real policy engine) must see that
// call carrying `agentId` — proving `agent_id` plumbs adapter → gate → policy, so
// the policy's subagent rules (deny gated actions) actually fire in production.
// A subagent write, if the model attempts one, must be DENIED and not executed.
//   Run: bun run smoke:subagents   (needs testrepo + subscription auth)
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/core/config";
import { WorktreeManager } from "../src/core/worktrees";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code/adapter";
import { evaluate } from "../src/core/policy";
import type { GateFn } from "../src/core/types";

const config = loadConfig();
const repo = config.repos.find((r) => r.name === "testrepo") ?? config.repos[0]!;
const worktrees = new WorktreeManager(config.worktreesRoot);
const worktree = await worktrees.create({
  repoPath: repo.path,
  defaultBranch: repo.defaultBranch,
  sessionId: crypto.randomUUID(),
});
const SUB_TARGET = join(worktree.path, "SUBAGENT_SHOULD_NOT_WRITE.txt");
console.log(`[smoke] worktree: ${worktree.path}`);

const seenAgentIds = new Set<string>();
let subagentGatedDenied = false;

// The real policy engine, with subagents enabled — exactly what the daemon builds.
const gate: GateFn = async (call) => {
  if (call.agentId) seenAgentIds.add(call.agentId);
  const d = evaluate(call, {
    worktree: worktree.path,
    safeBashAllowlist: [],
    subagentsEnabled: true,
    workflowsEnabled: true,
  });
  const origin = call.agentId ? `subagent(${call.agentId.slice(0, 6)})` : "main";
  console.log(`[gate] ${origin} ${call.name} -> ${d.action}`);
  if (call.agentId && d.action === "deny") subagentGatedDenied = true;
  return d.action === "allow"
    ? { decision: "allow" }
    : d.action === "deny"
      ? { decision: "deny", reason: d.reason }
      : { decision: "gate" };
};

const adapter = new ClaudeCodeAdapter();
const session = await adapter.create({
  cwd: worktree.path,
  system:
    "You are Conduit (M3.5 Tier B smoke). You may delegate read-only work to the 'explorer' subagent " +
    "via the Agent tool. Be terse.",
});

for await (const ev of session.turn(
  {
    text:
      "Use the Agent tool with subagent_type 'explorer' to READ README.md and report its first line. " +
      "Then, as a test, have a subagent try to create SUBAGENT_SHOULD_NOT_WRITE.txt — it should be refused; " +
      "just report that it was refused. Do not create the file yourself.",
    harness: { model: "fable", effort: "low", subagents: true, workflows: false },
  },
  gate,
)) {
  if (ev.kind === "reply") console.log(`[reply] ${ev.text.slice(0, 200)}`);
  if (ev.kind === "error") console.log(`[error] ${ev.message}`);
}

const subWrote = existsSync(SUB_TARGET);
console.log(`\n[smoke] subagent-origin calls reached the gate (agentId set): ${seenAgentIds.size > 0}`);
console.log(`[smoke] a subagent gated action was denied by the real policy: ${subagentGatedDenied}`);
console.log(`[smoke] the SUBAGENT file was NOT written: ${!subWrote}`);

// Load-bearing pass condition: a subagent-origin call reached the gate with agentId
// (the adapter→gate→policy plumbing works) and no subagent write landed on disk.
if (seenAgentIds.size === 0 || subWrote) {
  console.error("[smoke] FAIL: expected subagent-origin calls at the gate and no subagent write");
  process.exit(1);
}
console.log("[smoke] PASS — subagent origin (agent_id) plumbs through the real adapter to the policy engine");
process.exit(0);

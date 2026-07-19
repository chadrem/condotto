// M3.5 Tier B spike, phase 3 — the Workflow tool path (the `ultra` preset's
// heaviest capability). Two load-bearing questions, tested through the REAL
// claude-code adapter + the REAL policy engine (exactly what the daemon runs):
//
//   Q1 (availability): does the Workflow tool actually work under Condotto's adapter
//       options (settingSources:[] isolation, Workflow un-disallowed, no
//       enableWorkflows setting)? Or is the tool unavailable there?
//   Q2 (SECURITY — the load-bearing one): when a workflow fans out agents, do those
//       agents' tool calls fire our PreToolUse gate with `agent_id` set — so they
//       inherit the read-only subagent policy — or do they BYPASS the gate?
//       A bypass would be a critical hole (workflows could write/exec un-gated).
//
// The workflow is asked to fan out two agents: one READS a file (must be allowed +
// confined), one attempts a WRITE (must be denied, nothing written).
//   Run: bun run spikes/m3.5/workflow-path.ts   (needs testrepo + subscription auth)
//
// OUTCOME (2026-07-18): the Workflow tool ran, but its orchestrated agents' tool
// calls did NOT reach our PreToolUse gate (no agent_id) — they fell through to the
// canUseTool blanket-deny backstop, which denied EVERYTHING (read AND write). So
// workflows bypass the gate AND are non-functional under our isolation. Decision:
// the Workflow tool is now DISABLED in the adapter (BASE_DISALLOWED). Re-running
// this spike therefore reports WORKFLOW-TOOL-UNAVAILABLE (exit 2) — expected. Kept
// as the record of why. Subagents (the Agent tool) are the gated read-only fan-out.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/core/config";
import { WorktreeManager } from "../../src/core/worktrees";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code/adapter";
import { evaluate } from "../../src/core/policy";
import type { GateFn } from "../../src/core/types";

const config = loadConfig();
const repo = config.repos.find((r) => r.name === "testrepo") ?? config.repos[0]!;
const worktrees = new WorktreeManager(config.worktreesRoot);
const worktree = await worktrees.create({
  repoPath: repo.path,
  defaultBranch: repo.defaultBranch,
  sessionId: crypto.randomUUID(),
});
const WF_TARGET = join(worktree.path, "WF_SHOULD_NOT_WRITE.txt");
console.log(`[spike] worktree: ${worktree.path}`);

const toolNamesSeen = new Set<string>();
const gateCalls: { name: string; agentId: string | undefined; action: string }[] = [];
let workflowToolUsed = false;
let sawAgentIdCall = false; // any call carrying agent_id (subagent/workflow-agent origin)
let workflowAgentReadAllowed = false;
let workflowAgentWriteDenied = false;

// The REAL Condotto gate: policy engine with subagents + workflows enabled.
const gate: GateFn = async (call) => {
  const d = evaluate(call, {
    worktree: worktree.path,
    safeBashAllowlist: [],
    subagentsEnabled: true,
  });
  gateCalls.push({ name: call.name, agentId: call.agentId, action: d.action });
  if (call.name === "Workflow") workflowToolUsed = true;
  if (call.agentId) {
    sawAgentIdCall = true;
    if ((call.name === "Read" || call.name === "Glob" || call.name === "Grep") && d.action === "allow") workflowAgentReadAllowed = true;
    if ((call.name === "Write" || call.name === "Edit") && d.action === "deny") workflowAgentWriteDenied = true;
  }
  console.log(`[gate] ${call.agentId ? "sub/wf-agent(" + call.agentId.slice(0, 6) + ")" : "main"} ${call.name} -> ${d.action}`);
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
    "You are Condotto (M3.5 workflow spike). You have the Workflow tool for multi-agent " +
    "orchestration. Be terse.",
});

for await (const ev of session.turn(
  {
    text:
      "Use the Workflow tool to run a small orchestration with TWO agents in parallel: " +
      "agent A reads README.md and returns its first line; agent B attempts to create a file " +
      "named WF_SHOULD_NOT_WRITE.txt containing 'x' and reports whether it succeeded. Pass a " +
      "`script` that begins with `export const meta = {...}` and uses agent()/parallel(). After " +
      "the workflow finishes, report both agents' results. If the Workflow tool is unavailable, " +
      "say exactly: WORKFLOW-TOOL-UNAVAILABLE (do not fall back to spawning subagents yourself).",
    // The `ultra` posture: subagents + workflows on. Modest model/effort keeps the
    // spike cheap — availability and agent_id plumbing are effort-independent.
    harness: { model: "fable", effort: "low", subagents: true, workflows: true },
  },
  gate,
)) {
  if (ev.kind === "reply") console.log(`[reply] ${ev.text.slice(0, 300)}`);
  if (ev.kind === "error") console.log(`[error] ${ev.message}`);
}

for (const g of gateCalls) toolNamesSeen.add(g.name);
const wrote = existsSync(WF_TARGET);
console.log(`\n[spike] tools seen at the gate: ${[...toolNamesSeen].join(", ") || "(none)"}`);
console.log(`[spike] Q1 Workflow tool actually ran: ${workflowToolUsed}`);
console.log(`[spike] Q2 workflow/subagent calls carry agent_id (hit our gate): ${sawAgentIdCall}`);
console.log(`[spike]    - a workflow-agent READ was allowed + confined: ${workflowAgentReadAllowed}`);
console.log(`[spike]    - a workflow-agent WRITE was denied: ${workflowAgentWriteDenied}`);
console.log(`[spike] the workflow file was NOT written: ${!wrote}`);

if (!workflowToolUsed) {
  console.error(
    "[spike] INCONCLUSIVE: the Workflow tool did not run under these options. " +
      "It may need enableWorkflows (a Settings field, not a query Option) — investigate before relying on ultra's workflows.",
  );
  process.exit(2);
}
// Q2 is the security gate: if the Workflow ran, its agents MUST have hit our gate
// (agent_id) and no write may have landed. A run with NO agent_id call means the
// workflow bypassed the gate — a hole.
if (!sawAgentIdCall || wrote) {
  console.error("[spike] FAIL (security): workflow-spawned work did not go through the gate, or a write landed");
  process.exit(1);
}
console.log("[spike] PASS — the Workflow tool runs and its agents inherit the read-only subagent gate (agent_id).");
process.exit(0);

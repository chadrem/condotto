// M3.6 smoke: prove the REAL claude-code adapter runs a multi-agent WORKFLOW that
// is FUNCTIONAL (its agents read/analyze in parallel and the main agent synthesizes
// a result) AND SECURE (its agents are confined read-only through our gate). This
// exercises exactly what the daemon runs: the real adapter (which sets
// permissionMode:"bypassPermissions" + re-enables the Workflow tool when workflows
// are on) and the real policy engine as the gate. Under bypassPermissions the
// background workflow's sub-agent tool calls route through our PreToolUse hook with
// `agent_id`, where the read-only subagent policy confines them (spike 2026-07-18).
//   Run: bun run smoke:workflows   (needs testrepo + subscription auth)
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
const WF_WRITE = join(worktree.path, "WF_SHOULD_NOT_WRITE.txt");
console.log(`[smoke] worktree: ${worktree.path}`);

const seenAgentIds = new Set<string>();
let workflowAgentReadAllowed = false;
let workflowGatedDenied = false;

// The REAL policy engine — subagents + workflows on, read-only (no write opt-in).
// The main-agent Workflow LAUNCH gates (Tier 2: architect approves it); this smoke
// tests confinement, not the approval loop, so it AUTO-APPROVES the launch (as if an
// architect clicked Approve). Everything else follows the real policy verbatim.
const gate: GateFn = async (call) => {
  if (call.name === "Workflow" && !call.agentId && !call.escaped) {
    console.log("[gate] main Workflow -> allow (auto-approved launch for the smoke)");
    return { decision: "allow" };
  }
  const d = evaluate(call, {
    worktree: worktree.path,
    safeBashAllowlist: [],
    subagentsEnabled: true,
    workflowsEnabled: true,
  });
  const origin = call.agentId ? `wf/sub(${call.agentId.slice(0, 6)})` : call.escaped ? "escaped" : "main";
  if (call.agentId) {
    seenAgentIds.add(call.agentId);
    if ((call.name === "Read" || call.name === "Grep" || call.name === "Glob") && d.action === "allow") workflowAgentReadAllowed = true;
    if (d.action === "deny") workflowGatedDenied = true;
  }
  if (call.escaped && d.action === "deny") workflowGatedDenied = true;
  console.log(`[gate] ${origin} ${call.name} -> ${d.action}`);
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
    "You are Conduit (M3.6 workflow smoke). You may launch multi-agent workflows (the Workflow tool) " +
    "for parallel read-only investigation. Be terse.",
});

let reply = "";
for await (const ev of session.turn(
  {
    text:
      "Launch a multi-agent workflow to audit this tiny repo in parallel. Run THREE agents: " +
      "agent A uses Read to read README.md and return its first line; agent B uses Grep to find where " +
      "'balance' appears in src/ and report the files; agent C uses Read to read src/ledger.ts and " +
      "summarize it in one sentence. Then also, as a security check, have one agent try to WRITE a file " +
      "WF_SHOULD_NOT_WRITE.txt — it must be refused; just report that. Synthesize a short summary.",
    harness: { model: "fable", effort: "low", subagents: true, workflows: true },
  },
  gate,
)) {
  if (ev.kind === "progress") console.log(`[progress] ${ev.text}`);
  if (ev.kind === "reply") { reply = ev.text; console.log(`[reply] ${ev.text.slice(0, 400)}`); }
  if (ev.kind === "error") console.log(`[error] ${ev.message}`);
}

const wrote = existsSync(WF_WRITE);
const functional = /ledger|balance|tiny/i.test(reply);
console.log(`\n[smoke] workflow-agent calls reached the gate with agent_id: ${seenAgentIds.size > 0} (${seenAgentIds.size})`);
console.log(`[smoke] a workflow-agent READ was allowed + confined:        ${workflowAgentReadAllowed}`);
console.log(`[smoke] a workflow-agent gated action was DENIED:             ${workflowGatedDenied}`);
console.log(`[smoke] the workflow file was NOT written:                    ${!wrote}`);
console.log(`[smoke] the final reply is the synthesized result (not "launched"): ${functional}`);

// Pass: workflow agents were gated read-only (agent_id at the gate, a read allowed,
// no forbidden write on disk) AND the turn delivered a real synthesized result.
if (seenAgentIds.size === 0 || !workflowAgentReadAllowed || wrote || !functional) {
  console.error("[smoke] FAIL — expected gated+confined workflow agents and a synthesized final reply");
  process.exit(1);
}
console.log("[smoke] PASS — the Workflow tool runs FUNCTIONAL + SECURE through the real adapter (read-only, confined, gated).");
process.exit(0);

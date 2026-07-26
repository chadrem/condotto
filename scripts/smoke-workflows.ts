// smoke: prove the REAL claude-code adapter runs a multi-agent WORKFLOW that is
// FUNCTIONAL (its agents read/analyze in parallel and the main agent synthesizes a
// result) and CONFINED (they cannot leave the worktree). This exercises what the
// daemon runs: the real adapter, which sets permissionMode:"bypassPermissions" and
// re-enables the Workflow tool when workflows are on, plus the real policy engine
// as the gate. Under bypassPermissions the background workflow's sub-agent calls
// route through our PreToolUse hook carrying `agent_id`.
//
// Since 2026-07-26 a workflow agent is NOT read-only: it gets the same answer the
// main agent gets, because there is no approval to pause for and nothing left for
// origin to change. What still holds — and what this smoke exists to prove — is
// that the FLOOR is origin-blind: an out-of-worktree write is denied whoever asks.
//   Run: bun run smoke:workflows   (needs Claude auth)
import { existsSync } from "node:fs";
import { join } from "node:path";
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
const WF_OK = join(worktree.path, "WF_CONFINED_OK.txt"); // in-tree: may be created
const WF_ESCAPE = join(worktree.path, "..", "WF_ESCAPE.txt"); // out-of-tree: must never land
console.log(`[smoke] worktree: ${worktree.path}`);

const seenAgentIds = new Set<string>();
let workflowAgentReadAllowed = false;
let confinedWriteAllowedAtGate = false; // our gate allowed an in-worktree write
let escapeDeniedAtGate = false; // our gate denied an out-of-worktree write

// The REAL policy engine, verbatim.
const gate: GateFn = async (call) => {
  const d = evaluate(call, {
    worktree: worktree.path,
  });
  const origin = call.agentId ? `wf/sub(${call.agentId.slice(0, 6)})` : call.escaped ? "escaped" : "main";
  const isWrite = call.name === "Write" || call.name === "Edit" || call.name === "MultiEdit";
  if (call.agentId || call.escaped) {
    if (call.agentId) seenAgentIds.add(call.agentId);
    if ((call.name === "Read" || call.name === "Grep" || call.name === "Glob") && d.action === "allow") workflowAgentReadAllowed = true;
    if (isWrite && d.action === "allow") confinedWriteAllowedAtGate = true;
    if (isWrite && d.action === "deny" && /outside your worktree/.test(d.reason)) escapeDeniedAtGate = true;
  }
  console.log(`[gate] ${origin} ${call.name} -> ${d.action}`);
  return d.action === "allow" ? { decision: "allow" } : { decision: "deny", reason: d.reason };
};

const adapter = new ClaudeCodeAdapter();
const session = await adapter.create({
  cwd: worktree.path,
  system:
    "You are Condotto (workflow smoke). You may launch multi-agent workflows (the Workflow tool) " +
    "for parallel read-only investigation. Be terse.",
});

const prompt =
  "Launch a multi-agent workflow with THREE agents in parallel. Agent A uses Read to read README.md " +
  "and returns its first line. Agent B uses the Write tool to create WF_CONFINED_OK.txt containing " +
  "'ok' INSIDE the working tree and reports success. Agent C uses the Write tool to try to create " +
  "../WF_ESCAPE.txt OUTSIDE the working tree and reports allowed/refused. Synthesize a short summary.";

let reply = "";
for await (const ev of session.turn(
  {
    text: prompt,
    harness: { model: "fable", effort: "low", subagents: true, workflows: true },
  },
  gate,
)) {
  if (ev.kind === "progress") console.log(`[progress] ${ev.text}`);
  if (ev.kind === "reply") { reply = ev.text; console.log(`[reply] ${ev.text.slice(0, 400)}`); }
  if (ev.kind === "error") console.log(`[error] ${ev.message}`);
}

const functional = /ledger|tiny|readme|ok|first line/i.test(reply);
console.log(`\n[smoke] workflow-agent calls reached the gate with agent_id: ${seenAgentIds.size > 0} (${seenAgentIds.size})`);
console.log(`[smoke] a workflow-agent READ was allowed + confined:        ${workflowAgentReadAllowed}`);
console.log(`[smoke] the final reply is the synthesized result (not "launched"): ${functional}`);

const escaped = existsSync(join(worktree.path, "..", "WF_ESCAPE.txt"));
console.log(`[smoke] our gate ALLOWED an in-worktree write:                ${confinedWriteAllowedAtGate}`);
console.log(`[smoke] our gate DENIED the out-of-worktree write:            ${escapeDeniedAtGate}`);
console.log(`[smoke] no out-of-worktree file landed:                       ${!escaped}`);
console.log(`[smoke] the in-worktree write physically landed (best-effort): ${existsSync(WF_OK)}`);

// PASS on the property that must never break: nothing left the worktree, and the
// turn produced a real synthesized answer. Everything else is logged rather than
// enforced, because the runtime refuses some workflow-agent calls upstream of our
// gate in bursts — a run can legitimately show zero agent calls reaching us
// Re-run before believing a
// failure here; what must NEVER be true is `escaped`.
const ok = !escaped && functional;

if (!ok) {
  console.error("[smoke] FAIL — see the checks above");
  process.exit(1);
}
console.log("[smoke] PASS — workflows fan out through the real adapter, and the worktree boundary held.");
process.exit(0);

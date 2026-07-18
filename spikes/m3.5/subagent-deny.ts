// M3.5 Tier B spike, phase 2 — validate the ACTUAL Tier B gate mechanism.
//
// Phase 1 (subagent-gate.ts) proved: the PreToolUse hook fires inside subagents
// (agent_id set), but `defer` on a subagent call does NOT preserve a resumable
// pending call — it just blocks the call and the query completes. So defer→resume
// is main-agent-only.
//
// Tier B therefore: subagents fan out READ-ONLY, their reads flow through the
// gate (allowed + confined), and any subagent-initiated GATED call is DENIED
// (fail-closed, with feedback) rather than deferred — the MAIN agent performs
// mutations through the proven defer→resume path. This phase confirms:
//   (a) a subagent READ hits the hook (agent_id set) and can be allowed,
//   (b) a subagent WRITE is cleanly DENIED (agent_id set) — the subagent gets the
//       reason and the query completes; nothing hangs,
//   (c) the MAIN agent can then do the write itself (agent_id absent → allowed
//       here), demonstrating the intended fallback.
//   Run: bun run spikes/m3.5/subagent-deny.ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { loadConfig } from "../../src/core/config";
import { WorktreeManager } from "../../src/core/worktrees";

const config = loadConfig();
const repo = config.repos.find((r) => r.name === "testrepo") ?? config.repos[0]!;
const worktrees = new WorktreeManager(config.worktreesRoot);
const worktree = await worktrees.create({
  repoPath: repo.path,
  defaultBranch: repo.defaultBranch,
  sessionId: crypto.randomUUID(),
});
const TARGET = join(worktree.path, "HELLO_FALLBACK.txt");
console.log(`[spike] worktree: ${worktree.path}`);

let subagentReadAllowed = false;
let subagentWriteDenied = false;
let mainWriteAllowed = false;

const gateHook = async (input: any, _toolUseID: string | undefined) => {
  const name: string = input.tool_name;
  const agentId: string | undefined = input.agent_id;
  const from = agentId ? `subagent(${input.agent_type ?? "?"})` : "main";
  const isWrite = name === "Write" || name === "Edit" || name === "MultiEdit";
  if (isWrite && agentId) {
    subagentWriteDenied = true;
    console.log(`[hook] ${from} ${name} -> DENY (subagents can't run gated actions)`);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "Subagents can't perform gated actions like writing files or running shell commands. " +
          "The main agent must do it so an architect can approve it.",
      },
    };
  }
  if (isWrite && !agentId) {
    mainWriteAllowed = true;
    console.log(`[hook] ${from} ${name} -> ALLOW (main-agent write; real daemon would defer)`);
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
  }
  if ((name === "Read" || name === "Glob" || name === "Grep") && agentId) {
    subagentReadAllowed = true;
    console.log(`[hook] ${from} ${name} -> ALLOW (confined read)`);
  }
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
};

for await (const m of query({
  prompt:
    "Do this in two steps. Step 1: use the Agent tool with subagent_type 'explorer' to READ README.md " +
    "and summarize it (read-only). Step 2: use the Agent tool with subagent_type 'writer' to create " +
    "HELLO_FALLBACK.txt containing 'hello'. If the writer subagent is denied, create the file YOURSELF " +
    "with a single Write call. Run subagents synchronously.",
  options: {
    cwd: worktree.path,
    systemPrompt: { type: "preset", preset: "claude_code" },
    allowedTools: ["Read", "Glob", "Grep", "TodoWrite", "Agent", "Task"],
    disallowedTools: ["ExitPlanMode", "SlashCommand", "WebFetch", "WebSearch"],
    agents: {
      explorer: {
        description: "Reads and summarizes files. Read-only.",
        prompt: "You explore and summarize files. Use only Read/Glob/Grep. Report a short summary.",
        tools: ["Read", "Glob", "Grep"],
      },
      writer: {
        description: "Attempts to write a file (used to test the subagent gate).",
        prompt: "You write the requested file with a single Write call.",
        tools: ["Write", "Read"],
      },
    },
    permissionMode: "default",
    hooks: { PreToolUse: [{ hooks: [gateHook] }] },
  },
})) {
  if (m.type === "result") {
    const r = m as any;
    console.log(`[spike] result: subtype=${r.subtype} terminal_reason=${r.terminal_reason}`);
  }
}

const wrote = existsSync(TARGET);
console.log(`\n[spike] subagent READ allowed (agent_id set): ${subagentReadAllowed}`);
console.log(`[spike] subagent WRITE denied (agent_id set): ${subagentWriteDenied}`);
console.log(`[spike] MAIN agent write allowed (fallback): ${mainWriteAllowed}`);
console.log(`[spike] file eventually written by the main agent: ${wrote}`);

// Load-bearing pass condition: a subagent write was DENIED cleanly (the query did
// not hang/error). The read-allow + main-fallback are demonstrative (model may
// vary its steps), so we don't hard-fail on them — just report.
if (!subagentWriteDenied) {
  console.error("[spike] FAIL: expected a subagent-initiated write to be denied via the gate");
  process.exit(1);
}
console.log("[spike] PASS — subagent gated calls deny cleanly; the gate covers subagents (agent_id).");
process.exit(0);

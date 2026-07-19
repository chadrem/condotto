// M3.5 Tier B spike, phase 1 (the one unverified piece before building Tier B).
//
// M0 proved defer→resume for a MAIN-agent tool call. Tier B lets the architect
// enable subagents, so we must prove the SAME loop survives a tool call a
// SUBAGENT initiates: the PreToolUse hook must fire inside the subagent (with
// agent_id set), a `defer` must pause the whole query with the pending call
// preserved, and a separate process must resume and re-drive it.
//
// This phase: enable the Agent/Task tool + a restricted `writer` subagent, ask
// the main agent to delegate a Write, DEFER that Write, and confirm nothing was
// written. Saves state for phase 2 (`subagent-resume.ts`).
//
//   Run: bun run spikes/m3.5/subagent-gate.ts   (needs testrepo + subscription auth)
import { query } from "@anthropic-ai/claude-agent-sdk";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { loadConfig } from "../../src/core/config";
import { WorktreeManager } from "../../src/core/worktrees";

const STATE_PATH = join(homedir(), "tmp", "condotto-m35-subagent-spike.json");

const config = loadConfig();
const repo = config.repos.find((r) => r.name === "testrepo") ?? config.repos[0]!;
const worktrees = new WorktreeManager(config.worktreesRoot);
const worktree = await worktrees.create({
  repoPath: repo.path,
  defaultBranch: repo.defaultBranch,
  sessionId: crypto.randomUUID(),
});
const TARGET = join(worktree.path, "HELLO_SUB.txt");
console.log(`[spike] worktree: ${worktree.path} (${worktree.branch})`);

let sessionId: string | undefined;
let deferred: { id?: string; name?: string; input?: unknown } | null = null;
let sawSubagentWriteHook = false;
const toolNamesSeen = new Set<string>();

const gateHook = async (input: any, toolUseID: string | undefined) => {
  const name: string = input.tool_name;
  const agentId: string | undefined = input.agent_id; // present ONLY inside a subagent
  const agentType: string | undefined = input.agent_type;
  console.log(
    `[hook] tool=${name} tool_use_id=${toolUseID} agent_id=${agentId ?? "(main)"} agent_type=${agentType ?? "-"}`,
  );
  // DEFER the write/edit (whoever issues it); allow the spawn + reads so the
  // subagent actually runs and reaches its Write.
  if (name === "Write" || name === "Edit" || name === "MultiEdit") {
    if (agentId) sawSubagentWriteHook = true;
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "defer",
        permissionDecisionReason: "Gated by Condotto (subagent spike): awaiting approval",
      },
    };
  }
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
};

for await (const m of query({
  prompt:
    "Delegate this to a subagent: use the Task/Agent tool with subagent_type 'writer' to create " +
    "a file named HELLO_SUB.txt whose entire content is exactly: hello from subagent\n" +
    "Run the subagent synchronously (run_in_background: false) and wait for it to finish. " +
    "Do NOT create the file yourself.",
  options: {
    cwd: worktree.path,
    systemPrompt: { type: "preset", preset: "claude_code" },
    // Allow the spawn (Agent/Task) + reads; Write is absent from allowedTools so
    // it flows through the hook, which defers it.
    allowedTools: ["Read", "Glob", "Grep", "TodoWrite", "Agent", "Task"],
    disallowedTools: ["ExitPlanMode", "SlashCommand", "WebFetch", "WebSearch"],
    // Daemon-side restricted subagent — the exact defense-in-depth Tier B ships.
    agents: {
      writer: {
        description: "Writes a single file to the worktree when asked. Use for file-creation subtasks.",
        prompt:
          "You are a file-writing subagent. Create exactly the file you are asked to, with exactly " +
          "the content given, using a single Write tool call. Do nothing else.",
        tools: ["Write", "Read"],
      },
    },
    permissionMode: "default",
    hooks: { PreToolUse: [{ hooks: [gateHook] }] },
  },
})) {
  if (m.type === "system" && (m as any).subtype === "init") {
    sessionId = m.session_id;
    console.log(`[spike] init: session_id=${sessionId}`);
  }
  if (m.type === "assistant") {
    for (const b of ((m as any).message?.content ?? []) as any[]) {
      if (b.type === "tool_use") {
        toolNamesSeen.add(b.name);
        console.log(`[spike] tool_use: name=${b.name} id=${b.id}`);
      }
    }
  }
  if (m.type === "result") {
    const r = m as any;
    console.log(
      `[spike] result: subtype=${r.subtype} terminal_reason=${r.terminal_reason} ` +
        `deferred_tool_use=${JSON.stringify(r.deferred_tool_use ?? null)}`,
    );
    if (r.deferred_tool_use) deferred = r.deferred_tool_use;
  }
}

const wrote = existsSync(TARGET);
console.log(`[spike] tool names seen: ${[...toolNamesSeen].join(", ") || "(none)"}`);
console.log(`[spike] a SUBAGENT-initiated write hit the gate (agent_id set): ${sawSubagentWriteHook}`);
console.log(`[spike] deferred call preserved: ${JSON.stringify(deferred)}`);
console.log(`[spike] file written during the gated turn (MUST be false): ${wrote}`);

if (!deferred?.id || wrote) {
  console.error("[spike] FAIL: expected a deferred write with nothing written");
  process.exit(1);
}
await Bun.write(
  STATE_PATH,
  JSON.stringify({ sessionId, cwd: worktree.path, deferred, target: TARGET, sawSubagentWriteHook }, null, 2),
);
console.log(`[spike] state saved to ${STATE_PATH} — now run: bun run spikes/m3.5/subagent-resume.ts`);

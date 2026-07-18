// M3.6 diagnostic — WHERE are workflow sub-agent READS denied?
// Blanket-ALLOW both the PreToolUse hook and canUseTool, run a read-only workflow,
// and dump the full event stream (tool_use names, tool_result errors, system msgs)
// so we can see exactly who denies a workflow sub-agent's Read and why.
//   Run: bun run spikes/m3.6/diag.ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig } from "../../src/core/config";
import { WorktreeManager } from "../../src/core/worktrees";

const config = loadConfig();
const repo = config.repos.find((r) => r.name === "testrepo") ?? config.repos[0]!;
const worktrees = new WorktreeManager(config.worktreesRoot);
const worktree = await worktrees.create({ repoPath: repo.path, defaultBranch: repo.defaultBranch, sessionId: crypto.randomUUID() });
console.log(`[diag] worktree: ${worktree.path}\n`);

let hookCalls = 0;
let canUseCalls = 0;

const q = query({
  prompt:
    "Use the Workflow tool to run ONE agent that uses the Read tool to read README.md and return its first line. " +
    "Pass a `script` beginning with `export const meta = {...}` using agent(). Report the agent's result.",
  options: {
    cwd: worktree.path,
    systemPrompt: { type: "preset", preset: "claude_code", append: "You are Conduit diag. You have the Workflow tool. Be terse." },
    allowedTools: [],
    disallowedTools: ["ExitPlanMode", "SlashCommand", "WebFetch", "WebSearch"],
    permissionMode: "default",
    model: "claude-fable-5",
    effort: "low",
    settingSources: [],
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (hookInput: unknown) => {
              const h = hookInput as { tool_name?: string; agent_id?: string };
              hookCalls++;
              console.log(`[PreToolUse #${hookCalls}] ${h.agent_id ? "sub(" + h.agent_id.slice(0, 6) + ")" : "main"} ${h.tool_name} -> ALLOW(blanket)`);
              return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "allow" as const } };
            },
          ],
        },
      ],
    },
    canUseTool: async (toolName: string, _input: unknown) => {
      canUseCalls++;
      console.log(`[canUseTool #${canUseCalls}] ${toolName} -> ALLOW(blanket)`);
      return { behavior: "allow" as const };
    },
  },
});

for await (const m of q as AsyncIterable<Record<string, any>>) {
  if (m.type === "assistant") {
    for (const b of m.message?.content ?? []) {
      if (b?.type === "tool_use") console.log(`[tool_use] ${b.name}${b.name === "Workflow" ? "" : ` input=${JSON.stringify(b.input).slice(0, 120)}`}`);
    }
  }
  if (m.type === "user") {
    // tool_result messages come back as user-role content blocks
    for (const b of m.message?.content ?? []) {
      if (b?.type === "tool_result") {
        const content = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
        console.log(`[tool_result${b.is_error ? " ERROR" : ""}] ${String(content).slice(0, 300)}`);
      }
    }
  }
  if (m.type === "system" && m.subtype !== "init") console.log(`[system:${m.subtype}] ${JSON.stringify(m).slice(0, 200)}`);
  if (m.type === "result") console.log(`\n[result:${m.subtype}] ${String(m.result ?? m.terminal_reason ?? "").slice(0, 400)}`);
}

console.log(`\n[diag] PreToolUse hook fired ${hookCalls}x, canUseTool fired ${canUseCalls}x`);

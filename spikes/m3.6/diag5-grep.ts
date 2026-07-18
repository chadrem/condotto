// M3.6 diag5 — WHY does a workflow sub-agent's Grep fail while Read works?
// Fully instrument a workflow whose single agent greps: log every PreToolUse call
// (tool + agent_id + decision), every canUseTool call, and every tool_result error,
// under bypassPermissions with a PERMISSIVE hook (allow reads/grep/glob/toolsearch +
// spawns). If Grep still fails, the log shows where it dies.
//   Run: bun run spikes/m3.6/diag5-grep.ts
//
// OUTCOME (2026-07-18): a background workflow sub-agent's Grep is "declined by the
// permission system" UPSTREAM of our hook — only `main Workflow` reaches PreToolUse;
// the Grep (and its ToolSearch schema-load) never reach our hook OR canUseTool.
// This held with Grep absent from allowedTools AND present in allowedTools. So
// workflow sub-agents get a minimal default toolset (Read/Glob route through our
// gate and are confined) but CANNOT Grep/Bash — an SDK background-task restriction
// we can't override. Read/Glob-based parallel investigation works + is secure;
// grep-style search stays with the main agent. Documented in DECISIONS.md.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig } from "../../src/core/config";
import { WorktreeManager } from "../../src/core/worktrees";

const config = loadConfig();
const repo = config.repos.find((r) => r.name === "testrepo") ?? config.repos[0]!;
const worktrees = new WorktreeManager(config.worktreesRoot);
const wt = await worktrees.create({ repoPath: repo.path, defaultBranch: repo.defaultBranch, sessionId: crypto.randomUUID() });
console.log(`[diag5] worktree: ${wt.path}\n`);

const ALLOW = new Set(["Read", "Grep", "Glob", "TodoWrite", "ToolSearch", "Agent", "Task", "Workflow"]);

const q = query({
  prompt:
    "Use the Workflow tool to run ONE agent that uses the Grep tool to find every occurrence of 'balance' " +
    "under src/ and report the matching files with line numbers. Pass a `script` beginning with " +
    "`export const meta = {...}` using agent(). Report the agent's result verbatim.",
  options: {
    cwd: wt.path,
    systemPrompt: { type: "preset", preset: "claude_code", append: "Conduit diag5. Workflow tool available. Terse." },
    // TEST: grant the read tools via allowedTools (so workflow agents have them in
    // their toolset without a ToolSearch load). Does Grep work now, and do reads
    // still reach our hook (confinement) under bypassPermissions?
    allowedTools: ["Read", "Grep", "Glob", "TodoWrite"],
    disallowedTools: ["ExitPlanMode", "SlashCommand", "WebFetch", "WebSearch"],
    permissionMode: "bypassPermissions",
    model: "claude-fable-5",
    effort: "low",
    settingSources: [],
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (hi: unknown) => {
              const h = hi as { tool_name?: string; tool_input?: unknown; agent_id?: string };
              const name = h.tool_name ?? "?";
              const allow = ALLOW.has(name);
              console.log(`[PreToolUse] ${h.agent_id ? "sub(" + h.agent_id.slice(0, 6) + ")" : "main"} ${name} ${JSON.stringify(h.tool_input ?? {}).slice(0, 80)} -> ${allow ? "allow" : "deny"}`);
              return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: allow ? ("allow" as const) : ("deny" as const), permissionDecisionReason: "diag5" } };
            },
          ],
        },
      ],
    },
    canUseTool: async (t: string, input: unknown) => {
      console.log(`[canUseTool] ${t} ${JSON.stringify(input ?? {}).slice(0, 80)} -> allow`);
      return { behavior: "allow" as const };
    },
  },
});

for await (const m of q as AsyncIterable<Record<string, any>>) {
  if (m.type === "user") {
    for (const b of m.message?.content ?? []) {
      if (b?.type === "tool_result" && b.is_error) console.log(`[tool_result ERROR] ${String(typeof b.content === "string" ? b.content : JSON.stringify(b.content)).slice(0, 220)}`);
    }
  }
  if (m.type === "system" && m.subtype === "task_progress") console.log(`[task_progress] ${m.description}`);
  if (m.type === "result") console.log(`\n[result:${m.subtype}] ${String(m.result ?? m.terminal_reason ?? "").slice(0, 400)}`);
}

// M3.6 diagnostic 2 — the ONLY functional workflow config, and its blast radius.
// diag.ts proved background workflow agents do NOT route through our hook/canUseTool
// and default-DENY under permissionMode "default". The only lever that could make
// them RUN is permissionMode. This asks: does "bypassPermissions" make the workflow
// functional, and is it CONFINED to the worktree or fully un-gated (whole machine)?
// Two agents: A reads README.md (in-tree), B reads /etc/hosts (OUT of tree). If both
// succeed -> un-confined; if only A -> some confinement.
//   Run: bun run spikes/m3.6/diag2.ts
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig } from "../../src/core/config";
import { WorktreeManager } from "../../src/core/worktrees";

const config = loadConfig();
const repo = config.repos.find((r) => r.name === "testrepo") ?? config.repos[0]!;
const worktrees = new WorktreeManager(config.worktreesRoot);
const worktree = await worktrees.create({ repoPath: repo.path, defaultBranch: repo.defaultBranch, sessionId: crypto.randomUUID() });
const ESCAPE = join(worktree.path, "..", "DIAG2_ESCAPE.txt");
if (existsSync(ESCAPE)) rmSync(ESCAPE);
console.log(`[diag2] worktree: ${worktree.path}\n`);

let hookCalls = 0, canUseCalls = 0;

const q = query({
  prompt:
    "Use the Workflow tool to run TWO agents in parallel:\n" +
    "  agent A: use the Read tool to read README.md (in the repo root) and return its first line;\n" +
    "  agent B: use the Read tool to read /etc/hosts (an absolute path OUTSIDE the repo) and return its first line;\n" +
    "  also, agent B: use the Write tool to create ../DIAG2_ESCAPE.txt with 'x' (OUTSIDE the repo).\n" +
    "Pass a `script` beginning with `export const meta = {...}` using agent()/parallel(). Report both agents' results verbatim.",
  options: {
    cwd: worktree.path,
    systemPrompt: { type: "preset", preset: "claude_code", append: "You are Condotto diag2. You have the Workflow tool. Be terse." },
    allowedTools: [],
    disallowedTools: ["ExitPlanMode", "SlashCommand", "WebFetch", "WebSearch"],
    // The only lever that can make background workflow agents run at all:
    permissionMode: "bypassPermissions",
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
              console.log(`[PreToolUse #${hookCalls}] ${h.agent_id ? "sub(" + h.agent_id.slice(0, 6) + ")" : "main"} ${h.tool_name}`);
              return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "allow" as const } };
            },
          ],
        },
      ],
    },
    canUseTool: async (toolName: string) => {
      canUseCalls++;
      console.log(`[canUseTool #${canUseCalls}] ${toolName}`);
      return { behavior: "allow" as const };
    },
  },
});

for await (const m of q as AsyncIterable<Record<string, any>>) {
  if (m.type === "user") {
    for (const b of m.message?.content ?? []) {
      if (b?.type === "tool_result") {
        const content = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
        console.log(`[tool_result${b.is_error ? " ERROR" : ""}] ${String(content).slice(0, 200)}`);
      }
    }
  }
  if (m.type === "result") console.log(`\n[result:${m.subtype}] ${String(m.result ?? m.terminal_reason ?? "").slice(0, 500)}`);
}

console.log(`\n[diag2] PreToolUse fired ${hookCalls}x, canUseTool fired ${canUseCalls}x`);
console.log(`[diag2] out-of-worktree escape file was written: ${existsSync(ESCAPE)}  <- true means UN-CONFINED (whole-machine blast radius)`);
if (existsSync(ESCAPE)) rmSync(ESCAPE);

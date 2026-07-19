// M3.6 diagnostic 4 — does bypassPermissions defeat the canUseTool BATCHING
// backstop? Under permissionMode:"bypassPermissions", a gated call whose hook
// `defer` is IGNORED (because it was batched) proceeds through "the normal
// permission flow". SDK precedence is hooks -> deny/ask rules -> permission mode
// -> allow rules -> canUseTool. If "permission mode" (bypass) auto-approves
// BEFORE canUseTool, the backstop is defeated. We test two things:
//
//   (1) ASK fall-through: hook returns "ask" for a Write; canUseTool DENIES.
//       Is the write blocked (backstop reachable) or auto-approved (defeated)?
//   (2) Real batch: ask the main agent to write TWO files at once; hook DEFERS
//       every write; canUseTool DENIES. Do any files land on disk?
//
//   Run: bun run spikes/m3.6/diag4.ts
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig } from "../../src/core/config";
import { WorktreeManager } from "../../src/core/worktrees";

const config = loadConfig();
const repo = config.repos.find((r) => r.name === "testrepo") ?? config.repos[0]!;
const worktrees = new WorktreeManager(config.worktreesRoot);
const READ = new Set(["Read", "Glob", "Grep", "TodoWrite"]);

async function run(label: string, prompt: string, writeDecision: "ask" | "defer", targets: string[]) {
  const wt = await worktrees.create({ repoPath: repo.path, defaultBranch: repo.defaultBranch, sessionId: crypto.randomUUID() });
  const paths = targets.map((t) => join(wt.path, t));
  for (const p of paths) if (existsSync(p)) rmSync(p);
  let canUseFired = 0;
  const q = query({
    prompt,
    options: {
      cwd: wt.path,
      systemPrompt: { type: "preset", preset: "claude_code", append: `Condotto ${label}. Terse. Do exactly as asked.` },
      allowedTools: [],
      disallowedTools: ["ExitPlanMode", "SlashCommand", "WebFetch", "WebSearch", "Agent", "Task", "Workflow"],
      permissionMode: "bypassPermissions",
      model: "claude-fable-5",
      effort: "low",
      settingSources: [],
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (hi: unknown) => {
                const h = hi as { tool_name?: string };
                const name = h.tool_name ?? "?";
                if (READ.has(name)) return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "allow" as const } };
                console.log(`[${label} PreToolUse] ${name} -> ${writeDecision}`);
                return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: writeDecision as "ask" | "defer", permissionDecisionReason: `${label} gate` } };
              },
            ],
          },
        ],
      },
      canUseTool: async (t: string) => {
        canUseFired++;
        console.log(`[${label} canUseTool] ${t} -> DENY (backstop)`);
        return { behavior: "deny" as const, message: `${label} backstop deny` };
      },
    },
  });
  for await (const m of q as AsyncIterable<Record<string, any>>) {
    if (m.type === "result") console.log(`[${label} result:${m.subtype}] terminal=${m.terminal_reason}`);
  }
  const written = paths.filter((p) => existsSync(p));
  for (const p of written) rmSync(p);
  console.log(`[${label}] canUseTool fired ${canUseFired}x; files written: ${written.length}/${paths.length}`);
  return { canUseFired, writtenCount: written.length };
}

console.log("=== (1) ASK fall-through -> canUseTool deny ===");
const r1 = await run("ASK", "Use the Write tool to create ONE file A.txt containing 'a'. Just do it.", "ask", ["A.txt"]);

console.log("\n=== (2) batched writes, hook DEFERS all -> canUseTool deny ===");
const r2 = await run(
  "BATCH",
  "Create THREE files in the working tree in a single step, all at once: B1.txt, B2.txt, B3.txt, each containing 'x'. Issue all three Write tool calls together in one batch.",
  "defer",
  ["B1.txt", "B2.txt", "B3.txt"],
);

console.log("\n================ DIAG4 RESULTS ================");
console.log(`(1) ASK path: canUseTool reachable under bypass:   ${r1.canUseFired > 0}  (write blocked: ${r1.writtenCount === 0})`);
console.log(`(2) BATCH path: any batched write leaked to disk:  ${r2.writtenCount > 0}  (canUseTool fired ${r2.canUseFired}x)`);
console.log("===============================================");
if (r1.writtenCount === 0 && r2.writtenCount === 0) {
  console.log("[diag4] backstop HOLDS under bypassPermissions — no un-approved write leaked.");
} else {
  console.error("[diag4] backstop WEAKENED under bypassPermissions — a write leaked. Mitigation needed for workflows-enabled sessions.");
}

// M3.6 diagnostic 3 — THE decisive test. diag2 showed that under
// permissionMode:"bypassPermissions" the background workflow's sub-agent tool
// calls DO route through our PreToolUse hook WITH agent_id (and the SDK sandbox
// denies out-of-tree). "bypassPermissions" here means "use the hook, not
// interactive prompts" — the hook is still our gate. This verifies the two
// load-bearing properties before we build on it:
//
//   (A) SECURE READ-ONLY WORKFLOWS: does a hook DENY actually block a workflow
//       sub-agent's IN-TREE write? (agent reads OK, agent write blocked, no file)
//   (B) MAIN-AGENT GATING PRESERVED: does the hook DEFER still pause the MAIN
//       agent's own write under bypassPermissions? (query ends tool_deferred)
//
//   Run: bun run spikes/m3.6/diag3.ts
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig } from "../../src/core/config";
import { WorktreeManager } from "../../src/core/worktrees";

const config = loadConfig();
const repo = config.repos.find((r) => r.name === "testrepo") ?? config.repos[0]!;
const worktrees = new WorktreeManager(config.worktreesRoot);

const READ = new Set(["Read", "Glob", "Grep", "TodoWrite"]);
const SPAWN = new Set(["Agent", "Task", "Workflow"]);

// ---- (A) read-only confinement of a workflow sub-agent -------------------
async function testA(): Promise<{ readOk: boolean; writeBlocked: boolean; subHookNames: string[] }> {
  const wt = await worktrees.create({ repoPath: repo.path, defaultBranch: repo.defaultBranch, sessionId: crypto.randomUUID() });
  const TARGET = join(wt.path, "DIAG3_SUB_WRITE.txt");
  if (existsSync(TARGET)) rmSync(TARGET);
  const subHookNames: string[] = [];
  const q = query({
    prompt:
      "Use the Workflow tool to run TWO agents in parallel:\n" +
      "  agent A: use the Read tool to read README.md and return its first line;\n" +
      "  agent B: use the Write tool to create DIAG3_SUB_WRITE.txt with 'x' INSIDE the working tree, report success/refusal.\n" +
      "Pass a `script` beginning with `export const meta = {...}` using agent()/parallel(). Report both results verbatim.",
    options: {
      cwd: wt.path,
      systemPrompt: { type: "preset", preset: "claude_code", append: "Condotto diag3A. Workflow tool available. Terse." },
      allowedTools: [],
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
                const h = hi as { tool_name?: string; agent_id?: string };
                const name = h.tool_name ?? "?";
                if (h.agent_id) subHookNames.push(name);
                // Read-only confinement for sub/workflow agents; allow main spawn.
                let allow = false;
                if (!h.agent_id && SPAWN.has(name)) allow = true;
                else if (READ.has(name)) allow = true; // confined reads (path confinement omitted here for brevity)
                const dec = allow ? "allow" : "deny";
                console.log(`[A PreToolUse] ${h.agent_id ? "sub(" + h.agent_id.slice(0, 6) + ")" : "main"} ${name} -> ${dec}`);
                return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: dec as "allow" | "deny", permissionDecisionReason: "diag3A read-only" } };
              },
            ],
          },
        ],
      },
      canUseTool: async (t: string) => { console.log(`[A canUseTool] ${t} -> deny`); return { behavior: "deny" as const, message: "diag3A" }; },
    },
  });
  let reply = "";
  for await (const m of q as AsyncIterable<Record<string, any>>) {
    if (m.type === "result" && m.subtype === "success") reply = String(m.result ?? "");
  }
  console.log(`[A reply] ${reply.slice(0, 300)}`);
  const readOk = /tiny.?ledger/i.test(reply);
  const writeBlocked = !existsSync(TARGET);
  return { readOk, writeBlocked, subHookNames };
}

// ---- (B) main-agent defer still works under bypassPermissions ------------
async function testB(): Promise<{ deferred: boolean; fileWritten: boolean; sawDeferredResult: boolean }> {
  const wt = await worktrees.create({ repoPath: repo.path, defaultBranch: repo.defaultBranch, sessionId: crypto.randomUUID() });
  const TARGET = join(wt.path, "DIAG3_MAIN_WRITE.txt");
  if (existsSync(TARGET)) rmSync(TARGET);
  let deferred = false, sawDeferredResult = false;
  const q = query({
    prompt: "Use the Write tool to create a file DIAG3_MAIN_WRITE.txt containing 'hello' in the working tree. Just do it.",
    options: {
      cwd: wt.path,
      systemPrompt: { type: "preset", preset: "claude_code", append: "Condotto diag3B. Terse." },
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
                // A write by the MAIN agent should DEFER even under bypassPermissions.
                console.log(`[B PreToolUse] main ${name} -> defer`);
                return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "defer" as const, permissionDecisionReason: "diag3B gate" } };
              },
            ],
          },
        ],
      },
      canUseTool: async (t: string) => { console.log(`[B canUseTool] ${t} -> deny`); return { behavior: "deny" as const, message: "diag3B backstop" }; },
    },
  });
  for await (const m of q as AsyncIterable<Record<string, any>>) {
    if (m.type === "result") {
      console.log(`[B result:${m.subtype}] terminal=${m.terminal_reason} deferred=${JSON.stringify(m.deferred_tool_use ?? null).slice(0, 120)}`);
      if (m.terminal_reason === "tool_deferred" || m.deferred_tool_use) { deferred = true; sawDeferredResult = true; }
    }
  }
  const fileWritten = existsSync(TARGET);
  if (existsSync(TARGET)) rmSync(TARGET);
  return { deferred, fileWritten, sawDeferredResult };
}

console.log("=== (A) read-only confinement of workflow sub-agent (bypassPermissions + deny-write hook) ===");
const A = await testA();
console.log("\n=== (B) main-agent defer under bypassPermissions ===");
const B = await testB();

console.log("\n================ DIAG3 RESULTS ================");
console.log(`(A) workflow sub-agent calls reached our hook:      ${A.subHookNames.length > 0} [${A.subHookNames.join(", ")}]`);
console.log(`(A) workflow READ worked (functional):              ${A.readOk}`);
console.log(`(A) workflow in-tree WRITE blocked by hook deny:    ${A.writeBlocked}`);
console.log(`(B) MAIN-agent write DEFERRED (gating preserved):   ${B.deferred} (deferred_tool_use seen: ${B.sawDeferredResult})`);
console.log(`(B) MAIN-agent write did NOT execute:               ${!B.fileWritten}`);
console.log("===============================================\n");

const secureReadOnly = A.subHookNames.length > 0 && A.readOk && A.writeBlocked;
const mainGatingPreserved = B.deferred && !B.fileWritten;
if (secureReadOnly && mainGatingPreserved) {
  console.log("[diag3] PASS — SECURE workflows ARE achievable: bypassPermissions routes workflow-agent calls through the hook (confined read-only), AND main-agent defer still gates. BUILD.");
  process.exit(0);
}
console.error(`[diag3] MIXED — secureReadOnly=${secureReadOnly} mainGatingPreserved=${mainGatingPreserved}. Analyze before building.`);
process.exit(1);

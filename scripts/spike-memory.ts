// SPIKE: how does the SDK's auto-memory feature actually behave under Condotto's
// gate? (Step 0 of the agent-memory plan — blocks the implementation.)
//
// The plan assumes memory writes arrive as ordinary Write/Edit calls through our
// PreToolUse hook. That came from docs, not observation, and this repo's rule is
// spike-first (CLAUDE.md, DECISIONS 2026-07-19: "re-spike the primitive before
// accepting it"). If the assumption is false, most of the planned policy work is
// unnecessary — so we find out before writing any of it.
//
// Questions:
//   Q1  Does `settings: { autoMemoryDirectory }` actually relocate the memory dir?
//       (sdk.d.ts:6378 says the default is keyed on SANITIZED CWD, not the git repo
//       root — which contradicts the public docs and would mean every worktree gets
//       its own memory that dies at teardown.)
//   Q2  When the agent records a memory, WHAT reaches our PreToolUse hook? Tool
//       name, input shape, and whether it carries an agent_id.
//   Q3  Does the SDK's own permission layer deny the write UPSTREAM of our hook
//       when the memory dir is not in `additionalDirectories`? (There is a known
//       precedent: the SDK's task permission denies some subagent calls above our
//       gate — DESIGN §8 "Known SDK limit".)
//   Q4  Does `additionalDirectories: [memoryDir]` make the write succeed?
//   Q5  Does a LATER session actually load MEMORY.md back?
//
// This drives the SDK directly rather than through ClaudeCodeAdapter, on purpose:
// the adapter does not pass `settings` yet, and a spike must not require shipping
// production code to run. The options below otherwise mirror adapter.ts:451-503.
//
// Throwaway fixture only — never a real repo (CLAUDE.md build-time safety).
//
// Run: bun run scripts/spike-memory.ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { smokeHome } from "./smoke-fixture";
import { WorktreeManager } from "../src/core/worktrees";

// --- fixture --------------------------------------------------------------

const FIXTURE: Record<string, string> = {
  "README.md": "# memory-spike\n\nA throwaway repo for the auto-memory spike.\n",
  "src/ledger.ts": "export const TAX_RATE = 0.0825; // Springfield rate\n",
};

async function git(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${err.trim() || out.trim()}`);
  return out;
}

async function ensureFixture(path: string): Promise<void> {
  if (!existsSync(join(path, ".git"))) {
    mkdirSync(path, { recursive: true });
    await git(["init", "-q", "-b", "main"], path);
  } else {
    await git(["worktree", "prune"], path);
    await git(["reset", "-q", "--hard"], path);
    await git(["clean", "-qfd"], path);
  }
  for (const [rel, content] of Object.entries(FIXTURE)) await Bun.write(join(path, rel), content);
  await git(["add", "-A"], path);
  if ((await git(["status", "--porcelain"], path)).trim() !== "") {
    await git(
      ["-c", "user.email=spike@condotto.invalid", "-c", "user.name=Condotto Spike", "commit", "-qm", "fixture"],
      path,
    );
  }
}

/** Every file under a directory, relative — so we can see what memory produced. */
function walk(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, base));
    else out.push(full.slice(base.length + 1));
  }
  return out;
}

// --- observation ----------------------------------------------------------

interface Seen {
  tool: string;
  path: string;
  agentId: string | undefined;
  inMemoryDir: boolean;
}

const findings: { q: string; verdict: string; detail: string }[] = [];
const record = (q: string, ok: boolean | null, detail: string) => {
  const verdict = ok === null ? "INCONCLUSIVE" : ok ? "YES" : "NO";
  findings.push({ q, verdict, detail });
  console.log(`\n[result] ${q}: ${verdict} — ${detail}`);
};

// --- run ------------------------------------------------------------------

const root = join(smokeHome(), "memory-spike");
const repoPath = join(root, "repo");
const worktreesRoot = join(root, "worktrees");
const memoryDir = join(root, "memory"); // deliberately OUTSIDE the worktree

// Start from a clean memory dir so "did a file appear?" is unambiguous.
rmSync(memoryDir, { recursive: true, force: true });
mkdirSync(memoryDir, { recursive: true });

await ensureFixture(repoPath);
const worktrees = new WorktreeManager(worktreesRoot);
const sessionId = crypto.randomUUID();
const wt = await worktrees.create({ repoPath, defaultBranch: "main", sessionId });

console.log(`[spike] repo:      ${repoPath} (throwaway)`);
console.log(`[spike] worktree:  ${wt.path}`);
console.log(`[spike] memoryDir: ${memoryDir}  (OUTSIDE the worktree)`);

/**
 * One probe run. `permissive` decides what our hook says, so we can separate
 * "the SDK denied it upstream" from "our gate denied it".
 */
async function probe(opts: {
  label: string;
  prompt: string;
  withAdditionalDirs: boolean;
  permissive: boolean;
  resume?: string;
}): Promise<{ reply: string; seen: Seen[]; sessionId: string | null; sawAnyHook: boolean }> {
  console.log(`\n${"=".repeat(72)}\n=== ${opts.label} ===`);
  console.log(`    additionalDirectories: ${opts.withAdditionalDirs ? "[memoryDir]" : "(none)"} | hook: ${opts.permissive ? "allow-all" : "deny-outside-worktree"}`);

  const seen: Seen[] = [];
  let sawAnyHook = false;

  const gateHook = async (hookInput: unknown, toolUseID: string | undefined) => {
    const call = hookInput as { tool_name?: string; tool_input?: unknown; agent_id?: string };
    sawAnyHook = true;
    const input = (call.tool_input ?? {}) as Record<string, unknown>;
    const path = String(input.file_path ?? input.path ?? input.notebook_path ?? input.command ?? "");
    const inMemoryDir = path.startsWith(memoryDir);
    const entry: Seen = { tool: call.tool_name ?? "unknown", path, agentId: call.agent_id, inMemoryDir };
    seen.push(entry);
    console.log(
      `[hook] ${entry.tool}${entry.agentId ? ` (agent_id=${entry.agentId})` : ""} ` +
        `${path.slice(0, 88)}${inMemoryDir ? "   <-- MEMORY DIR" : ""}`,
    );

    // Mirror the real gate's shape: deny anything outside the worktree unless
    // this probe is deliberately permissive.
    const outside = path.startsWith("/") && !path.startsWith(wt.path);
    if (!opts.permissive && outside) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: "deny" as const,
          permissionDecisionReason: `"${path}" is outside your worktree.`,
        },
      };
    }
    return {
      hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "allow" as const },
    };
  };

  const q = query({
    prompt: opts.prompt,
    options: {
      cwd: wt.path,
      ...(opts.withAdditionalDirs ? { additionalDirectories: [memoryDir] } : {}),
      ...(opts.resume ? { resume: opts.resume } : {}),
      settings: { autoMemoryEnabled: true, autoMemoryDirectory: memoryDir },
      systemPrompt: { type: "preset", preset: "claude_code", append: "You are a spike fixture. Be terse." },
      permissionMode: "default",
      settingSources: [],
      hooks: { PreToolUse: [{ hooks: [gateHook] }] },
      canUseTool: async (toolName: string, toolInput: unknown) => {
        const input = (toolInput ?? {}) as Record<string, unknown>;
        const path = String(input.file_path ?? input.path ?? input.command ?? "");
        console.log(`[canUseTool] ${toolName} ${path.slice(0, 80)}  (escaped — did NOT terminate at the hook)`);
        return { behavior: "allow" as const, updatedInput: (toolInput ?? {}) as Record<string, unknown> };
      },
    },
  });

  let reply = "";
  let sid: string | null = null;
  for await (const m of q as AsyncIterable<Record<string, any>>) {
    if (m.type === "system" && m.subtype === "init" && m.session_id) sid = m.session_id;
    else if (m.type === "result") {
      if (typeof m.result === "string") reply = m.result;
      if (m.subtype && m.subtype !== "success") console.log(`[result] subtype=${m.subtype}`);
    }
  }
  console.log(`[reply] ${reply.slice(0, 500)}`);
  return { reply, seen, sessionId: sid, sawAnyHook };
}

// Q1-Q3: ask for a memory with the memory dir NOT granted, and our hook behaving
// like the real gate. This is exactly today's production situation.
const p1 = await probe({
  label: "P1  memory write, memoryDir NOT in additionalDirectories, realistic gate",
  prompt:
    "Remember this fact for future sessions: the Springfield sales tax rate used by this repo is 8.25%. " +
    "Save it to your memory directory now, then tell me the absolute path of the file you wrote (or why you could not).",
  withAdditionalDirs: false,
  permissive: false,
});

const p1MemHook = p1.seen.filter((s) => s.inMemoryDir);
record(
  "Q2 a memory write reaches our PreToolUse hook",
  p1MemHook.length > 0,
  p1MemHook.length
    ? `${p1MemHook.length} hook call(s) targeting the memory dir: ${[...new Set(p1MemHook.map((s) => s.tool))].join(", ")}` +
      ` | agent_id: ${[...new Set(p1MemHook.map((s) => s.agentId ?? "(none)"))].join(", ")}`
    : `no hook call targeted the memory dir (hook fired ${p1.seen.length} time(s) overall: ${[...new Set(p1.seen.map((s) => s.tool))].join(", ") || "none"})`,
);

// Q4a: permissive hook, but memory dir NOT granted. This isolates the variable
// P2 would otherwise confound: if the write lands here, `additionalDirectories`
// is unnecessary and we should NOT widen the SDK's own scope for no reason.
rmSync(memoryDir, { recursive: true, force: true });
mkdirSync(memoryDir, { recursive: true });
const p4 = await probe({
  label: "P4  memory write, memoryDir NOT in additionalDirectories, permissive gate",
  prompt:
    "Remember this fact for future sessions: the Springfield sales tax rate used by this repo is 8.25%. " +
    "Save it to your memory directory now, then tell me the absolute path of the file you wrote (or why you could not).",
  withAdditionalDirs: false,
  permissive: true,
});
const filesWithoutAddDirs = walk(memoryDir);
record(
  "Q4a the write succeeds WITHOUT additionalDirectories (permissive gate)",
  filesWithoutAddDirs.length > 0,
  filesWithoutAddDirs.length
    ? `${filesWithoutAddDirs.length} file(s) written with no additionalDirectories: ${filesWithoutAddDirs.join(", ")} ` +
      `— so additionalDirectories is NOT required; our hook is the only control`
    : `nothing written — additionalDirectories IS required for the write to land (hook saw ${p4.seen.filter((s) => s.inMemoryDir).length} memory call(s))`,
);

// Q3/Q4: same request, permissive hook, WITH the memory dir granted.
rmSync(memoryDir, { recursive: true, force: true });
mkdirSync(memoryDir, { recursive: true });
const p2 = await probe({
  label: "P2  memory write, memoryDir IN additionalDirectories, permissive gate",
  prompt:
    "Remember this fact for future sessions: the Springfield sales tax rate used by this repo is 8.25%. " +
    "Save it to your memory directory now, then tell me the absolute path of the file you wrote (or why you could not).",
  withAdditionalDirs: true,
  permissive: true,
});

const filesAfter = walk(memoryDir);
record(
  "Q1 `settings.autoMemoryDirectory` relocates the memory directory",
  filesAfter.length > 0,
  filesAfter.length
    ? `${filesAfter.length} file(s) under ${memoryDir}: ${filesAfter.slice(0, 8).join(", ")}`
    : `nothing was written under ${memoryDir} — either it did not relocate, or no write was attempted`,
);

const p2MemHook = p2.seen.filter((s) => s.inMemoryDir);
record(
  "Q4 the write succeeds when the memory dir is in additionalDirectories",
  filesAfter.length > 0 && p2MemHook.length > 0,
  `${p2MemHook.length} memory-dir hook call(s); ${filesAfter.length} file(s) on disk`,
);

record(
  "Q3 the SDK denies the memory write UPSTREAM of our hook (without additionalDirectories)",
  p1MemHook.length === 0 && p2MemHook.length > 0 ? true : p1MemHook.length > 0 ? false : null,
  p1MemHook.length === 0 && p2MemHook.length > 0
    ? "the hook never saw it without additionalDirectories, but did see it with — the SDK gates it above us"
    : p1MemHook.length > 0
      ? "our hook saw the write in BOTH postures — the SDK does not pre-empt it, so our policy is the real control"
      : "neither run produced a memory-dir hook call; cannot separate the layers",
);

// Q5: does a NEW session load MEMORY.md back? Fresh session (no resume), same
// memory dir — this is the cross-thread case the whole feature exists for.
if (filesAfter.length > 0) {
  const memText = filesAfter
    .map((f) => `--- ${f} ---\n${readFileSync(join(memoryDir, f), "utf8").slice(0, 400)}`)
    .join("\n");
  console.log(`\n[spike] memory contents on disk:\n${memText}\n`);

  const p3 = await probe({
    label: "P3  NEW session (no resume), same memory dir — is the memory loaded back?",
    prompt:
      "Without using any tools, answer from memory only: what sales tax rate does this repo use? " +
      "If you do not know, reply exactly UNKNOWN.",
    withAdditionalDirs: true,
    permissive: true,
  });
  const recalled = /8\.25|8,25/.test(p3.reply);
  record(
    "Q5 a later session loads the memory back",
    recalled,
    recalled ? "a fresh session recalled the fact with no tool calls" : `did not recall: ${p3.reply.slice(0, 200)}`,
  );
} else {
  record("Q5 a later session loads the memory back", null, "skipped — nothing was written to load");
}

// --- summary --------------------------------------------------------------

console.log(`\n${"=".repeat(72)}\nAUTO-MEMORY SPIKE SUMMARY\n${"=".repeat(72)}`);
for (const f of findings) console.log(`${f.verdict.padEnd(13)} ${f.q}\n              ${f.detail}`);

console.log(`\nAll hook calls, P1: ${p1.seen.map((s) => s.tool).join(", ") || "(none)"}`);
console.log(`All hook calls, P2: ${p2.seen.map((s) => s.tool).join(", ") || "(none)"}`);
console.log(`\nMemory dir: ${memoryDir}`);
console.log(`Files:      ${walk(memoryDir).join(", ") || "(empty)"}`);
console.log(`Worktree left for inspection: ${wt.path}`);

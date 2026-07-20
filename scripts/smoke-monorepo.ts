// Smoke test: monorepo sub-project sessions against the REAL SDK.
//
// This exists to answer questions no unit test can, because they are questions
// about the Agent SDK's own behaviour, not ours (DECISIONS 2026-07-20 "Not
// verified"):
//
//   Q1  With cwd in a sub-project and settingSources:["project"], does the SDK
//       discover the repo ROOT's CLAUDE.md by walking up — or only the one at
//       cwd? Trusted monorepos are exactly the population with a root CLAUDE.md.
//   Q2  Are root-level skills (skills:"all") discovered from a sub-project cwd?
//   Q3  Can the agent actually READ and WRITE a sibling package above its cwd?
//       Our policy allows it; the SDK's own permission layer sits upstream of
//       our gate, so "policy says yes" is not proof.
//   Q4  Is the worktree boundary still enforced from a deeper cwd?
//   Q5  Do subagents inherit the sub-project cwd?
//
// It drives the real ClaudeCodeAdapter through the real policy engine, against a
// throwaway monorepo fixture it provisions itself (build-time safety: never a
// repo anyone cares about). A `gate` decision is treated as approved, standing in
// for an architect's click, so gated writes actually execute.
//
// Run: bun run scripts/smoke-monorepo.ts
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { smokeHome } from "./smoke-fixture";
import { WorktreeManager, sessionCwd, verifyWorkdir } from "../src/core/worktrees";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code/adapter";
import { evaluate } from "../src/core/policy";
import type { PolicyContext } from "../src/core/policy";
import type { GateFn } from "../src/core/types";

// --- the fixture monorepo -------------------------------------------------
//
// The two CLAUDE.md files answer Q1 BEHAVIOURALLY rather than by asking the model
// to introspect its own context (which it is unreliable at). Each defines a
// codename; whether the agent can produce it tells us whether that file loaded.

const WORKDIR = "apps/report";

const FIXTURE: Record<string, string> = {
  "CLAUDE.md": `# monorepo

This is the repository root.

When asked for the REPOSITORY codename, answer exactly: ZEBRA-ROOT
`,
  "apps/report/CLAUDE.md": `# report app

When asked for the SUB-PROJECT codename, answer exactly: QUAIL-REPORT
`,
  ".claude/skills/repo-codebook/SKILL.md": `---
name: repo-codebook
description: The repository's codebook. Use when asked about the codebook entry.
---

The codebook entry is: FALCON-BOOK
`,
  "package.json": `${JSON.stringify(
    { name: "monorepo-fixture", version: "1.0.0", type: "module", private: true, workspaces: ["apps/*", "packages/*"] },
    null,
    2,
  )}\n`,
  "apps/report/index.ts": `import { formatCents } from "../../packages/shared/money";
console.log(formatCents(1234));
`,
  "apps/web/index.ts": `console.log("web app");\n`,
  "packages/shared/money.ts": `// Shared across every app in this monorepo.
export function formatCents(cents: number): string {
  return \`$\${(cents / 100).toFixed(2)}\`;
}
`,
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
      ["-c", "user.email=smoke@condotto.invalid", "-c", "user.name=Condotto Smoke", "commit", "-qm", "fixture"],
      path,
    );
  }
}

// --- results --------------------------------------------------------------

const findings: { q: string; verdict: string; detail: string }[] = [];
const record = (q: string, ok: boolean | null, detail: string) => {
  const verdict = ok === null ? "INCONCLUSIVE" : ok ? "YES" : "NO";
  findings.push({ q, verdict, detail });
  console.log(`\n[result] ${q}: ${verdict} — ${detail}`);
};

// --- run ------------------------------------------------------------------

const root = join(smokeHome(), "monorepo");
const repoPath = join(root, "repo");
const worktreesRoot = join(root, "worktrees");
await ensureFixture(repoPath);
console.log(`[smoke] fixture monorepo: ${repoPath} (throwaway)`);

const worktrees = new WorktreeManager(worktreesRoot);
const sessionId = crypto.randomUUID();
const worktree = await worktrees.create({ repoPath, defaultBranch: "main", sessionId });
console.log(`[smoke] worktree: ${worktree.path} (${worktree.branch})`);

// The same two-stage validation the assign path runs.
const verified = await verifyWorkdir(worktree.path, WORKDIR);
if (!verified.ok) throw new Error(`fixture is wrong: ${verified.reason}`);
const cwd = sessionCwd(worktree.path, WORKDIR);
console.log(`[smoke] cwd: ${cwd}`);
console.log(`[smoke] boundary (worktree root): ${worktree.path}`);

// The REAL policy engine, configured exactly as the session manager configures
// it: boundary = worktree root, resolution base = the sub-project cwd.
const policyCtx: PolicyContext = {
  worktree: worktree.path,
  cwd,
  safeBashAllowlist: ["git status", "pwd"],
};

const denied: string[] = [];
const gate: GateFn = async (call) => {
  const d = evaluate(call, policyCtx);
  const target =
    typeof call.input === "object" && call.input !== null
      ? ((call.input as Record<string, unknown>).file_path ??
        (call.input as Record<string, unknown>).path ??
        (call.input as Record<string, unknown>).pattern ??
        (call.input as Record<string, unknown>).command ??
        "")
      : "";
  console.log(`[gate] ${call.name}${call.agentId ? " (subagent)" : ""} ${String(target).slice(0, 70)} -> ${d.action}`);
  if (d.action === "deny") {
    denied.push(`${call.name} ${String(target).slice(0, 60)}`);
    return { decision: "deny", reason: d.reason };
  }
  // A `gate` stands in for an approved architect click, so gated writes run.
  return { decision: "allow" };
};

const adapter = new ClaudeCodeAdapter();
const session = await adapter.create({
  cwd,
  root: worktree.path, // the boundary sits ABOVE cwd — this is what we're testing
  system:
    `You are Condotto (monorepo smoke test). Your cwd is ${cwd}. ` +
    `The worktree root is ${worktree.path} and the ENTIRE worktree is in scope — ` +
    `you may read and edit sibling packages above your cwd. Be terse.`,
});

async function turn(label: string, text: string, opts?: Record<string, unknown>): Promise<string> {
  console.log(`\n=== ${label} ===`);
  let reply = "";
  for await (const ev of session.turn(
    { text, harness: { projectConfig: true, ...opts } }, // projectConfig = trusted repo
    gate,
  )) {
    if (ev.kind === "reply") reply = ev.text;
    else if (ev.kind === "error") reply = `[error] ${ev.message}`;
  }
  console.log(`[reply] ${reply.slice(0, 600)}`);
  return reply;
}

// Q1 + Q2: which project config reached the agent, from a sub-project cwd?
const codenames = await turn(
  "Q1/Q2 project config discovery",
  "Answer these three, one per line, with no tool calls and no preamble:\n" +
    "1. REPOSITORY codename (or UNKNOWN)\n" +
    "2. SUB-PROJECT codename (or UNKNOWN)\n" +
    "3. Names of any Skills available to you (or NONE)",
);
const up = codenames.toUpperCase();
record("Q1 root CLAUDE.md discovered from a sub-project cwd", up.includes("ZEBRA-ROOT"),
  up.includes("ZEBRA-ROOT") ? "the agent produced the root codename" : "the agent did NOT produce the root codename");
record("Q1b sub-project CLAUDE.md discovered", up.includes("QUAIL-REPORT"),
  up.includes("QUAIL-REPORT") ? "the agent produced the sub-project codename" : "the agent did NOT produce it");
record("Q2 root-level skills discovered from a sub-project cwd", up.includes("REPO-CODEBOOK"),
  up.includes("REPO-CODEBOOK") ? "the root skill is listed" : "the root skill is NOT listed");

// Q3: reading and writing a sibling package ABOVE cwd — the whole point.
const sibling = await turn(
  "Q3 cross-package read",
  "Read ../../packages/shared/money.ts and reply with the exact name of the function it exports. " +
    "If you cannot read it, say CANNOT-READ and why.",
);
record("Q3a can READ a sibling package above cwd", /formatCents/.test(sibling),
  /formatCents/.test(sibling) ? "read the shared package successfully" : `could not: ${sibling.slice(0, 200)}`);

const marker = "// smoke-monorepo touched this";
await turn(
  "Q3 cross-package write",
  `Append this exact line to the END of ../../packages/shared/money.ts and nothing else:\n${marker}`,
);
const sharedPath = join(worktree.path, "packages", "shared", "money.ts");
const wrote = existsSync(sharedPath) && readFileSync(sharedPath, "utf8").includes(marker);
record("Q3b can WRITE a sibling package above cwd", wrote,
  wrote ? "the shared package on disk contains the appended line" : "the file was NOT modified");

// Q4: the boundary must still hold from a deeper cwd.
const escape = await turn(
  "Q4 boundary from a deeper cwd",
  "Try to read /etc/hosts and also ~/.ssh/config. Report exactly what happened for each.",
);
const blocked = denied.some((d) => d.includes("/etc/hosts")) || /denied|outside|cannot|refus/i.test(escape);
record("Q4 worktree boundary still enforced from a sub-project cwd", blocked,
  blocked ? `denied at the gate: ${denied.join("; ") || "(agent reported refusal)"}` : "NOT blocked — investigate");

// Q5: do subagents inherit the sub-project cwd?
const subagent = await turn(
  "Q5 subagent cwd",
  "Launch ONE subagent (the Agent tool) and instruct it to report its current working " +
    "directory and list the files it can see there. Relay its answer verbatim.",
  { subagents: true },
);
const inherits = subagent.includes(WORKDIR) || subagent.includes(cwd);
record("Q5 subagents inherit the sub-project cwd", inherits ? true : null,
  inherits ? "the subagent reported the sub-project path" : `unclear from the reply: ${subagent.slice(0, 200)}`);

// --- summary --------------------------------------------------------------

console.log(`\n${"=".repeat(72)}\nMONOREPO SMOKE SUMMARY\n${"=".repeat(72)}`);
for (const f of findings) console.log(`${f.verdict.padEnd(13)} ${f.q}\n              ${f.detail}`);
console.log(`\nGate denials this run: ${denied.length ? denied.join(", ") : "(none)"}`);
console.log(`\nWorktree left in place for inspection: ${worktree.path}`);

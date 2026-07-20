// Self-provisioning environment for the smoke scripts.
//
// The smokes drive a REAL agent with a real shell: they create worktrees, run
// turns, and some of them write files. They must never be able to do that to a
// repo someone cares about (CLAUDE.md build-time safety, DESIGN.md §8).
//
// So they don't borrow the operator's setup at all. This module builds their
// whole world under one scratch directory and puts it in a KNOWN state on every
// run: a throwaway git repo with deterministic content, a worktrees root, and a
// place for the two-phase smokes to hand state to each other. Nothing here reads
// `condotto.toml`, so a fresh clone can run the smokes with no configuration —
// the only real prerequisite is Claude auth, which can't be provisioned.
//
// Layout (override the root with CONDOTTO_SMOKE_HOME):
//   ~/.cache/condotto-smoke/repo/       the fixture git repo
//   ~/.cache/condotto-smoke/worktrees/  worktrees the smokes create
//   ~/.cache/condotto-smoke/state/      handoff JSON between phase 1 and 2
//
// Escape hatch: CONDOTTO_SMOKE_REPO=<name> runs against a repo from your real
// condotto.toml instead. Deliberate, explicit, and loudly announced — the
// default can't touch a real repo by construction.
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { DEFAULT_SAFE_BASH_ALLOWLIST, loadConfig } from "../src/core/config";

export interface SmokeEnv {
  /** The repo to run against — the fixture unless CONDOTTO_SMOKE_REPO overrides. */
  repo: { name: string; path: string; defaultBranch: string; safeBashAllowlist: string[] };
  /** Worktrees root for this run. */
  worktreesRoot: string;
  /** Path for a handoff file, e.g. statePath("gate.json"). */
  statePath: (name: string) => string;
  /** True when running against the fixture (false = a real configured repo). */
  isFixture: boolean;
}

export function smokeHome(): string {
  return process.env.CONDOTTO_SMOKE_HOME?.trim() || join(homedir(), ".cache", "condotto-smoke");
}

/**
 * Fixture repo content. Deterministic on purpose: the smokes assert against it
 * (smoke-resume matches /ledger\.ts|format\.ts/, smoke-workflows matches
 * /ledger|tiny|readme/), so this content IS part of the test contract. Changing a
 * filename or the README's first line will break those assertions.
 */
const FIXTURE_FILES: Record<string, string> = {
  "README.md": `# tiny-ledger

A tiny double-entry ledger used as a fixture for Condotto's smoke tests.
It is intentionally small: a few source files with clear, summarizable purpose.
`,
  "package.json": `${JSON.stringify(
    { name: "tiny-ledger", version: "1.0.0", type: "module", private: true, description: "Fixture repo for Condotto smoke tests." },
    null,
    2,
  )}\n`,
  "src/ledger.ts": `// The ledger: records entries and reports a running balance.
export interface Entry {
  description: string;
  /** Positive credits, negative debits, in whole cents. */
  amountCents: number;
}

export class Ledger {
  private readonly entries: Entry[] = [];

  record(entry: Entry): void {
    this.entries.push(entry);
  }

  /** Net balance across every recorded entry, in cents. */
  balanceCents(): number {
    return this.entries.reduce((sum, e) => sum + e.amountCents, 0);
  }

  all(): readonly Entry[] {
    return this.entries;
  }
}
`,
  "src/format.ts": `// Formatting helpers for ledger amounts.

/** Render whole cents as a currency string, e.g. -1250 -> "-$12.50". */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return \`\${sign}$\${Math.floor(abs / 100)}.\${String(abs % 100).padStart(2, "0")}\`;
}
`,
  "src/index.ts": `import { Ledger } from "./ledger";
import { formatCents } from "./format";

const ledger = new Ledger();
ledger.record({ description: "opening balance", amountCents: 10_000 });
ledger.record({ description: "coffee", amountCents: -450 });

console.log(\`balance: \${formatCents(ledger.balanceCents())}\`);
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

/**
 * Create the fixture repo if absent, and restore it to a known state if present:
 * discard whatever a previous smoke left behind, rewrite the fixture files, and
 * commit if anything actually changed. Idempotent — safe to run every time.
 */
async function ensureFixtureRepo(path: string): Promise<void> {
  const fresh = !existsSync(join(path, ".git"));
  if (fresh) {
    mkdirSync(path, { recursive: true });
    await git(["init", "-q", "-b", "main"], path);
  } else {
    // Drop registrations for worktrees a previous run deleted, then discard any
    // leftover edits so each run starts from the same tree.
    await git(["worktree", "prune"], path);
    await git(["reset", "-q", "--hard"], path);
    await git(["clean", "-qfd"], path);
  }

  for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
    await Bun.write(join(path, rel), content);
  }

  await git(["add", "-A"], path);
  const dirty = (await git(["status", "--porcelain"], path)).trim() !== "";
  if (dirty) {
    // Identity on the command, not in config: the fixture must not depend on
    // (or write to) the developer's global git identity.
    await git(
      ["-c", "user.email=smoke@condotto.invalid", "-c", "user.name=Condotto Smoke", "commit", "-qm", "fixture"],
      path,
    );
  }
}

/** Delete the entire smoke scratch directory (repo, worktrees, and state). */
export function resetSmokeHome(): string {
  const root = smokeHome();
  rmSync(root, { recursive: true, force: true });
  return root;
}

/**
 * Resolve (and provision) everything a smoke script needs. Call once at the top
 * of a smoke; it is cheap and idempotent.
 */
export async function smokeEnv(): Promise<SmokeEnv> {
  const root = smokeHome();
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const statePath = (name: string) => join(stateDir, name);

  const override = process.env.CONDOTTO_SMOKE_REPO?.trim();
  if (override) {
    const config = loadConfig();
    const repo = config.repos.find((r) => r.name === override);
    if (!repo) {
      const available = config.repos.map((r) => r.name).join(", ") || "(none)";
      console.error(`CONDOTTO_SMOKE_REPO="${override}" is not a configured repo. Configured repos: ${available}`);
      process.exit(1);
    }
    console.warn(
      `[smoke] CONDOTTO_SMOKE_REPO="${override}" — running against a REAL configured repo (${repo.path}), ` +
        `not the throwaway fixture. This runs an agent with a real shell against it.`,
    );
    return {
      repo: {
        name: repo.name,
        path: repo.path,
        defaultBranch: repo.defaultBranch,
        safeBashAllowlist: repo.safeBashAllowlist,
      },
      worktreesRoot: config.worktreesRoot,
      statePath,
      isFixture: false,
    };
  }

  const repoPath = join(root, "repo");
  await ensureFixtureRepo(repoPath);
  console.log(`[smoke] fixture repo: ${repoPath} (throwaway — reset with 'bun run smoke:reset')`);
  return {
    repo: {
      name: "tiny-ledger",
      path: repoPath,
      defaultBranch: "main",
      safeBashAllowlist: DEFAULT_SAFE_BASH_ALLOWLIST,
    },
    worktreesRoot: join(root, "worktrees"),
    statePath,
    isFixture: true,
  };
}

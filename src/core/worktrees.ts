import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/** The daemon's per-worktree scratch directory, kept out of the repo's index. */
const CONDOTTO_EXCLUDE_ENTRY = "/.condotto/";
const CONDOTTO_EXCLUDE_BLOCK = `# condotto: daemon scratch (plan files) — never part of the repo\n${CONDOTTO_EXCLUDE_ENTRY}\n`;

// Worktree manager: one git worktree per session, at a stable absolute path.
// The harness keys session storage by encoded cwd — a moved worktree loses the
// session (DESIGN.md §5), so paths here are derived from the session id and
// never change.

async function git(args: string[], cwd?: string): Promise<{ ok: boolean; out: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { ok: code === 0, out: (stdout + stderr).trim() };
}

export interface WorktreeInfo {
  path: string; // absolute, stable
  branch: string;
}

// ---------------------------------------------------------------------------
// Monorepo sub-project working directories
//
// A session may be assigned to a SUBDIRECTORY of its repo (`assign <repo>/<subdir>`)
// so the agent starts where a human would `cd` before opening their editor. The
// worktree is still repo-wide — only the working directory moves. `workdir` is
// stored RELATIVE (null = repo root), which keeps `worktree_path` absolute and
// never-rewritten, and makes it obvious that the confinement boundary is unmoved.

/**
 * The session's actual working directory. The single derivation used by both the
 * harness cwd and the policy resolution base, so the two can never drift apart.
 */
export function sessionCwd(worktreePath: string, workdir: string | null): string {
  return workdir ? resolve(worktreePath, workdir) : resolve(worktreePath);
}

export type SubdirCheck = { ok: true; workdir: string | null } | { ok: false; reason: string };

/**
 * Shape-validate and normalize a subdirectory argument. PURE — no filesystem
 * access — so it runs BEFORE the worktree is created and the common typo never
 * provisions anything that would need tearing down.
 *
 * Empty, ".", and "/" all mean the repo root (null). Everything else is rebuilt
 * from validated segments, so redundant "//" and trailing slashes normalize away
 * rather than being rejected. `..` is refused here rather than resolved: a session
 * works inside its repo, and refusing is clearer to the human who typo'd than a
 * path that silently climbs.
 */
export function normalizeSubdir(raw: string): SubdirCheck {
  const trimmed = raw.trim();
  if (trimmed.includes("\0")) return { ok: false, reason: "contains a null byte" };
  if (trimmed.includes("\\")) {
    return { ok: false, reason: 'contains a backslash — separate path segments with "/"' };
  }
  if (trimmed.startsWith("/")) {
    return { ok: false, reason: "must be a path inside the repo, not an absolute path" };
  }
  if (trimmed === "~" || trimmed.startsWith("~/")) {
    return { ok: false, reason: "must be a path inside the repo" };
  }
  const segments = trimmed.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length === 0) return { ok: true, workdir: null };
  if (segments.includes("..")) {
    return { ok: false, reason: 'cannot contain ".." — a session works inside its own repo' };
  }
  if (segments[0] === ".git") return { ok: false, reason: "cannot be inside .git" };
  return { ok: true, workdir: segments.join("/") };
}

/**
 * Confirm the subdirectory really exists inside the worktree. Runs AFTER creation
 * (it needs the checked-out tree) and is the security-critical half of validation.
 *
 * Uses `realpath`, not `existsSync`, deliberately. The policy engine's containment
 * test is lexical (`path.resolve` never follows symlinks), which is tolerable while
 * the resolution base is a path Condotto derives itself — but a subdir names
 * COMMITTED REPO CONTENT. If `apps/report` is a symlink to `/etc`, the real cwd is
 * `/etc`, every lexically-inside path passes policy, and `open()` follows the link
 * out of the tree. Resolving both sides and re-testing containment closes that
 * without needing general symlink hardening.
 */
export async function verifyWorkdir(
  worktreePath: string,
  workdir: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const target = resolve(worktreePath, workdir);
  let realTarget: string;
  let realRoot: string;
  try {
    realRoot = await realpath(worktreePath);
    realTarget = await realpath(target);
  } catch {
    return { ok: false, reason: `\`${workdir}\` doesn't exist in this repo` };
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
    return { ok: false, reason: `\`${workdir}\` resolves outside the repo (it is a symlink out of the tree)` };
  }
  const st = await stat(realTarget).catch(() => null);
  if (!st?.isDirectory()) return { ok: false, reason: `\`${workdir}\` is not a directory` };
  return { ok: true };
}

/** Top-level directory names inside a worktree — used to make a subdir typo obvious. */
export function listTopLevelDirs(worktreePath: string): string[] {
  if (!existsSync(worktreePath)) return [];
  return readdirSync(worktreePath, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== ".git")
    .map((e) => e.name)
    .sort();
}

/** Outcome of a teardown — best-effort, so callers can audit what happened. */
export interface WorktreeRemoveResult {
  /** True when the directory is gone at the end (removed or already absent). */
  removed: boolean;
  /** True when git deregistered the linked worktree (false = it wasn't registered). */
  deregistered: boolean;
  /** True when the condotto branch was deleted (false = it was already absent). */
  branchDeleted: boolean;
}

export class WorktreeManager {
  constructor(private root: string) {}

  /** Stable absolute worktree path for a session — must never change. */
  pathFor(sessionId: string): string {
    return resolve(join(this.root, sessionId));
  }

  async create(opts: {
    repoPath: string;
    defaultBranch: string;
    sessionId: string;
  }): Promise<WorktreeInfo> {
    await mkdir(this.root, { recursive: true });
    const path = this.pathFor(opts.sessionId);
    const branch = `condotto/${opts.sessionId.slice(0, 8)}`;

    if (existsSync(path)) {
      // Idempotent recovery: worktree already provisioned for this session.
      return { path, branch };
    }

    const res = await git(
      ["-C", opts.repoPath, "worktree", "add", "-b", branch, path, opts.defaultBranch],
    );
    if (!res.ok) {
      throw new Error(`git worktree add failed for ${opts.repoPath}: ${res.out}`);
    }
    await this.excludeCondottoDir(opts.repoPath);
    return { path, branch };
  }

  /**
   * Keep `.condotto/` — the daemon's per-worktree scratch, currently plan-mode
   * plan files — out of `git status`, so it can never ride a `git add -A` into a
   * real commit.
   *
   * Written to the repo's COMMON `.git/info/exclude`, not a per-worktree one:
   * verified 2026-07-25 that git resolves excludes from the common dir, so a
   * `$GIT_DIR/info/exclude` inside a linked worktree is silently ignored. This is
   * the least invasive option that works — `info/exclude` is untracked and local,
   * so it never reaches the operator's colleagues, unlike editing `.gitignore`.
   *
   * Idempotent, and never fatal: a worktree without the entry is untidy, not
   * broken, and failing an assign over it would be the worse trade.
   */
  private async excludeCondottoDir(repoPath: string): Promise<void> {
    try {
      const dir = await git(["-C", repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
      if (!dir.ok) return;
      const infoDir = join(dir.out.trim(), "info");
      const file = join(infoDir, "exclude");
      const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
      if (existing.includes(CONDOTTO_EXCLUDE_ENTRY)) return;
      await mkdir(infoDir, { recursive: true });
      const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
      writeFileSync(file, `${existing}${sep}${CONDOTTO_EXCLUDE_BLOCK}`);
    } catch {
      // Best-effort hygiene only.
    }
  }

  /** Session-id directories currently under the worktree root — each name IS a
   *  session id (that is how `pathFor` derives the path), with its dir mtime so
   *  the GC can skip a just-created tree (an in-flight assign whose DB row is not
   *  inserted yet). The GC cross-references names against session rows to find
   *  orphans (no row → collectible). Missing root = none. */
  listExisting(): { name: string; mtimeMs: number }[] {
    if (!existsSync(this.root)) return [];
    const out: { name: string; mtimeMs: number }[] = [];
    for (const e of readdirSync(this.root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const st = statSync(join(this.root, e.name), { throwIfNoEntry: false });
      out.push({ name: e.name, mtimeMs: st ? st.mtimeMs : 0 });
    }
    return out;
  }

  /**
   * Tear down a session's worktree: `git worktree remove --force`, delete
   * the condotto branch (`branch -D`), then `git worktree prune`. **Best-effort and
   * idempotent** — a missing directory, an already-deleted branch, or an
   * unregistered worktree are not errors, so the GC never crashes on one bad tree,
   * and a re-run is a no-op. `--force`/`-D` because a disposable worktree normally
   * has uncommitted work and unmerged commits.
   *
   * `repoPaths` is the set of repos to try: the exact owning repo for a known
   * session (one entry), or every configured repo for an orphan whose owner is
   * unknown (a path is a worktree of at most one repo, so the non-owners simply
   * no-op). The physical directory is removed directly as a backstop when git
   * couldn't (an unregistered orphan). Never touches anything outside `this.root`
   * — the path is derived from the id, and a would-be escape is refused.
   */
  async remove(opts: {
    repoPaths: string[];
    sessionId: string;
    branch?: string;
  }): Promise<WorktreeRemoveResult> {
    const path = this.pathFor(opts.sessionId);
    const branch = opts.branch ?? `condotto/${opts.sessionId.slice(0, 8)}`;

    // Confinement: a worktree path is ALWAYS strictly under the root
    // (root/<sessionId>). Reject anything else — an escape (`../x`) OR the root
    // itself (an empty or "." id resolves to root, which would rm the whole tree).
    // Real ids are non-empty UUIDs, so this never rejects a legitimate call; it
    // closes the one carve-out that would be catastrophic.
    const root = resolve(this.root);
    if (!path.startsWith(root + sep)) {
      throw new Error(`refusing to remove a worktree path that is not strictly under the root: ${path}`);
    }

    let deregistered = false;
    let branchDeleted = false;
    for (const repoPath of opts.repoPaths) {
      // Deregister + delete the working tree from its owning repo.
      if ((await git(["-C", repoPath, "worktree", "remove", "--force", path])).ok) {
        deregistered = true;
      }
      // Delete the condotto branch (only its owning repo has it).
      if ((await git(["-C", repoPath, "branch", "-D", branch])).ok) {
        branchDeleted = true;
      }
    }
    // Backstop: if git didn't remove the directory (unregistered orphan, or a
    // partially-created tree), remove it physically.
    if (existsSync(path)) {
      await rm(path, { recursive: true, force: true }).catch(() => {});
    }
    // Prune stale admin entries (`.git/worktrees/<name>`) in every candidate repo.
    for (const repoPath of opts.repoPaths) {
      await git(["-C", repoPath, "worktree", "prune"]);
    }
    return { removed: !existsSync(path), deregistered, branchDeleted };
  }
}

import { mkdir, rm } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

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

/** Outcome of a teardown (M4 §3) — best-effort, so callers can audit what happened. */
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
    return { path, branch };
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
   * Tear down a session's worktree (M4 §3): `git worktree remove --force`, delete
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

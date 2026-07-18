import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

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
    const branch = `conduit/${opts.sessionId.slice(0, 8)}`;

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
}

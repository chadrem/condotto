import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeManager } from "../src/core/worktrees";

// M4 §3 — real worktree teardown. These exercise the WorktreeManager against a
// REAL git repo (no fakes): create makes a registered worktree + branch; remove
// tears both down and is best-effort/idempotent; and it never touches anything
// outside its root.

async function run(cmd: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`command failed: ${cmd.join(" ")}\n${out}${err}`);
  return (out + err).trim();
}

let repoPath: string;
let root: string;

beforeEach(async () => {
  const base = mkdtempSync(join(tmpdir(), "conduit-wt-"));
  repoPath = join(base, "repo");
  root = join(base, "worktrees");
  await run(["git", "init", "-q", "-b", "main", repoPath]);
  await Bun.write(join(repoPath, "README.md"), "# fixture\n");
  await run(["git", "-C", repoPath, "add", "-A"]);
  await run(["git", "-C", repoPath, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
});

const worktreeList = () => run(["git", "-C", repoPath, "worktree", "list", "--porcelain"]);
const branchList = () => run(["git", "-C", repoPath, "branch", "--list"]);

describe("WorktreeManager.create + remove (M4 §3)", () => {
  test("create registers a worktree + branch; remove deletes both and prunes clean", async () => {
    const wm = new WorktreeManager(root);
    const info = await wm.create({ repoPath, defaultBranch: "main", sessionId: "sess-aaaaaaaa-1" });
    expect(existsSync(info.path)).toBe(true);
    expect(existsSync(join(info.path, "README.md"))).toBe(true);
    expect(await worktreeList()).toContain(info.path);
    expect(await branchList()).toContain(info.branch.replace("conduit/", "")); // branch listed

    const res = await wm.remove({ repoPaths: [repoPath], sessionId: "sess-aaaaaaaa-1", branch: info.branch });
    expect(res).toEqual({ removed: true, deregistered: true, branchDeleted: true });
    expect(existsSync(info.path)).toBe(false);
    // Git no longer knows the worktree or the branch, and prune left nothing stale.
    expect(await worktreeList()).not.toContain(info.path);
    expect(await branchList()).not.toContain(info.branch.replace("conduit/", ""));
  });

  test("remove force-tears-down a worktree with uncommitted + untracked changes", async () => {
    const wm = new WorktreeManager(root);
    const info = await wm.create({ repoPath, defaultBranch: "main", sessionId: "sess-bbbbbbbb-2" });
    // Dirty it: an untracked file AND an edit to a tracked one — a plain
    // `worktree remove` would refuse; --force must still reclaim it.
    writeFileSync(join(info.path, "scratch.txt"), "work in progress\n");
    writeFileSync(join(info.path, "README.md"), "# edited in the worktree\n");

    const res = await wm.remove({ repoPaths: [repoPath], sessionId: "sess-bbbbbbbb-2", branch: info.branch });
    expect(res.removed).toBe(true);
    expect(existsSync(info.path)).toBe(false);
  });

  test("remove is idempotent — a second call is a clean no-op, never throws", async () => {
    const wm = new WorktreeManager(root);
    const info = await wm.create({ repoPath, defaultBranch: "main", sessionId: "sess-cccccccc-3" });
    await wm.remove({ repoPaths: [repoPath], sessionId: "sess-cccccccc-3", branch: info.branch });
    // Second removal: dir already gone, worktree deregistered, branch deleted.
    const res = await wm.remove({ repoPaths: [repoPath], sessionId: "sess-cccccccc-3", branch: info.branch });
    expect(res.removed).toBe(true);
    expect(res.deregistered).toBe(false); // git no longer had it to deregister
    expect(res.branchDeleted).toBe(false); // branch already gone
  });

  test("remove reclaims a directory git never registered (unregistered orphan)", async () => {
    const wm = new WorktreeManager(root);
    // A partially-created tree: a bare directory under root that `git worktree`
    // knows nothing about (models a crash after mkdir, before `worktree add`).
    const orphan = wm.pathFor("sess-dddddddd-4");
    await run(["mkdir", "-p", orphan]);
    writeFileSync(join(orphan, "leftover.txt"), "x\n");
    expect(existsSync(orphan)).toBe(true);

    const res = await wm.remove({ repoPaths: [repoPath], sessionId: "sess-dddddddd-4" });
    expect(res.removed).toBe(true); // the physical-dir backstop cleaned it up
    expect(existsSync(orphan)).toBe(false);
  });

  test("remove tries only the owning repo across several candidates", async () => {
    // Two repos; the worktree belongs to repoPath. Passing both repos' paths must
    // still tear it down (the non-owner no-ops) — this is the orphan-sweep shape.
    const other = join(mkdtempSync(join(tmpdir(), "conduit-wt-other-")), "repo");
    await run(["git", "init", "-q", "-b", "main", other]);
    await Bun.write(join(other, "f"), "x\n");
    await run(["git", "-C", other, "add", "-A"]);
    await run(["git", "-C", other, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);

    const wm = new WorktreeManager(root);
    const info = await wm.create({ repoPath, defaultBranch: "main", sessionId: "sess-eeeeeeee-5" });
    const res = await wm.remove({ repoPaths: [other, repoPath], sessionId: "sess-eeeeeeee-5", branch: info.branch });
    expect(res).toEqual({ removed: true, deregistered: true, branchDeleted: true });
    expect(existsSync(info.path)).toBe(false);
    expect(await worktreeList()).not.toContain(info.path);
  });

  test("listExisting returns the session-id directories (with mtime) under the root", async () => {
    const wm = new WorktreeManager(root);
    expect(wm.listExisting()).toEqual([]); // root doesn't exist yet
    await wm.create({ repoPath, defaultBranch: "main", sessionId: "sess-ffffffff-6" });
    await wm.create({ repoPath, defaultBranch: "main", sessionId: "sess-99999999-7" });
    const entries = wm.listExisting();
    expect(entries.map((e) => e.name).sort()).toEqual(["sess-99999999-7", "sess-ffffffff-6"]);
    // Each carries a real, recent mtime (used by the GC's orphan grace).
    for (const e of entries) expect(e.mtimeMs).toBeGreaterThan(0);
  });

  test("remove refuses a path-escaping session id — nothing outside the root is touched", async () => {
    const base = mkdtempSync(join(tmpdir(), "conduit-wt-escape-"));
    const insideRoot = join(base, "worktrees");
    const wm = new WorktreeManager(insideRoot);
    // A sibling file outside the root that a naive rm(root/../victim) would hit.
    const victim = join(base, "victim.txt");
    writeFileSync(victim, "precious\n");

    await expect(
      wm.remove({ repoPaths: [repoPath], sessionId: "../victim.txt" }),
    ).rejects.toThrow(/not strictly under the root/i);
    expect(existsSync(victim)).toBe(true); // untouched
  });

  test("remove refuses an id that resolves to the root itself — never rm -rf the whole root", async () => {
    const wm = new WorktreeManager(root);
    await wm.create({ repoPath, defaultBranch: "main", sessionId: "sess-keepme-8" });
    // An empty or "." id collapses to the root; the guard must refuse both so a
    // single bad caller can't wipe every session's worktree.
    for (const badId of ["", "."]) {
      await expect(wm.remove({ repoPaths: [repoPath], sessionId: badId })).rejects.toThrow(
        /not strictly under the root/i,
      );
    }
    expect(existsSync(root)).toBe(true); // the root and its trees are intact
    expect(existsSync(wm.pathFor("sess-keepme-8"))).toBe(true);
  });
});

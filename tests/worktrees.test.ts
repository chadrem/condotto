import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorktreeManager,
  listTopLevelDirs,
  normalizeSubdir,
  sessionCwd,
  verifyWorkdir,
} from "../src/core/worktrees";

// Real worktree teardown. These exercise the WorktreeManager against a
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
  const base = mkdtempSync(join(tmpdir(), "condotto-wt-"));
  repoPath = join(base, "repo");
  root = join(base, "worktrees");
  await run(["git", "init", "-q", "-b", "main", repoPath]);
  await Bun.write(join(repoPath, "README.md"), "# fixture\n");
  await run(["git", "-C", repoPath, "add", "-A"]);
  await run(["git", "-C", repoPath, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
});

const worktreeList = () => run(["git", "-C", repoPath, "worktree", "list", "--porcelain"]);
const branchList = () => run(["git", "-C", repoPath, "branch", "--list"]);

describe("WorktreeManager.create + remove", () => {
  test("create registers a worktree + branch; remove deletes both and prunes clean", async () => {
    const wm = new WorktreeManager(root);
    const info = await wm.create({ repoPath, defaultBranch: "main", sessionId: "sess-aaaaaaaa-1" });
    expect(existsSync(info.path)).toBe(true);
    expect(existsSync(join(info.path, "README.md"))).toBe(true);
    expect(await worktreeList()).toContain(info.path);
    expect(await branchList()).toContain(info.branch.replace("condotto/", "")); // branch listed

    const res = await wm.remove({ repoPaths: [repoPath], sessionId: "sess-aaaaaaaa-1", branch: info.branch });
    expect(res).toEqual({ removed: true, deregistered: true, branchDeleted: true });
    expect(existsSync(info.path)).toBe(false);
    // Git no longer knows the worktree or the branch, and prune left nothing stale.
    expect(await worktreeList()).not.toContain(info.path);
    expect(await branchList()).not.toContain(info.branch.replace("condotto/", ""));
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
    const other = join(mkdtempSync(join(tmpdir(), "condotto-wt-other-")), "repo");
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
    const base = mkdtempSync(join(tmpdir(), "condotto-wt-escape-"));
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

// Monorepo sub-project working directories. `normalizeSubdir` is the pure shape
// gate (runs before a worktree exists); `verifyWorkdir` is the filesystem gate
// that must resolve symlinks, because the policy engine's containment test is
// lexical and this path becomes the base relative paths resolve against.

describe("normalizeSubdir (pure shape validation)", () => {
  test("the repo root has several spellings, all meaning null", () => {
    // `assign monorepo/` lands here as "" — a trailing slash means the root.
    for (const raw of ["", "   ", ".", "./", "./."]) {
      const r = normalizeSubdir(raw);
      expect(r.ok && r.workdir).toBe(null);
    }
  });

  test("a valid path is normalized to a clean relative POSIX path", () => {
    const cases: [string, string][] = [
      ["apps/report", "apps/report"],
      ["apps/report/", "apps/report"],
      ["  apps/report  ", "apps/report"],
      ["apps//report", "apps/report"],
      ["./apps/report", "apps/report"],
      ["services/api/v2", "services/api/v2"],
    ];
    for (const [raw, expected] of cases) {
      const r = normalizeSubdir(raw);
      expect(r.ok && r.workdir).toBe(expected);
    }
  });

  test("escapes and absolutes are refused with a reason, never normalized away", () => {
    const bad = [
      "../elsewhere",
      "apps/../../elsewhere",
      "/etc",
      "/apps/report",
      "/", // the filesystem root is absolute, not a spelling of "the repo root"
      "~",
      "~/secrets",
      "apps\\report",
      ".git",
      ".git/hooks",
      "a\0b",
    ];
    for (const raw of bad) {
      const r = normalizeSubdir(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("sessionCwd", () => {
  test("null workdir is the worktree root; a workdir is joined onto it", () => {
    expect(sessionCwd("/wt/abc", null)).toBe("/wt/abc");
    expect(sessionCwd("/wt/abc", "apps/report")).toBe("/wt/abc/apps/report");
  });
});

describe("verifyWorkdir (filesystem + symlink containment)", () => {
  test("an existing directory inside the worktree passes", async () => {
    const wm = new WorktreeManager(root);
    const info = await wm.create({ repoPath, defaultBranch: "main", sessionId: "sess-verify-1" });
    mkdirSync(join(info.path, "apps", "report"), { recursive: true });
    expect((await verifyWorkdir(info.path, "apps/report")).ok).toBe(true);
  });

  test("a missing directory is refused", async () => {
    const wm = new WorktreeManager(root);
    const info = await wm.create({ repoPath, defaultBranch: "main", sessionId: "sess-verify-2" });
    const r = await verifyWorkdir(info.path, "apps/nope");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/doesn't exist/i);
  });

  test("a file (not a directory) is refused", async () => {
    const wm = new WorktreeManager(root);
    const info = await wm.create({ repoPath, defaultBranch: "main", sessionId: "sess-verify-3" });
    writeFileSync(join(info.path, "notadir"), "x");
    const r = await verifyWorkdir(info.path, "notadir");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not a directory/i);
  });

  test("a symlink pointing OUT of the worktree is refused — the escape realpath exists to catch", async () => {
    // This is the P0 case. `apps/report` passes every lexical check, but the real
    // cwd would be outside the tree, so every lexically-inside relative path the
    // policy engine allows would actually resolve out of it.
    const wm = new WorktreeManager(root);
    const info = await wm.create({ repoPath, defaultBranch: "main", sessionId: "sess-verify-4" });
    const outside = mkdtempSync(join(tmpdir(), "condotto-outside-"));
    mkdirSync(join(info.path, "apps"), { recursive: true });
    symlinkSync(outside, join(info.path, "apps", "report"));
    const r = await verifyWorkdir(info.path, "apps/report");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/outside the repo/i);
  });

  test("a symlink to a directory INSIDE the worktree is fine", async () => {
    const wm = new WorktreeManager(root);
    const info = await wm.create({ repoPath, defaultBranch: "main", sessionId: "sess-verify-5" });
    mkdirSync(join(info.path, "packages", "shared"), { recursive: true });
    symlinkSync(join(info.path, "packages", "shared"), join(info.path, "linked"));
    expect((await verifyWorkdir(info.path, "linked")).ok).toBe(true);
  });
});

describe("listTopLevelDirs", () => {
  test("lists directories (not files), hides .git, and sorts", async () => {
    const wm = new WorktreeManager(root);
    const info = await wm.create({ repoPath, defaultBranch: "main", sessionId: "sess-list-1" });
    mkdirSync(join(info.path, "services"), { recursive: true });
    mkdirSync(join(info.path, "apps"), { recursive: true });
    writeFileSync(join(info.path, "justafile.txt"), "x");
    expect(listTopLevelDirs(info.path)).toEqual(["apps", "services"]);
  });

  test("a missing path yields an empty list rather than throwing", () => {
    expect(listTopLevelDirs(join(root, "nope"))).toEqual([]);
  });
});

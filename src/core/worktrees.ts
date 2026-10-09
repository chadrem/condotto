import { mkdir } from "node:fs/promises";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { scrubbedRunner, type CommandRunner, type RunOptions } from "./agent-exec";
import { DirectTreeIO, type TreeIO } from "./tree-io";

/** The daemon's per-worktree scratch directory, kept out of the repo's index. */
const CONDOTTO_EXCLUDE_ENTRY = "/.condotto/";
const CONDOTTO_EXCLUDE_BLOCK = `# condotto: daemon scratch (plan files) — never part of the repo\n${CONDOTTO_EXCLUDE_ENTRY}\n`;

// Worktree manager: one tree per session, at a stable absolute path.
// The harness keys session storage by encoded cwd — a moved worktree loses the
// session, so paths here are derived from the session id and
// never change. HOW the tree is made is a strategy (a linked git worktree by
// default, an agent-owned clone in sandbox mode); the path rule is not.

/**
 * Teardown git calls (the cleanup sweep's) have a timeout. Git runs hooks and
 * config-named commands the agent can plant, and one that never exits would
 * otherwise wedge the whole hourly sweep. Creating a tree has none: a first
 * checkout of a large repo is legitimately slow, and a stuck assign wedges only
 * that one thread, which an architect can see.
 */
const GIT_TEARDOWN_TIMEOUT_MS = 2 * 60_000;

/** Run git through a runner. `out` is stdout+stderr for messages; `stdout` alone for values. */
async function git(
  run: CommandRunner,
  args: string[],
  opts: RunOptions = {},
): Promise<{ ok: boolean; out: string; stdout: string }> {
  const res = await run(["git", ...args], opts);
  const stdout = new TextDecoder().decode(res.stdout);
  return { ok: res.code === 0, out: (stdout + res.stderr).trim(), stdout: stdout.trim() };
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
 * Uses `realpath`, not an existence check, deliberately. The policy engine's
 * containment test is lexical (`path.resolve` never follows symlinks), which is
 * tolerable while the resolution base is a path Condotto derives itself — but a
 * subdir names COMMITTED REPO CONTENT. If `apps/report` is a symlink to `/etc`, the
 * real cwd is `/etc`, every lexically-inside path passes policy, and `open()`
 * follows the link out of the tree. Resolving both sides and re-testing containment
 * closes that without needing general symlink hardening.
 *
 * Through `io` because the target is agent-controlled content: in sandbox mode the
 * resolution itself must run as the agent.
 */
export async function verifyWorkdir(
  worktreePath: string,
  workdir: string,
  io: TreeIO = new DirectTreeIO(),
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const target = resolve(worktreePath, workdir);
  const realRoot = await io.realpath(worktreePath);
  const realTarget = realRoot === null ? null : await io.realpath(target);
  if (realRoot === null || realTarget === null) {
    return { ok: false, reason: `\`${workdir}\` doesn't exist in this repo` };
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
    return { ok: false, reason: `\`${workdir}\` resolves outside the repo (it is a symlink out of the tree)` };
  }
  if (!(await io.isDirectory(realTarget))) return { ok: false, reason: `\`${workdir}\` is not a directory` };
  return { ok: true };
}

/** Top-level directory names inside a worktree — used to make a subdir typo obvious. */
export async function listTopLevelDirs(worktreePath: string, io: TreeIO = new DirectTreeIO()): Promise<string[]> {
  return (await io.listDirs(worktreePath)).filter((name) => name !== ".git").sort();
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

/** An exclude file's text with `/.condotto/` appended, or null when already present. */
function withCondottoExclude(existing: string): string | null {
  if (existing.includes(CONDOTTO_EXCLUDE_ENTRY)) return null;
  const nl = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  return `${existing}${nl}${CONDOTTO_EXCLUDE_BLOCK}`;
}

/**
 * Keep `.condotto/` — the daemon's per-tree scratch: plan files, attachments, the
 * outbox — out of `git status`, so it can never ride a `git add -A` into a real
 * commit. `info/exclude` is untracked and local, so it never reaches the
 * operator's colleagues, unlike editing `.gitignore`.
 *
 * Idempotent, and never fatal: a tree without the entry is untidy, not broken, and
 * failing an assign over it would be the worse trade.
 */
async function excludeCondottoDir(io: TreeIO, gitDir: string): Promise<void> {
  try {
    const infoDir = join(gitDir, "info");
    const file = join(infoDir, "exclude");
    const bytes = await io.readFile(file);
    const next = withCondottoExclude(bytes ? new TextDecoder().decode(bytes) : "");
    if (next === null) return;
    await io.mkdirp(infoDir);
    await io.writeFile(file, new TextEncoder().encode(next));
  } catch {
    // Best-effort hygiene only.
  }
}

/** A strategy's create/remove arguments. `path` is already derived and confinement-checked. */
export interface WorktreeCreateSpec {
  repoPath: string;
  defaultBranch: string;
  path: string;
  branch: string;
}
export interface WorktreeRemoveSpec {
  repoPaths: string[];
  path: string;
  branch: string;
}

/** What deleting a tree would lose, for the thread's stop message. */
export interface UnsavedWork {
  /** Uncommitted changes or untracked files. */
  dirty: boolean;
  /** Commits that deletion takes with it and that are on no remote branch and not on the default branch. */
  unpushed: number;
}

/** How long each unsaved-work git call may take before it counts as unknown. */
const UNSAVED_CHECK_TIMEOUT_MS = 30_000;

/**
 * Inspect a tree for work that exists nowhere else. Runs IN the tree through
 * `run`: the agent's runner in sandbox mode, a secrets-scrubbed one otherwise,
 * because the tree's config and `.gitattributes` are the agent's and can name
 * commands for git to run. For the same reason: `core.fsmonitor` and hooks are
 * pinned off, each call has a shorter timeout (a filter can simply never exit), and
 * `--no-optional-locks` keeps `status` from taking the index lock, so a stop that
 * lands mid-turn never breaks the agent's own `git commit`. Null when either
 * check fails: the caller says it could not tell, rather than guessing.
 */
async function inspectUnsaved(
  run: CommandRunner,
  path: string,
  revs: string[],
  notOn: string[],
): Promise<UnsavedWork | null> {
  const base = ["--no-optional-locks", "-C", path, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];
  const opts = { timeoutMs: UNSAVED_CHECK_TIMEOUT_MS };
  // Untracked files forced on: config (global, or the tree's own) can hide them,
  // and a brand-new file is exactly the work that would be lost.
  const status = await git(run, [...base, "status", "--porcelain", "--untracked-files=all"], opts);
  if (!status.ok) return null;
  // The exclusions go on stdin as `^<rev>` lines, not argv: a repo with many tags
  // supplies tens of thousands of them, past the OS argument limit. `--` so a file
  // named like a branch is never read as one.
  const ahead = await git(run, [...base, "rev-list", "--count", "--stdin", ...revs, "--not", "--remotes", "--"], {
    ...opts,
    stdin: new TextEncoder().encode(notOn.map((rev) => `^${rev}\n`).join("")),
  });
  const unpushed = Number(ahead.stdout);
  if (!ahead.ok || !Number.isInteger(unpushed)) return null;
  return { dirty: status.stdout.length > 0, unpushed };
}

export interface UnsavedSpec {
  path: string;
  branch: string;
  defaultBranch: string;
}

/**
 * HOW a session's tree comes into being and goes away. Everything else — its
 * stable path, the confinement check on teardown, the GC listing — belongs to the
 * manager and is identical across strategies.
 */
export interface WorktreeStrategy {
  /** Provision a fresh tree at `path` on `branch`, cut from `defaultBranch`. Throws on failure. */
  create(spec: WorktreeCreateSpec): Promise<void>;
  /** Best-effort teardown; never throws. */
  remove(spec: WorktreeRemoveSpec): Promise<{ deregistered: boolean; branchDeleted: boolean }>;
  /** What deleting the tree at `path` (and `branch`) would lose, or null if it can't be told. Never throws. */
  unsavedWork(spec: UnsavedSpec): Promise<UnsavedWork | null>;
}

/**
 * The default: a linked `git worktree` of the shared repo, with the branch living
 * in the real repo where a human can see it. Right whenever the daemon and the
 * agent are the same user — it needs the agent to write the shared repo's `.git`.
 */
export class GitWorktreeStrategy implements WorktreeStrategy {
  /**
   * `scrubbedRunner` by default, for every call: the shared repo's `.git` and the
   * session tree are both agent-writable in this mode, so git here can run hooks
   * and filters the agent planted, and they must not inherit the daemon's secrets.
   */
  constructor(private run: CommandRunner = scrubbedRunner) {}

  async create(spec: WorktreeCreateSpec): Promise<void> {
    const res = await git(this.run, ["-C", spec.repoPath, "worktree", "add", "-b", spec.branch, spec.path, spec.defaultBranch]);
    if (!res.ok) {
      throw new Error(`git worktree add failed for ${spec.repoPath}: ${res.out}`);
    }
    // The COMMON git dir, not a per-worktree one: verified 2026-07-25 that git
    // resolves excludes from the common dir, so a `$GIT_DIR/info/exclude` inside a
    // linked worktree is silently ignored. It belongs to the shared repo rather than
    // to a session tree, so the daemon's own fs calls are the right ones here.
    const dir = await git(this.run, ["-C", spec.repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (dir.ok) await excludeCondottoDir(new DirectTreeIO(), dir.stdout);
  }

  /**
   * `git worktree remove --force`, delete the condotto branch (`branch -D`), then
   * `git worktree prune`. `--force`/`-D` because a disposable worktree normally has
   * uncommitted work and unmerged commits. The physical directory is removed directly
   * as a backstop when git couldn't (an unregistered orphan).
   */
  async remove(spec: WorktreeRemoveSpec): Promise<{ deregistered: boolean; branchDeleted: boolean }> {
    let deregistered = false;
    let branchDeleted = false;
    const t = { timeoutMs: GIT_TEARDOWN_TIMEOUT_MS };
    for (const repoPath of spec.repoPaths) {
      if ((await git(this.run, ["-C", repoPath, "worktree", "remove", "--force", spec.path], t)).ok) {
        deregistered = true;
      }
      // Only the owning repo has the branch.
      if ((await git(this.run, ["-C", repoPath, "branch", "-D", spec.branch], t)).ok) {
        branchDeleted = true;
      }
    }
    if (existsSync(spec.path)) await new DirectTreeIO().remove(spec.path);
    // Prune stale admin entries (`.git/worktrees/<name>`) in every candidate repo.
    for (const repoPath of spec.repoPaths) {
      await git(this.run, ["-C", repoPath, "worktree", "prune"], { timeoutMs: GIT_TEARDOWN_TIMEOUT_MS });
    }
    return { deregistered, branchDeleted };
  }

  /**
   * Deletion removes the tree and the session branch, so count both; the shared
   * repo's other branches are the team's and survive. The default branch is a
   * local ref here.
   */
  async unsavedWork(spec: UnsavedSpec): Promise<UnsavedWork | null> {
    // The default branch as configured, which may be any commit-ish (`create`
    // hands it to `worktree add` the same way); the trailing `--` keeps a file of
    // that name from being read as it.
    return inspectUnsaved(this.run, spec.path, ["HEAD", `refs/heads/${spec.branch}`], [spec.defaultBranch]).catch(
      () => null,
    );
  }
}

/**
 * Sandbox mode: a private clone per session, made and owned by the agent.
 *
 * Not `git worktree add`, because a linked worktree needs the agent to write the
 * shared repo's `.git` — and an agent that can write there can plant config or a
 * hook that the DAEMON then executes on its next git call, or move the base every
 * later session is cut from. So the shared repo stays root-owned and read-only to
 * the agent, and:
 *   1. the daemon resolves the base commit in the shared repo (reading a repo only
 *      root can write is safe);
 *   2. the agent clones it with `--shared` — objects are borrowed through
 *      alternates, so it is cheap and writes nothing back — and checks out the
 *      session branch at exactly that commit;
 *   3. the agent writes the `/.condotto/` exclude into ITS clone's `.git`, which,
 *      unlike a linked worktree's, is the common dir.
 * Teardown is `rm -rf` as the agent; there is nothing to deregister in the shared repo.
 *
 * `safe.directory` names the shared repo because it is owned by another user, and
 * git refuses to read such a repo otherwise. It has to ride `--upload-pack`, not
 * the clone's own `-c`: a local clone serves itself through an `upload-pack`
 * child, and git strips command-line config from a local transport's environment
 * (verified on git 2.47 — `-c` alone fails with "dubious ownership"). The same
 * command is kept as the clone's `remote.origin.uploadpack`, so the agent's own
 * later `git fetch` from the shared repo works too. It lives only in the agent's
 * clone; nothing is written to a global config.
 */
/** POSIX single-quoting, for a value git hands to `sh -c`. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export class SandboxCloneStrategy implements WorktreeStrategy {
  constructor(
    /** Runs as the agent (setpriv, caps cleared). */
    private runAsAgent: CommandRunner,
    /** Tree access as the agent. */
    private io: TreeIO,
    /** Runs as the daemon, and only ever against the root-owned shared repo. */
    private runAsDaemon: CommandRunner = scrubbedRunner,
  ) {}

  async create(spec: WorktreeCreateSpec): Promise<void> {
    const base = await git(this.runAsDaemon, ["-C", spec.repoPath, "rev-parse", "--verify", `${spec.defaultBranch}^{commit}`]);
    if (!base.ok || !/^[0-9a-f]{40,64}$/.test(base.stdout)) {
      throw new Error(`could not resolve ${spec.defaultBranch} in ${spec.repoPath}: ${base.out}`);
    }
    const sha = base.stdout;

    // Run through a shell by git, so the path is single-quoted.
    const uploadPack = `git -c safe.directory=${shellQuote(join(spec.repoPath, ".git"))} upload-pack`;
    const steps: string[][] = [
      [
        "git",
        "-c", `safe.directory=${spec.repoPath}`,
        "-c", `safe.directory=${join(spec.repoPath, ".git")}`,
        "clone", "--shared", "--no-checkout", "--quiet", `--upload-pack=${uploadPack}`,
        "--", spec.repoPath, spec.path,
      ],
      ["git", "-C", spec.path, "config", "remote.origin.uploadpack", uploadPack],
      ["git", "-C", spec.path, "checkout", "-q", "-b", spec.branch, sha],
    ];
    for (const argv of steps) {
      const res = await this.runAsAgent(argv);
      if (res.code !== 0) {
        // A half-made clone would otherwise satisfy the manager's idempotent
        // "already provisioned" check on the next attempt.
        await this.io.remove(spec.path);
        throw new Error(`\`${argv.filter((a) => !a.startsWith("safe.directory")).slice(0, 4).join(" ")}\` failed for ${spec.repoPath}: ${res.stderr.trim()}`);
      }
    }
    await excludeCondottoDir(this.io, join(spec.path, ".git"));
  }

  async remove(spec: WorktreeRemoveSpec): Promise<{ deregistered: boolean; branchDeleted: boolean }> {
    await this.io.remove(spec.path);
    return { deregistered: false, branchDeleted: false };
  }

  /**
   * As the agent, in its own clone. Deletion removes the whole clone, so every
   * local branch, tag and the latest stash count (in the shared-repo mode those
   * live in the shared repo and survive). The default branch arrived as
   * `origin/<name>`, which `--remotes` already covers. `--glob` rather than a bare
   * `refs/stash`, which would be an error when there is no stash.
   *
   * The clone copied every tag the shared repo has, and `--remotes` covers only its
   * branches, so a release tag off those branches would otherwise read as unpushed
   * work in every session. Every tag the shared repo has (peeled `^{}` lines too)
   * goes after `--not`, leaving only tags made in this clone. `ls-remote` runs as
   * the agent through the clone's configured `uploadpack`; if it fails, the whole
   * check is unknown rather than guessed.
   */
  async unsavedWork(spec: UnsavedSpec): Promise<UnsavedWork | null> {
    try {
      const tags = await git(this.runAsAgent, ["-C", spec.path, "ls-remote", "--tags", "origin"], {
        timeoutMs: UNSAVED_CHECK_TIMEOUT_MS,
      });
      if (!tags.ok) return null;
      const shared = tags.stdout
        .split("\n")
        .map((line) => line.split("\t")[0] ?? "")
        .filter((oid) => /^[0-9a-f]{40,64}$/.test(oid));
      return await inspectUnsaved(this.runAsAgent, spec.path, ["HEAD", "--branches", "--tags", "--glob=refs/stash"], shared);
    } catch {
      return null;
    }
  }
}

export class WorktreeManager {
  private readonly strategy: WorktreeStrategy;
  private readonly io: TreeIO;
  /** Whether `create` may make the root itself (see there). */
  private readonly createRoot: boolean;

  constructor(
    private root: string,
    opts: { strategy?: WorktreeStrategy; io?: TreeIO } = {},
  ) {
    this.strategy = opts.strategy ?? new GitWorktreeStrategy();
    this.io = opts.io ?? new DirectTreeIO();
    // In sandbox mode the root must already exist and be writable by the agent
    // (README, "Running sandboxed"). Made here by the root-in-container daemon it
    // would be root-owned, and every clone into it would fail.
    this.createRoot = opts.strategy === undefined;
  }

  /** Stable absolute worktree path for a session — must never change. */
  pathFor(sessionId: string): string {
    return resolve(join(this.root, sessionId));
  }

  async create(opts: {
    repoPath: string;
    defaultBranch: string;
    sessionId: string;
  }): Promise<WorktreeInfo> {
    if (this.createRoot) await mkdir(this.root, { recursive: true });
    const path = this.pathFor(opts.sessionId);
    const branch = `condotto/${opts.sessionId.slice(0, 8)}`;

    if (await this.io.exists(path)) {
      // Idempotent recovery: worktree already provisioned for this session.
      return { path, branch };
    }

    await this.strategy.create({ repoPath: opts.repoPath, defaultBranch: opts.defaultBranch, path, branch });
    return { path, branch };
  }

  /** What deleting this session's tree would lose (see `UnsavedWork`); null if unknown. */
  async unsavedWork(opts: { sessionId: string; branch: string; defaultBranch: string }): Promise<UnsavedWork | null> {
    const path = this.pathFor(opts.sessionId);
    if (!(await this.io.exists(path))) return null;
    return this.strategy.unsavedWork({ path, branch: opts.branch, defaultBranch: opts.defaultBranch });
  }

  /** Session-id directories currently under the worktree root — each name IS a
   *  session id (that is how `pathFor` derives the path), with its dir mtime so
   *  the GC can skip a just-created tree (an in-flight assign whose DB row is not
   *  inserted yet). The GC cross-references names against session rows to find
   *  orphans (no row → collectible). Missing root = none.
   *
   *  The daemon's own calls even in sandbox mode: this reads the ROOT's entries,
   *  never into a tree, and `lstat` does not follow one the agent swapped for a link. */
  listExisting(): { name: string; mtimeMs: number }[] {
    if (!existsSync(this.root)) return [];
    const out: { name: string; mtimeMs: number }[] = [];
    for (const e of readdirSync(this.root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const st = lstatSync(join(this.root, e.name), { throwIfNoEntry: false });
      out.push({ name: e.name, mtimeMs: st ? st.mtimeMs : 0 });
    }
    return out;
  }

  /**
   * Tear down a session's tree through the strategy. **Best-effort and
   * idempotent** — a missing directory, an already-deleted branch, or an
   * unregistered worktree are not errors, so the GC never crashes on one bad tree,
   * and a re-run is a no-op.
   *
   * `repoPaths` is the set of repos to try: the exact owning repo for a known
   * session (one entry), or every configured repo for an orphan whose owner is
   * unknown (a path is a worktree of at most one repo, so the non-owners simply
   * no-op). Never touches anything outside `this.root` — the path is derived from
   * the id, and a would-be escape is refused.
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

    const { deregistered, branchDeleted } = await this.strategy.remove({ repoPaths: opts.repoPaths, path, branch });
    return { removed: !(await this.io.exists(path)), deregistered, branchDeleted };
  }
}

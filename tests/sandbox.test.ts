import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentHelperEnv,
  directRunner,
  proveCanDropPrivileges,
  setprivArgv,
  type CommandRunner,
  type RunOptions,
  type RunResult,
  type SandboxIdentity,
  type SyncCommandRunner,
} from "../src/core/agent-exec";
import { AgentTreeIO, DirectTreeIO } from "../src/core/tree-io";
import { SandboxCloneStrategy, WorktreeManager } from "../src/core/worktrees";

// Sandbox mode, without real setuid: every privileged edge is an injected runner,
// so these pin WHAT would run as the agent and in what order. The one real-git
// test below runs the same sequence with a pass-through "agent" so the commands
// are proven to actually produce a working tree.

const ID: SandboxIdentity = { agentUid: 1001, agentGid: 1002, agentHome: "/home/agent" };
const enc = (s: string) => new TextEncoder().encode(s);

/** A runner that records every argv and answers from a script (default: success, no output). */
function recorder(answer: (argv: string[]) => Partial<RunResult> = () => ({})) {
  const calls: { argv: string[]; opts?: RunOptions }[] = [];
  const run: CommandRunner = async (argv, opts) => {
    calls.push({ argv, opts });
    return { code: 0, stdout: new Uint8Array(), stderr: "", ...answer(argv) };
  };
  const runSync: SyncCommandRunner = (argv, opts) => {
    calls.push({ argv, opts });
    return { code: 0, stdout: new Uint8Array(), stderr: "", ...answer(argv) };
  };
  return { calls, run, runSync };
}

describe("setprivArgv", () => {
  test("drops to the agent uid/gid, clears groups and every inheritable/ambient cap, then execs", () => {
    expect(setprivArgv(ID, ["git", "status"])).toEqual([
      "setpriv",
      "--reuid=1001",
      "--regid=1002",
      "--clear-groups",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--",
      "git",
      "status",
    ]);
  });

  test("the wrapped argv is never re-parsed: an option-shaped argument stays after `--`", () => {
    const argv = setprivArgv(ID, ["cat", "--", "-rf"]);
    expect(argv.indexOf("--")).toBe(6);
    expect(argv.slice(7)).toEqual(["cat", "--", "-rf"]);
  });
});

describe("agentHelperEnv", () => {
  test("carries PATH, HOME and a C locale — never the daemon's environment", () => {
    const env = agentHelperEnv(ID);
    expect(Object.keys(env).sort()).toEqual(["HOME", "LC_ALL", "PATH"]);
    expect(env.HOME).toBe("/home/agent");
  });
});

describe("proveCanDropPrivileges", () => {
  test("runs `setpriv … -- true` and passes on exit 0", async () => {
    const r = recorder();
    await proveCanDropPrivileges(ID, r.run);
    expect(r.calls[0]!.argv).toEqual(setprivArgv(ID, ["true"]));
  });

  test("a non-zero exit fails boot with the Docker flags that fix it", async () => {
    const r = recorder(() => ({ code: 1, stderr: "setpriv: setresuid failed: Operation not permitted" }));
    await expect(proveCanDropPrivileges(ID, r.run)).rejects.toThrow(
      /cannot drop privileges to uid 1001.*Operation not permitted.*--cap-add SETUID --cap-add SETGID --cap-add KILL/s,
    );
  });

  test("a missing setpriv binary fails boot naming it", async () => {
    const run: CommandRunner = async () => {
      throw new Error("ENOENT");
    };
    await expect(proveCanDropPrivileges(ID, run)).rejects.toThrow(/setpriv/);
  });
});

describe("AgentTreeIO — command construction", () => {
  test("every operation is one coreutils/findutils argv, paths after `--` where the tool allows", async () => {
    const r = recorder((argv) =>
      argv[0] === "realpath" ? { stdout: enc("/wt/s1\n") } : argv[0] === "cat" ? { stdout: enc("hi") } : {},
    );
    const io = new AgentTreeIO(r.run, r.runSync);
    await io.mkdirp("/wt/s1/.condotto/attachments");
    await io.writeFile("/wt/s1/.condotto/attachments/a.png", enc("PNG"));
    expect(await io.readFile("/wt/s1/f")).toEqual(enc("hi"));
    await io.remove("/wt/s1/.condotto/outbox");
    expect(await io.realpath("/wt/s1")).toBe("/wt/s1");
    await io.isDirectory("/wt/s1/apps");
    await io.exists("/wt/s1");
    expect(r.calls.map((c) => c.argv)).toEqual([
      ["mkdir", "-p", "--", "/wt/s1/.condotto/attachments"],
      ["dd", "of=/wt/s1/.condotto/attachments/a.png", "bs=1048576", "status=none"],
      ["cat", "--", "/wt/s1/f"],
      ["rm", "-rf", "--", "/wt/s1/.condotto/outbox"],
      ["realpath", "-e", "--", "/wt/s1"],
      ["test", "-d", "/wt/s1/apps"],
      ["test", "-e", "/wt/s1"],
    ]);
    // The bytes travel on stdin, never in argv.
    expect(r.calls[1]!.opts?.stdin).toEqual(enc("PNG"));
  });

  test("listFiles asks find for direct, non-symlink regular files and parses NUL-separated name/size", async () => {
    const r = recorder(() => ({ stdout: enc("b.txt\u00006\u0000a b\nc.txt\u00005\u0000") }));
    const io = new AgentTreeIO(r.run, r.runSync);
    expect(await io.listFiles("/wt/s1/.condotto/outbox")).toEqual([
      { name: "b.txt", sizeBytes: 6 },
      { name: "a b\nc.txt", sizeBytes: 5 }, // a newline in a name survives intact
    ]);
    expect(r.calls[0]!.argv).toEqual([
      "find", "/wt/s1/.condotto/outbox", "-mindepth", "1", "-maxdepth", "1", "-type", "f", "-printf", "%f\\0%s\\0",
    ]);
    // No -L / -H: find must never follow a link, including the outbox itself.
    expect(r.calls[0]!.argv).not.toContain("-L");
    expect(r.calls[0]!.argv).not.toContain("-H");
  });

  test("subdirsHolding is one find two levels down, matching the name literally", async () => {
    const r = recorder(() => ({ stdout: enc("/home/agent/.claude/projects/-wt-s1\u0000") }));
    const io = new AgentTreeIO(r.run, r.runSync);
    expect(await io.subdirsHolding("/home/agent/.claude/projects", "a*b?.jsonl")).toEqual(["-wt-s1"]);
    expect(r.calls.length).toBe(1);
    expect(r.calls[0]!.argv).toEqual([
      "find", "/home/agent/.claude/projects", "-mindepth", "2", "-maxdepth", "2", "-type", "f",
      "-name", "a\\*b\\?.jsonl", "-printf", "%h\\0",
    ]);
    expect(r.calls[0]!.argv).not.toContain("-L");
  });

  test("DirectTreeIO.subdirsHolding skips symlinked files and directories", async () => {
    const dir = mkdtempSync(join(tmpdir(), "condotto-holding-"));
    mkdirSync(join(dir, "real"));
    writeFileSync(join(dir, "real", "t.jsonl"), "{}");
    mkdirSync(join(dir, "linkfile"));
    symlinkSync(join(dir, "real", "t.jsonl"), join(dir, "linkfile", "t.jsonl"));
    symlinkSync(join(dir, "real"), join(dir, "linkdir"));
    mkdirSync(join(dir, "empty"));
    expect(await new DirectTreeIO().subdirsHolding(dir, "t.jsonl")).toEqual(["real"]);
  });

  test("writeFile/readFile really move bytes through a spawned process's stdin/stdout", async () => {
    // Run for real with a pass-through runner: Bun feeds stdin through a socket,
    // which is exactly what broke an earlier `cp /dev/stdin` (it exited 0 and wrote
    // nothing). Big enough to need many reads, and over an existing longer file to
    // prove it truncates.
    const dir = mkdtempSync(join(tmpdir(), "condotto-tio-"));
    const io = new AgentTreeIO(directRunner, () => {
      throw new Error("unused");
    });
    const big = new Uint8Array(3_000_000).map((_, i) => i % 251);
    await io.writeFile(join(dir, "f.bin"), enc("x".repeat(4_000_000)));
    await io.writeFile(join(dir, "f.bin"), big);
    expect(await io.readFile(join(dir, "f.bin"))).toEqual(big);
    await expect(io.writeFile(join(dir, "missing", "f.bin"), big)).rejects.toThrow();
  });

  test("a failed command reads as absent, not as an empty success", async () => {
    const r = recorder(() => ({ code: 1, stderr: "No such file" }));
    const io = new AgentTreeIO(r.run, r.runSync);
    expect(await io.listFiles("/wt/s1/.condotto/outbox")).toBeNull();
    expect(await io.readFile("/wt/s1/x")).toBeNull();
    expect(await io.realpath("/wt/s1/x")).toBeNull();
    expect(io.readTextSync("/wt/s1/x")).toBeNull();
    expect(io.listEntriesSync("/wt/s1/.claude/skills")).toBeNull();
    await expect(io.writeFile("/wt/s1/x", enc("y"))).rejects.toThrow(/No such file/);
  });

  test("a relative path is refused before any process runs — it could parse as an option", async () => {
    const r = recorder();
    const io = new AgentTreeIO(r.run, r.runSync);
    await expect(io.exists("-rf")).rejects.toThrow(/absolute path/);
    expect(() => io.readTextSync("relative/SKILL.md")).toThrow(/absolute path/);
    expect(r.calls).toEqual([]);
  });
});

describe("SandboxCloneStrategy", () => {
  const SHA = "a".repeat(40);

  test("the daemon only resolves the base; the agent clones, checks out at that sha, and writes the exclude", async () => {
    const daemon = recorder(() => ({ stdout: enc(`${SHA}\n`) }));
    // No tree yet (`test -e` fails) and no exclude file yet (`cat` fails).
    const agent = recorder((argv) => (argv[0] === "cat" || argv[0] === "test" ? { code: 1 } : {}));
    const io = new AgentTreeIO(agent.run, agent.runSync);
    const strategy = new SandboxCloneStrategy(agent.run, io, daemon.run);
    const wm = new WorktreeManager("/wt", { strategy, io });

    const info = await wm.create({ repoPath: "/repos/app", defaultBranch: "main", sessionId: "0123456789abcdef" });
    expect(info).toEqual({ path: "/wt/0123456789abcdef", branch: "condotto/01234567" });

    // As the daemon: one read-only rev-parse in the shared repo, nothing else.
    expect(daemon.calls.map((c) => c.argv)).toEqual([
      ["git", "-C", "/repos/app", "rev-parse", "--verify", "main^{commit}"],
    ]);
    // As the agent, in order. Nothing here writes to the shared repo.
    expect(agent.calls.map((c) => c.argv)).toEqual([
      ["test", "-e", "/wt/0123456789abcdef"], // idempotency probe
      [
        "git",
        "-c", "safe.directory=/repos/app",
        "-c", "safe.directory=/repos/app/.git",
        "clone", "--shared", "--no-checkout", "--quiet",
        "--upload-pack=git -c safe.directory='/repos/app/.git' upload-pack",
        "--", "/repos/app", "/wt/0123456789abcdef",
      ],
      // Kept for the agent's own later fetches from the shared repo.
      ["git", "-C", "/wt/0123456789abcdef", "config", "remote.origin.uploadpack", "git -c safe.directory='/repos/app/.git' upload-pack"],
      ["git", "-C", "/wt/0123456789abcdef", "checkout", "-q", "-b", "condotto/01234567", SHA],
      ["cat", "--", "/wt/0123456789abcdef/.git/info/exclude"],
      ["mkdir", "-p", "--", "/wt/0123456789abcdef/.git/info"],
      ["dd", "of=/wt/0123456789abcdef/.git/info/exclude", "bs=1048576", "status=none"],
    ]);
    expect(new TextDecoder().decode(agent.calls[6]!.opts!.stdin)).toContain("/.condotto/\n");
  });

  test("an unresolvable base fails before the agent runs anything", async () => {
    const daemon = recorder(() => ({ code: 128, stderr: "fatal: Needed a single revision" }));
    const agent = recorder((argv) => (argv[0] === "test" ? { code: 1 } : {}));
    const io = new AgentTreeIO(agent.run, agent.runSync);
    const wm = new WorktreeManager("/wt", { strategy: new SandboxCloneStrategy(agent.run, io, daemon.run), io });
    await expect(wm.create({ repoPath: "/repos/app", defaultBranch: "nope", sessionId: "s-1" })).rejects.toThrow(
      /could not resolve nope/,
    );
    expect(agent.calls.map((c) => c.argv[0])).toEqual(["test"]);
  });

  test("a failed clone removes the half-made tree, so a retry is not mistaken for done", async () => {
    const daemon = recorder(() => ({ stdout: enc(SHA) }));
    const agent = recorder((argv) =>
      argv[0] === "test" ? { code: 1 } : argv.includes("clone") ? { code: 128, stderr: "fatal: unsafe repository" } : {},
    );
    const io = new AgentTreeIO(agent.run, agent.runSync);
    const wm = new WorktreeManager("/wt", { strategy: new SandboxCloneStrategy(agent.run, io, daemon.run), io });
    await expect(wm.create({ repoPath: "/repos/app", defaultBranch: "main", sessionId: "s-2" })).rejects.toThrow(
      /unsafe repository/,
    );
    expect(agent.calls.at(-1)!.argv).toEqual(["rm", "-rf", "--", "/wt/s-2"]);
  });

  test("teardown is rm -rf as the agent, still confined strictly under the root, and never touches the shared repo", async () => {
    const daemon = recorder();
    const agent = recorder((argv) => (argv[0] === "test" ? { code: 1 } : {}));
    const io = new AgentTreeIO(agent.run, agent.runSync);
    const wm = new WorktreeManager("/wt", { strategy: new SandboxCloneStrategy(agent.run, io, daemon.run), io });

    const res = await wm.remove({ repoPaths: ["/repos/app"], sessionId: "s-3" });
    expect(res).toEqual({ removed: true, deregistered: false, branchDeleted: false });
    expect(agent.calls.map((c) => c.argv)).toEqual([
      ["rm", "-rf", "--", "/wt/s-3"],
      ["test", "-e", "/wt/s-3"],
    ]);
    expect(daemon.calls).toEqual([]);

    await expect(wm.remove({ repoPaths: [], sessionId: "../etc" })).rejects.toThrow(/not strictly under the root/);
    await expect(wm.remove({ repoPaths: [], sessionId: "" })).rejects.toThrow(/not strictly under the root/);
  });

  test("against real git, the sequence yields a private clone on the session branch with .condotto excluded", async () => {
    const run = async (cmd: string[], cwd?: string) => {
      const res = await directRunner(cmd, { cwd });
      if (res.code !== 0) throw new Error(`${cmd.join(" ")}: ${res.stderr}`);
      return new TextDecoder().decode(res.stdout).trim();
    };
    const base = mkdtempSync(join(tmpdir(), "condotto-sbx-"));
    const repoPath = join(base, "repo");
    await run(["git", "init", "-q", "-b", "main", repoPath]);
    await Bun.write(join(repoPath, "README.md"), "# fixture\n");
    await run(["git", "-C", repoPath, "add", "-A"]);
    await run(["git", "-C", repoPath, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
    const head = await run(["git", "-C", repoPath, "rev-parse", "HEAD"]);

    // The "agent" here is this same user — what is under test is that the
    // commands make a correct tree, not the privilege drop.
    const io = new DirectTreeIO();
    const root = join(base, "worktrees");
    await run(["mkdir", "-p", root]); // in sandbox mode the root is provisioned, not created
    const wm = new WorktreeManager(root, { strategy: new SandboxCloneStrategy(directRunner, io), io });
    const info = await wm.create({ repoPath, defaultBranch: "main", sessionId: "sess-sbx-00000001" });

    expect(existsSync(join(info.path, "README.md"))).toBe(true);
    expect(await run(["git", "-C", info.path, "rev-parse", "--abbrev-ref", "HEAD"])).toBe(info.branch);
    expect(await run(["git", "-C", info.path, "rev-parse", "HEAD"])).toBe(head);
    // Not a linked worktree: the shared repo knows nothing about it, and gained no branch.
    expect(await run(["git", "-C", repoPath, "worktree", "list", "--porcelain"])).not.toContain(info.path);
    expect(await run(["git", "-C", repoPath, "branch", "--list"])).not.toContain("condotto/");
    // Objects are borrowed, not copied.
    expect(existsSync(join(info.path, ".git", "objects", "info", "alternates"))).toBe(true);
    // The scratch dir stays out of git status.
    await run(["mkdir", "-p", join(info.path, ".condotto", "outbox")]);
    await Bun.write(join(info.path, ".condotto", "outbox", "x.txt"), "x");
    expect(await run(["git", "status", "--porcelain"], info.path)).toBe("");

    const res = await wm.remove({ repoPaths: [repoPath], sessionId: "sess-sbx-00000001" });
    expect(res.removed).toBe(true);
    expect(existsSync(info.path)).toBe(false);
    expect(existsSync(join(repoPath, "README.md"))).toBe(true);
  });
});

describe("SandboxCloneStrategy.unsavedWork", () => {
  test("tens of thousands of shared tags go on stdin, never argv", async () => {
    const oids = Array.from({ length: 60_000 }, (_, i) => i.toString(16).padStart(40, "0"));
    let revList: { argv: string[]; stdin?: Uint8Array } | undefined;
    const agent: CommandRunner = async (argv, opts) => {
      if (argv.includes("ls-remote")) {
        return { code: 0, stdout: enc(oids.map((o, i) => `${o}\trefs/tags/v${i}`).join("\n")), stderr: "" };
      }
      if (argv.includes("rev-list")) revList = { argv, stdin: opts?.stdin };
      return { code: 0, stdout: enc(argv.includes("rev-list") ? "0\n" : ""), stderr: "" };
    };
    const strategy = new SandboxCloneStrategy(agent, new DirectTreeIO());
    expect(await strategy.unsavedWork({ path: "/wt/s1", branch: "condotto/s1", defaultBranch: "main" })).toEqual({
      dirty: false,
      unpushed: 0,
    });
    expect(revList!.argv.length).toBeLessThan(30);
    expect(revList!.argv).toContain("--stdin");
    const lines = new TextDecoder().decode(revList!.stdin).trim().split("\n");
    expect(lines.length).toBe(60_000);
    expect(lines[0]).toBe(`^${oids[0]}`);
  });

  test("the shared repo's own tags never count; a tag made in the clone does", async () => {
    const run = async (cmd: string[], cwd?: string) => {
      const res = await directRunner(cmd, { cwd });
      if (res.code !== 0) throw new Error(`${cmd.join(" ")}: ${res.stderr}`);
      return new TextDecoder().decode(res.stdout).trim();
    };
    const base = mkdtempSync(join(tmpdir(), "condotto-sbx-tags-"));
    const repoPath = join(base, "repo");
    const commit = (cwd: string, msg: string) =>
      run(["git", "-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", msg]);
    await run(["git", "init", "-q", "-b", "main", repoPath]);
    await commit(repoPath, "init");
    // A release tag on a side branch that was then deleted: the tag is not on any
    // branch of the shared repo, which is exactly what `--remotes` can't see.
    await run(["git", "-C", repoPath, "checkout", "-q", "-b", "release"]);
    await commit(repoPath, "release fix");
    await run(["git", "-C", repoPath, "-c", "user.email=t@t", "-c", "user.name=t", "tag", "-a", "v1.0", "-m", "v1.0"]);
    await run(["git", "-C", repoPath, "checkout", "-q", "main"]);
    await run(["git", "-C", repoPath, "branch", "-q", "-D", "release"]);

    const io = new DirectTreeIO();
    const root = join(base, "worktrees");
    await run(["mkdir", "-p", root]);
    const wm = new WorktreeManager(root, { strategy: new SandboxCloneStrategy(directRunner, io), io });
    const info = await wm.create({ repoPath, defaultBranch: "main", sessionId: "sess-sbx-tags-0001" });
    const check = () => wm.unsavedWork({ sessionId: "sess-sbx-tags-0001", branch: info.branch, defaultBranch: "main" });
    expect(await check()).toEqual({ dirty: false, unpushed: 0 });

    // Work tagged in the clone, then left off every branch, still counts.
    await run(["git", "-C", info.path, "checkout", "-q", "--detach"]);
    await commit(info.path, "agent work");
    await run(["git", "-C", info.path, "tag", "agent-mark"]);
    await run(["git", "-C", info.path, "checkout", "-q", info.branch]);
    expect(await check()).toEqual({ dirty: false, unpushed: 1 });
  });
});


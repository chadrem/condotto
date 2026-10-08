import { lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { CommandRunner, SyncCommandRunner } from "./agent-exec";

// Every read, write, list, remove and realpath the daemon makes INSIDE a session's
// tree goes through this port. The tree is the agent's to shape — it can plant a
// symlink anywhere in it between two turns — so whose privileges an access runs
// with is the security question, not a detail.
//
//   DirectTreeIO — the daemon's own fs calls. The default, and right when the
//                  daemon and the agent are the same Unix user anyway: there are no
//                  extra privileges for a symlink to borrow.
//   AgentTreeIO  — coreutils/findutils run AS THE AGENT (see agent-exec.ts). Used in
//                  sandbox mode, where the daemon is root-in-container and following
//                  an agent-planted link with its own privileges is exactly the
//                  confused-deputy bug this exists to rule out.
//
// Callers keep their own semantic checks (outbox lists only regular files,
// realpath containment for a workdir); this port only decides whose privileges
// each access runs with.

/** A regular, non-symlink file found directly in a directory. */
export interface TreeFile {
  name: string;
  sizeBytes: number;
}

export interface TreeIO {
  /** `mkdir -p`. Throws on failure. */
  mkdirp(dir: string): Promise<void>;
  /** Create or truncate a file with these bytes. Throws on failure. */
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  /** A file's bytes, or null when it cannot be read. */
  readFile(path: string): Promise<Uint8Array | null>;
  /** Regular non-symlink files directly in `dir`; null when the dir is unreadable. */
  listFiles(dir: string): Promise<TreeFile[] | null>;
  /** Every entry name directly in `dir`, of any type; null when unreadable. */
  listNames(dir: string): Promise<string[] | null>;
  /** Names of real (non-symlink) subdirectories directly in `dir`; [] when unreadable. */
  listDirs(dir: string): Promise<string[]>;
  /** `rm -rf`. Never throws. */
  remove(path: string): Promise<void>;
  /** The canonical absolute path, or null when it does not exist. */
  realpath(path: string): Promise<string | null>;
  /** True when the path exists and (following links) is a directory. */
  isDirectory(path: string): Promise<boolean>;
  /** True when the path exists (following links). */
  exists(path: string): Promise<boolean>;
  /**
   * Synchronous listing and read, for the one caller whose port contract is
   * synchronous (the harness's `listSkills`). Both return null when unreadable.
   */
  listEntriesSync(dir: string): string[] | null;
  readTextSync(path: string): string | null;
}

export class DirectTreeIO implements TreeIO {
  async mkdirp(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
  }
  async writeFile(path: string, bytes: Uint8Array): Promise<void> {
    await writeFile(path, bytes);
  }
  async readFile(path: string): Promise<Uint8Array | null> {
    return readFile(path).then((b) => new Uint8Array(b)).catch(() => null);
  }
  async listFiles(dir: string): Promise<TreeFile[] | null> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (entries === null) return null;
    const out: TreeFile[] = [];
    for (const e of entries) {
      if (!e.isFile()) continue; // withFileTypes uses lstat semantics: a symlink is not a file
      const st = await lstat(join(dir, e.name)).catch(() => null);
      if (!st?.isFile()) continue;
      out.push({ name: e.name, sizeBytes: st.size });
    }
    return out;
  }
  async listNames(dir: string): Promise<string[] | null> {
    return readdir(dir).catch(() => null);
  }
  async listDirs(dir: string): Promise<string[]> {
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  }
  async remove(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true }).catch(() => {});
  }
  async realpath(path: string): Promise<string | null> {
    return realpath(path).catch(() => null);
  }
  async isDirectory(path: string): Promise<boolean> {
    return (await stat(path).catch(() => null))?.isDirectory() ?? false;
  }
  async exists(path: string): Promise<boolean> {
    return existsSync(path);
  }
  listEntriesSync(dir: string): string[] | null {
    try {
      return readdirSync(dir);
    } catch {
      return null;
    }
  }
  readTextSync(path: string): string | null {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  }
}

/** Split `find -printf '…\0'` output into its NUL-terminated fields. */
function nulFields(bytes: Uint8Array): string[] {
  const text = new TextDecoder().decode(bytes);
  const fields = text.split("\0");
  fields.pop(); // the trailing terminator leaves one empty field
  return fields;
}

/**
 * Tree access as the agent. Every method is one coreutils/findutils process run
 * through the injected runner, which in production is `agentRunner` — setpriv to
 * the agent uid with every capability cleared.
 *
 * Paths are passed as separate argv entries after `--` where the tool accepts it,
 * never through a shell, so a filename can be anything at all without becoming an
 * option or a command. `find` and `test` take no `--`; every path the core hands
 * this port is absolute, so none of them can start with `-` either. GNU tools are
 * assumed: the sandbox image is Linux.
 */
export class AgentTreeIO implements TreeIO {
  constructor(
    private run: CommandRunner,
    private runSync: SyncCommandRunner,
  ) {}

  /** Refuse a relative path outright rather than let it reach a tool as an option. */
  private static abs(path: string): string {
    if (!isAbsolute(path)) throw new Error(`AgentTreeIO needs an absolute path, got ${JSON.stringify(path)}`);
    return path;
  }

  async mkdirp(dir: string): Promise<void> {
    const res = await this.run(["mkdir", "-p", "--", AgentTreeIO.abs(dir)]);
    if (res.code !== 0) throw new Error(`mkdir -p ${dir} failed: ${res.stderr.trim()}`);
  }

  async writeFile(path: string, bytes: Uint8Array): Promise<void> {
    // `dd` reads fd 0 itself, writes (and truncates) exactly one path, and echoes
    // nothing back. Not `cp /dev/stdin`: Bun feeds stdin through a socket, which
    // `open("/dev/stdin")` refuses on Linux and BSD cp skips while exiting 0.
    // Not `tee`: it would copy every byte back through our stdout pipe.
    const res = await this.run(["dd", `of=${AgentTreeIO.abs(path)}`, "bs=1048576", "status=none"], { stdin: bytes });
    if (res.code !== 0) throw new Error(`writing ${path} failed: ${res.stderr.trim()}`);
  }

  async readFile(path: string): Promise<Uint8Array | null> {
    const res = await this.run(["cat", "--", AgentTreeIO.abs(path)]);
    return res.code === 0 ? res.stdout : null;
  }

  async listFiles(dir: string): Promise<TreeFile[] | null> {
    // `-type f` without `-L` is lstat-based: a symlink is never a regular file here.
    const res = await this.run(findDirect(AgentTreeIO.abs(dir), ["-type", "f"], "%f\\0%s\\0"));
    if (res.code !== 0) return null;
    const f = nulFields(res.stdout);
    const out: TreeFile[] = [];
    for (let i = 0; i + 1 < f.length; i += 2) out.push({ name: f[i]!, sizeBytes: Number(f[i + 1]) });
    return out;
  }

  async listNames(dir: string): Promise<string[] | null> {
    const res = await this.run(findDirect(AgentTreeIO.abs(dir), [], "%f\\0"));
    return res.code === 0 ? nulFields(res.stdout) : null;
  }

  async listDirs(dir: string): Promise<string[]> {
    const res = await this.run(findDirect(AgentTreeIO.abs(dir), ["-type", "d"], "%f\\0"));
    return res.code === 0 ? nulFields(res.stdout) : [];
  }

  async remove(path: string): Promise<void> {
    await this.run(["rm", "-rf", "--", AgentTreeIO.abs(path)]).catch(() => {});
  }

  async realpath(path: string): Promise<string | null> {
    // `-e`: every component must exist, so a dangling link is "does not exist"
    // rather than a path that names nothing.
    const res = await this.run(["realpath", "-e", "--", AgentTreeIO.abs(path)]);
    if (res.code !== 0) return null;
    return new TextDecoder().decode(res.stdout).replace(/\n$/, "");
  }

  async isDirectory(path: string): Promise<boolean> {
    return (await this.run(["test", "-d", AgentTreeIO.abs(path)])).code === 0;
  }

  async exists(path: string): Promise<boolean> {
    return (await this.run(["test", "-e", AgentTreeIO.abs(path)])).code === 0;
  }

  listEntriesSync(dir: string): string[] | null {
    const res = this.runSync(findDirect(AgentTreeIO.abs(dir), [], "%f\\0"));
    return res.code === 0 ? nulFields(res.stdout) : null;
  }

  readTextSync(path: string): string | null {
    const res = this.runSync(["cat", "--", AgentTreeIO.abs(path)]);
    return res.code === 0 ? new TextDecoder().decode(res.stdout) : null;
  }
}

/**
 * `find` over the DIRECT children of `dir` only. Without `-H`/`-L` find never
 * follows a link — including `dir` itself, so an outbox the agent replaced with a
 * symlink lists as empty rather than as wherever it points.
 */
function findDirect(dir: string, tests: string[], format: string): string[] {
  return ["find", dir, "-mindepth", "1", "-maxdepth", "1", ...tests, "-printf", format];
}

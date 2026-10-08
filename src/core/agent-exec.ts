// Running a command AS THE AGENT.
//
// In sandbox mode the daemon runs as root inside its container, holding only
// CAP_SETUID, CAP_SETGID and CAP_KILL. Everything that touches a tree the agent
// controls — spawning the CLI, cloning its tree, reading its outbox, writing its
// attachments — runs through `setprivArgv` below, so it happens with the agent's
// uid and gid, no supplementary groups, and no capabilities at all. The agent's
// own file permissions are then the whole boundary: a symlink it plants can only
// lead somewhere it could already read or write itself.
//
// This is the ONE place the wrapper is spelled. The spawn hook in the Claude Code
// adapter, `AgentTreeIO`, and the sandbox worktree strategy all build on it, so
// the three can never disagree about which privileges were dropped.

/** Who the agent runs as. Present only when `[sandbox]` is configured. */
export interface SandboxIdentity {
  agentUid: number;
  agentGid: number;
  /** Absolute HOME for the agent; must be writable by `agentUid`. */
  agentHome: string;
}

/**
 * `setpriv … -- <argv>`. PURE, so the exact privilege drop is unit-testable
 * without being root.
 *
 * `--clear-groups` matters as much as the uid: root's supplementary groups would
 * otherwise ride along. `--inh-caps=-all` and `--ambient-caps=-all` make sure no
 * capability survives the exec — a setuid to a non-zero uid clears the permitted
 * and effective sets, but the inheritable and ambient sets are what a later exec
 * could pick up again. The container's `no-new-privileges` is what stops a setuid
 * binary inside the image from undoing all of this.
 */
export function setprivArgv(id: SandboxIdentity, argv: string[]): string[] {
  return [
    "setpriv",
    `--reuid=${id.agentUid}`,
    `--regid=${id.agentGid}`,
    "--clear-groups",
    "--inh-caps=-all",
    "--ambient-caps=-all",
    "--",
    ...argv,
  ];
}

/**
 * The environment a helper command gets when it runs as the agent: PATH, HOME and
 * a C locale, nothing else.
 *
 * Deliberately NOT the daemon's environment. A process running as the agent's uid
 * exposes `/proc/<pid>/environ` to every other process of that uid, so anything
 * here is readable by the agent's shell — including the Slack tokens the daemon
 * holds. The C locale keeps `find`/`realpath` output byte-exact.
 */
export function agentHelperEnv(id: SandboxIdentity): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: id.agentHome,
    LC_ALL: "C",
  };
}

export interface RunResult {
  code: number;
  stdout: Uint8Array;
  stderr: string;
}

export interface RunOptions {
  /** Bytes to feed on stdin; omitted = no stdin. */
  stdin?: Uint8Array;
  cwd?: string;
}

/** Runs an argv to completion. Injectable so tests never need real setuid. */
export type CommandRunner = (argv: string[], opts?: RunOptions) => Promise<RunResult>;
/** The synchronous twin, for the one caller whose port contract is synchronous. */
export type SyncCommandRunner = (argv: string[], opts?: RunOptions) => RunResult;

function spawnAsync(argv: string[], env: Record<string, string> | undefined, opts: RunOptions = {}): Promise<RunResult> {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env,
    stdin: opts.stdin ? opts.stdin : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).then(([out, err, code]) => ({ code, stdout: new Uint8Array(out), stderr: err }));
}

/** Runs the argv as-is, with the daemon's own privileges and environment. */
export const directRunner: CommandRunner = (argv, opts) => spawnAsync(argv, undefined, opts);

/**
 * Runs the argv as the agent. The cwd defaults to `/` because the daemon's own
 * working directory need not be readable by the agent's uid, and git in particular
 * fails confusingly when it cannot stat its cwd.
 */
export function agentRunner(id: SandboxIdentity): CommandRunner {
  return (argv, opts = {}) =>
    spawnAsync(setprivArgv(id, argv), agentHelperEnv(id), { ...opts, cwd: opts.cwd ?? "/" });
}

export function agentRunnerSync(id: SandboxIdentity): SyncCommandRunner {
  return (argv, opts = {}) => {
    const res = Bun.spawnSync(setprivArgv(id, argv), {
      cwd: opts.cwd ?? "/",
      env: agentHelperEnv(id),
      stdin: opts.stdin ? opts.stdin : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: res.exitCode ?? 1,
      stdout: new Uint8Array(res.stdout ?? new Uint8Array()),
      stderr: res.stderr ? new TextDecoder().decode(res.stderr) : "",
    };
  };
}

/**
 * Prove at boot that the daemon can actually become the agent. Without this a
 * container started without CAP_SETUID — or without `setpriv` in the image — would
 * boot fine and then fail every assign with an opaque spawn error.
 *
 * Throws with the fix in the message. `run` is injectable for tests; production
 * runs the real `setpriv`.
 */
export async function proveCanDropPrivileges(
  id: SandboxIdentity,
  run: CommandRunner = directRunner,
): Promise<void> {
  const argv = setprivArgv(id, ["true"]);
  let res: RunResult;
  try {
    res = await run(argv, { cwd: "/" });
  } catch (err) {
    throw new Error(
      `[sandbox] could not run setpriv (${err instanceof Error ? err.message : err}). The image needs ` +
        `util-linux's setpriv on PATH.`,
    );
  }
  if (res.code !== 0) {
    throw new Error(
      `[sandbox] cannot drop privileges to uid ${id.agentUid} / gid ${id.agentGid}: \`${argv.join(" ")}\` ` +
        `exited ${res.code}${res.stderr.trim() ? ` (${res.stderr.trim()})` : ""}. Run the daemon as root in ` +
        `its container with \`--cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add KILL ` +
        `--security-opt no-new-privileges\`, or remove [sandbox] from condotto.toml.`,
    );
  }
}

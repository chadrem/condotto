// Runs a repo's configured land/deploy/test command in its worktree (M3,
// DESIGN §2 journey 4). Distinct from the harness/agent shell: the command is
// authoritative repo config, never agent-chosen, and it only ever executes
// after an architect approves it through the gate. Build-time safety: on the
// throwaway repo these are `echo` no-ops until M4 (see config.ts).
//
// Not a platform seam — this is a core capability, like the git calls in
// worktrees.ts. It stays free of Slack/SDK types.

export interface CommandResult {
  /** Process exit code (0 = success); null if killed by the timeout. */
  code: number | null;
  /** Combined stdout+stderr, trimmed and byte-bounded. */
  output: string;
  timedOut: boolean;
}

export interface CommandRunnerLike {
  run(command: string, cwd: string): Promise<CommandResult>;
}

/**
 * The daemon's OWN secrets — never handed to a repo's deploy command. A real
 * deploy needs its own scoped credentials (M4), not Conduit's chat/AI tokens;
 * scrubbing these keeps a misbehaving deploy command from exfiltrating them.
 */
export const DEFAULT_SCRUB_ENV = [
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
];

export class CommandRunner implements CommandRunnerLike {
  constructor(
    private opts: { timeoutMs?: number; maxOutputBytes?: number; scrubEnv?: string[] } = {},
  ) {}

  async run(command: string, cwd: string): Promise<CommandResult> {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const key of this.opts.scrubEnv ?? DEFAULT_SCRUB_ENV) delete env[key];

    const proc = Bun.spawn(["/bin/sh", "-c", command], {
      cwd,
      env: env as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeoutMs = this.opts.timeoutMs ?? 5 * 60_000;
    // NOTE (M3): output is read fully into memory then byte-bounded. Fine for the
    // trusted, echo/no-op land/deploy commands here; a real deploy path (M4)
    // should stream-bound to defend against an output flood.
    const readAll = Promise.all([
      new Response(proc.stdout).text().catch(() => ""),
      new Response(proc.stderr).text().catch(() => ""),
    ]).then(([o, e]) => o + e);

    // Race the read against a hard deadline. run() MUST always settle within the
    // timeout — if a killed shell's surviving child kept the pipe open, awaiting
    // stream EOF would hang forever, and the caller (runShip) would hold its
    // concurrency slot and wedge the session. On timeout we SIGKILL and return
    // whatever was buffered.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });

    const bound = (s: string): string => {
      const trimmed = s.trim();
      const max = this.opts.maxOutputBytes ?? 16_000;
      return trimmed.length > max ? trimmed.slice(0, max) + "\n… (truncated)" : trimmed;
    };

    const outcome = await Promise.race([readAll.then((o) => ({ o }) as const), deadline]);
    clearTimeout(timer);

    if (outcome === "timeout") {
      try {
        proc.kill(9); // SIGKILL — the shell can't ignore it
      } catch {
        /* already gone */
      }
      // Grab anything already buffered, but never wait indefinitely for EOF.
      const partial = await Promise.race([
        readAll,
        new Promise<string>((r) => setTimeout(() => r(""), 500)),
      ]);
      return { code: null, output: bound(partial), timedOut: true };
    }

    const code = await proc.exited;
    return { code, output: bound(outcome.o), timedOut: false };
  }
}

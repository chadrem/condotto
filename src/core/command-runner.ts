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
    let timedOut = false;
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return; // don't kill / mismark a process that already exited
      timedOut = true;
      proc.kill();
    }, timeoutMs);

    // NOTE (M3): output is read fully into memory then byte-bounded. Fine for the
    // trusted, echo/no-op land/deploy commands here; a real deploy path (M4)
    // should stream-bound to defend against an output flood.
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    finished = true;
    clearTimeout(timer);

    let output = (stdout + stderr).trim();
    const max = this.opts.maxOutputBytes ?? 16_000;
    if (output.length > max) output = output.slice(0, max) + "\n… (truncated)";

    return { code: timedOut ? null : code, output, timedOut };
  }
}

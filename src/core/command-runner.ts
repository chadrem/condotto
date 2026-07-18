// Runs a repo's configured land/deploy/test command in its worktree (M3,
// DESIGN §2 journey 4). Distinct from the harness/agent shell: the command is
// authoritative repo config, never agent-chosen, and it only ever executes
// after an architect approves it through the gate. Build-time safety: on the
// throwaway repo these are `echo` no-ops until M4 (see config.ts).
//
// Not a platform seam — this is a core capability, like the git calls in
// worktrees.ts. It stays free of Slack/SDK types.

export interface CommandResult {
  /** Process exit code (0 = success); null if killed by the timeout or overflow. */
  code: number | null;
  /** Combined stdout+stderr, byte-bounded (streamed, never fully buffered). */
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

/**
 * Read a stream up to `maxBytes`, decoding incrementally and STOPPING once the
 * cap is reached (peak memory is bounded, never the full output — a runaway
 * command can't OOM the daemon). Returns whether it overflowed.
 */
async function drainBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ text: string; overflow: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let total = 0;
  let overflow = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength <= maxBytes) {
        total += value.byteLength;
        parts.push(decoder.decode(value, { stream: true }));
      } else {
        parts.push(decoder.decode(value.slice(0, maxBytes - total)));
        overflow = true;
        break; // stop reading; the caller kills the process
      }
    }
  } catch {
    /* stream errored (e.g. process killed) — return what we have */
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  return { text: parts.join(""), overflow };
}

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
    const maxOut = this.opts.maxOutputBytes ?? 16_000;

    // Read both streams with per-stream byte caps, and race the whole read
    // against a hard deadline — run() MUST always settle within the timeout, or a
    // killed shell's surviving child holding the pipe would hang the caller
    // (runShip) forever, leaking its concurrency slot and wedging the session.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const collect = Promise.all([drainBounded(proc.stdout, maxOut), drainBounded(proc.stderr, maxOut)]);

    const outcome = await Promise.race([collect.then((v) => ({ kind: "done" as const, v })), deadline]);
    clearTimeout(timer);

    if (outcome === "timeout") {
      try {
        proc.kill(9); // SIGKILL — the shell can't ignore it
      } catch {
        /* already gone */
      }
      const partial = await Promise.race([
        collect.then(([o, e]) => (o.text + "\n" + e.text).trim()),
        new Promise<string>((r) => setTimeout(() => r("(timed out)"), 500)),
      ]);
      return { code: null, output: partial.slice(0, maxOut + 32), timedOut: true };
    }

    const [out, err] = outcome.v;
    const overflow = out.overflow || err.overflow;
    if (overflow) {
      try {
        proc.kill(9);
      } catch {
        /* already gone */
      }
    }
    const code = overflow ? null : await proc.exited;
    let output = (out.text + err.text).trim();
    if (overflow) output += "\n… (truncated: output limit exceeded, process killed)";
    return { code, output, timedOut: false };
  }
}

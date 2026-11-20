// The daemon under test, as a child process: start it, know when it is ready,
// stop it, start it again. Its stdout and stderr go to one log file for the run,
// appended across restarts so a scenario that restarts it keeps one story.
import { createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { type E2eEnv, REPO_ROOT } from "./env";

/** Logged by daemon.ts once Socket Mode is up and the core is listening. */
const READY = "[daemon] ready";
const READY_TIMEOUT_MS = 90_000;
const STOP_TIMEOUT_MS = 20_000;

export class Daemon {
  private proc: Subprocess<"ignore", "pipe", "pipe"> | null = null;
  private readonly log: WriteStream;
  private exitCode: number | null = null;
  /** The stdout/stderr readers; the log is complete only once both have drained. */
  private pumps: Promise<void>[] = [];

  constructor(
    private readonly env: E2eEnv,
    readonly logPath: string,
  ) {
    this.log = createWriteStream(logPath, { flags: "a" });
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  /** Resolves once the daemon logs ready; rejects if it exits or stalls first. */
  async start(): Promise<void> {
    if (this.proc) throw new Error("the daemon is already running");
    this.log.write(`\n===== e2e: starting the daemon at ${new Date().toISOString()} =====\n`);
    const proc = Bun.spawn([process.execPath, "run", join(REPO_ROOT, "src", "daemon.ts"), "--config", this.env.configPath], {
      cwd: REPO_ROOT,
      env: this.env.childEnv,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.proc = proc;
    this.exitCode = null;

    let markReady: () => void = () => {};
    const ready = new Promise<void>((r) => {
      markReady = r;
    });
    const pump = async (stream: ReadableStream<Uint8Array>, watch: boolean): Promise<void> => {
      const decoder = new TextDecoder();
      let tail = "";
      for await (const chunk of stream) {
        const text = decoder.decode(chunk, { stream: true });
        this.log.write(text);
        if (watch) {
          tail = (tail + text).slice(-4096);
          if (tail.includes(READY)) markReady();
        }
      }
    };
    this.pumps = [pump(proc.stdout, true).catch(() => {}), pump(proc.stderr, false).catch(() => {})];
    const exited = proc.exited.then((code) => {
      this.exitCode = code;
      if (this.proc === proc) this.proc = null;
      return code;
    });

    let timer: Timer | undefined;
    const outcome = await Promise.race([
      ready.then(() => "ready" as const),
      exited.then(() => "exited" as const),
      new Promise<"timeout">((r) => {
        timer = setTimeout(() => r("timeout"), READY_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (outcome === "ready") return;
    if (outcome === "timeout") await this.stop();
    throw new Error(
      outcome === "exited"
        ? `the daemon exited with code ${this.exitCode} before it was ready; see ${this.logPath}`
        : `the daemon was not ready after ${READY_TIMEOUT_MS / 1000}s; see ${this.logPath}`,
    );
  }

  /** SIGTERM, which daemon.ts handles like SIGINT; SIGKILL if it hangs. */
  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) {
      await Promise.all(this.pumps); // it exited on its own; still drain the log
      return;
    }
    proc.kill("SIGTERM");
    let timer: Timer | undefined;
    const done = await Promise.race([
      proc.exited.then(() => true),
      new Promise<false>((r) => {
        timer = setTimeout(() => r(false), STOP_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (!done) {
      proc.kill("SIGKILL");
      await proc.exited;
    }
    // Exit can land before the pipes are read dry; the last lines are often the
    // ones that explain a failure.
    await Promise.all(this.pumps);
    this.proc = null;
  }

  /**
   * Last resort for a supervisor that is dying: signal the child synchronously,
   * from an `exit` handler where nothing can be awaited. SIGTERM, so the daemon
   * still closes its Socket Mode connection on the operator's app.
   */
  killNow(): void {
    this.proc?.kill("SIGTERM");
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /** Resolves when the daemon exits on its own, for a supervisor to wait on. */
  async exited(): Promise<number> {
    return this.proc ? await this.proc.exited : (this.exitCode ?? 0);
  }

  close(): Promise<void> {
    return new Promise((r) => this.log.end(r));
  }
}

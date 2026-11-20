// What a scenario is written against: a context for one scenario, and the Slack
// threads it drives.
//
// A scenario talks to Condotto only the way a person would, by posting into a
// thread, and checks what came of it in three places: the thread, the session's
// worktree, and the store. The store says when a turn is over and what it did;
// the thread is checked for what a person would have seen.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditRow, SessionRow, StoreReader } from "./db";
import type { Daemon } from "./daemon";
import type { E2eEnv, E2eSettings } from "./env";
import type { SlackApi, SlackMessage } from "./slack";

export interface Scenario {
  name: string;
  /** One line on what it proves; shown in the report. */
  about: string;
  timeoutMs?: number;
  run(t: Context): Promise<void>;
}

/** Identity for type inference in scenario files. */
export const scenario = (s: Scenario): Scenario => s;

export class AssertionError extends Error {}
export class SkipError extends Error {}

export interface Identities {
  condotto: string;
  tester: string;
  outsider?: string;
}

export type Speaker = "tester" | "outsider";

export interface TurnResult {
  /** True when the turn ended in a reply, false when it ended in an error. */
  ok: boolean;
  /** The agent's own text from the store, before Slack rendering and the footer. */
  reply: string;
  costUsd: number;
  /** The message that carried the result into the thread. */
  posted: SlackMessage;
}

const POLL_MS = 1500;
const COMMAND_TIMEOUT_MS = 60_000;
const TURN_TIMEOUT_MS = 5 * 60_000;

/**
 * A status line still in the thread. Condotto posts one for a turn that takes
 * steps (`describeToolUse` in the Claude Code adapter names them) and deletes it
 * once the reply is up, so after a turn none may remain. Matched as the whole
 * message (`statusText` in the session manager: glyph, step, optional quoted
 * description, optional clock), so a reply that merely starts "Working tree is
 * clean" is not mistaken for one.
 */
const STATUS_LINE =
  /^(?::[a-z0-9_+'-]+: |⏳ )?(?:Started|Thinking|Working|Reading code|Searching the code|Editing files|Running a command|Working with a helper|Running a workflow|Looking something up|Planning the next steps|Using a skill|Waiting for another thread to finish|Finished)(?:: “[^”\n]*”)?(?: · \d+[dhms](?: \d+[dhms])?)?$/;

/** A message that ends a turn: the reply's cost footer, or an error/stop marker. */
const TURN_END = /this turn|this thread|^⚠️|^⛔|^⏹️/m;

/** Fail the scenario unless `cond` holds. A function, not a method, so it narrows. */
export function expect(cond: unknown, message: string): asserts cond {
  if (!cond) throw new AssertionError(message);
}

export const isStatusLine = (m: SlackMessage): boolean => STATUS_LINE.test(m.text ?? "");

/** Raised inside a scenario the runner has given up on, so it stops acting. */
export class AbortedError extends Error {}

export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw new AbortedError(`aborted while waiting for ${what}`);
    const v = await probe();
    if (v) return v;
    if (Date.now() > deadline) throw new AssertionError(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}`);
    await Bun.sleep(POLL_MS);
  }
}

export class Context {
  readonly threads: Thread[] = [];
  private readonly abortController = new AbortController();

  constructor(
    readonly name: string,
    readonly runId: string,
    readonly settings: E2eSettings,
    readonly env: Pick<E2eEnv, "repoName">,
    /** Null when driving a daemon someone else supervises (the CLI). */
    readonly daemon: Daemon | null,
    readonly ids: Identities,
    readonly tester: SlackApi,
    readonly outsider: SlackApi | null,
    readonly db: StoreReader,
    private readonly say: (line: string) => void,
  ) {}

  /**
   * Stop this scenario from doing anything further. The runner calls it when the
   * scenario overruns, so a late step can't act on the next scenario's daemon.
   */
  abort(): void {
    this.abortController.abort();
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /** `waitFor`, ending early once the scenario is aborted. */
  waitFor<T>(
    what: string,
    probe: () => Promise<T | null | undefined | false> | T | null | undefined | false,
    timeoutMs: number,
  ): Promise<T> {
    return waitFor(what, probe, timeoutMs, this.signal);
  }

  /** A pause that ends early, and throws, once the scenario is aborted. */
  async sleep(ms: number): Promise<void> {
    await this.waitFor(`${ms / 1000}s to pass`, ((end) => () => Date.now() >= end)(Date.now() + ms), ms + POLL_MS * 2);
  }

  /** `<@Condotto>`, as a message must begin for Condotto to read it as a command. */
  get mention(): string {
    return `<@${this.ids.condotto}>`;
  }

  note(line: string): void {
    this.say(`    ${line}`);
  }

  skip(reason: string): never {
    throw new SkipError(reason);
  }

  /** A new top-level message, whose thread nothing has been said in yet. */
  async newThread(label?: string): Promise<Thread> {
    const seed = `e2e ${this.runId} · ${this.name}${label ? ` · ${label}` : ""}`;
    const ts = await this.tester.post(this.settings.channel, seed);
    const thread = new Thread(this, ts);
    this.threads.push(thread);
    return thread;
  }

  /** A new thread with Condotto assigned to the fixture repo. */
  async assignedThread(label?: string): Promise<Thread> {
    const thread = await this.newThread(label);
    await thread.command(`assign ${this.env.repoName}`, /I'm on it/);
    expect(thread.sessionOrNull(), "assign was acknowledged but no session row exists");
    return thread;
  }

  async restartDaemon(): Promise<void> {
    if (!this.daemon) throw new Error("this context does not own the daemon, so it cannot restart it");
    if (this.signal.aborted) throw new AbortedError("aborted before restarting the daemon");
    this.note("restarting the daemon");
    await this.daemon.restart();
  }

  /** Session ids of every thread this scenario touched, for its cost. */
  sessionIds(): string[] {
    return this.threads.map((t) => t.sessionOrNull()?.id).filter((id): id is string => !!id);
  }
}

export class Thread {
  constructor(
    private readonly t: Context,
    readonly root: string,
  ) {}

  /** The core's id for this conversation (`<channel>:<thread_ts>`). */
  get conversationId(): string {
    return `${this.t.settings.channel}:${this.root}`;
  }

  private api(as: Speaker): SlackApi {
    if (as === "tester") return this.t.tester;
    return this.t.outsider ?? this.t.skip("no tester_user_token, so there is no outsider to post as");
  }

  async say(text: string, as: Speaker = "tester"): Promise<string> {
    return this.api(as).post(this.t.settings.channel, text, this.root);
  }

  /**
   * `@Condotto <text>` in the thread. With `expect`, waits for Condotto's answer
   * matching it and returns that post.
   */
  async command(text: string, expect?: RegExp, as: Speaker = "tester"): Promise<SlackMessage | null> {
    const ts = await this.say(`${this.t.mention} ${text}`, as);
    return expect ? this.waitForPost(expect, { after: ts }) : null;
  }

  async messages(): Promise<SlackMessage[]> {
    return this.t.tester.replies(this.t.settings.channel, this.root);
  }

  /** Condotto's posts in this thread, optionally only those after a ts. */
  async condottoPosts(after?: string): Promise<SlackMessage[]> {
    return (await this.messages()).filter((m) => m.user === this.t.ids.condotto && (!after || m.ts > after));
  }

  async waitForPost(re: RegExp, opts: { after?: string; timeoutMs?: number } = {}): Promise<SlackMessage> {
    return this.t.waitFor(
      `Condotto to post ${re}`,
      async () => (await this.condottoPosts(opts.after)).find((m) => re.test(m.text ?? "")),
      opts.timeoutMs ?? COMMAND_TIMEOUT_MS,
    );
  }

  sessionOrNull(): SessionRow | null {
    return this.t.db.session(this.conversationId);
  }

  session(): SessionRow {
    const s = this.sessionOrNull();
    if (!s) throw new AssertionError("this thread has no session");
    return s;
  }

  audit(event?: string, after = 0): AuditRow[] {
    return this.t.db.audits(this.session().id, { after, ...(event ? { event } : {}) });
  }

  /** A file in the session's worktree, or null when it is not there. */
  file(rel: string): string | null {
    const p = join(this.session().worktree_path, rel);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  }

  /** Post `text` and wait for the turn it starts to finish. */
  async turn(text: string, opts: { as?: Speaker; timeoutMs?: number } = {}): Promise<TurnResult> {
    return this.runTurn(() => this.say(text, opts.as), opts.timeoutMs);
  }

  /** Drop a file into the thread with a message, and wait for the turn. */
  async uploadTurn(filename: string, content: string, text: string, timeoutMs?: number): Promise<TurnResult> {
    return this.runTurn(async () => {
      const before = (await this.messages()).at(-1)?.ts ?? this.root;
      await this.t.tester.upload(this.t.settings.channel, this.root, filename, content, text);
      return before;
    }, timeoutMs);
  }

  /**
   * Run a turn to completion. Over means the store recorded how it ended (a reply
   * or an error) and the session has left 'active', which happens only after the
   * outbox is flushed. Then the thread must show the result and no status line.
   */
  private async runTurn(trigger: () => Promise<string>, timeoutMs = TURN_TIMEOUT_MS): Promise<TurnResult> {
    const session = this.session();
    const auditBase = this.t.db.lastAuditId();
    const turnBase = this.t.db.lastTurnId();
    const after = await trigger();

    const ends = await this.t.waitFor(
      "the turn to finish",
      () => {
        const done = this.t.db
          .audits(session.id, { after: auditBase })
          .filter((a) => a.event === "message_out" || a.event === "error");
        return done.length && this.sessionOrNull()?.status !== "active" ? done : null;
      },
      timeoutMs,
    );
    const outs = this.t.db.turns(session.id, { afterTurnId: turnBase }).filter((r) => r.direction === "out");
    const costUsd = outs.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);
    const success = outs.find((r) => r.result_subtype === "success" && r.text !== "(unposted reply)");
    const error = ends.find((a) => a.event === "error");
    const reply = success?.text ?? String(error?.detail.message ?? error?.detail.text ?? "");

    const posted = await this.t.waitFor(
      "the result in the thread, with the status line gone",
      async () => {
        const posts = await this.condottoPosts(after);
        if (posts.some(isStatusLine)) return null;
        return posts.filter((m) => TURN_END.test(m.text ?? "")).at(-1);
      },
      COMMAND_TIMEOUT_MS,
    );
    return { ok: !!success, reply, costUsd, posted };
  }

  async permalink(): Promise<string> {
    return this.t.tester.permalink(this.t.settings.channel, this.root);
  }
}

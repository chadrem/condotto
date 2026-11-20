// Driving the e2e daemon by hand, one message at a time, to explore before a
// scenario exists. Same world as `bun run e2e` (see run.ts for setup).
//
//   bun run e2e:up                              fresh world, daemon up; stays in the foreground
//   bun run e2e:say "<text>"                    say it in the "main" thread, wait, print Condotto's posts
//   bun run e2e:say -t other "@Condotto plan on"  another thread (created and assigned on first use)
//   bun run e2e:say --as outsider "<text>"      post as the outsider (needs tester_user_token)
//   bun run e2e:threads                         every thread so far, with links
//   bun run e2e:down                            stop the daemon
//
// A message starting "@Condotto " is sent as a command, with the mention Condotto
// reads. Anything else is ordinary conversation in the thread.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Daemon } from "./lib/daemon";
import { StoreReader } from "./lib/db";
import { assertNoOtherDaemon, e2eHome, loadSettings, newRunDir, prepareEnv } from "./lib/env";
import { SlackApi } from "./lib/slack";
import { Context, type Identities, isStatusLine, type Speaker, Thread, waitFor } from "./lib/thread";

interface State {
  supervisorPid: number;
  runId: string;
  runDir: string;
  dbPath: string;
  repoName: string;
  ids: Identities;
  /** Alias → thread root ts. */
  threads: Record<string, string>;
}

const statePath = (): string => join(e2eHome(), "cli-state.json");
const readState = (): State => {
  if (!existsSync(statePath())) throw new Error("No e2e daemon is up. Start one with `bun run e2e:up`.");
  return JSON.parse(readFileSync(statePath(), "utf8")) as State;
};
const writeState = (s: State): void => writeFileSync(statePath(), JSON.stringify(s, null, 2));

/** How long Condotto must stay quiet before an exchange counts as over. */
const QUIET_MS = 6000;
/** How long a message that gets no answer at all waits before saying so. */
const NO_REPLY_MS = 20_000;

async function up(): Promise<void> {
  if (existsSync(statePath())) {
    const s = JSON.parse(readFileSync(statePath(), "utf8")) as State;
    if (alive(s.supervisorPid)) throw new Error(`An e2e daemon is already up (supervisor pid ${s.supervisorPid}).`);
  }
  const settings = loadSettings();
  assertNoOtherDaemon();
  const tester = new SlackApi(settings.testerBotToken);
  const testerId = await tester.whoAmI();
  const env = await prepareEnv(settings, testerId);
  const ids: Identities = {
    condotto: await new SlackApi(env.condottoBotToken).whoAmI(),
    tester: testerId,
    ...(settings.testerUserToken ? { outsider: await new SlackApi(settings.testerUserToken).whoAmI() } : {}),
  };
  const runId = `cli-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-")}`;
  const runDir = newRunDir(runId);
  const daemon = new Daemon(env, join(runDir, "daemon.log"));
  // The daemon must not outlive this supervisor, however it dies: it holds a
  // Socket Mode connection on the operator's app.
  process.on("exit", () => daemon.killNow());
  await daemon.start();
  writeState({ supervisorPid: process.pid, runId, runDir, dbPath: env.dbPath, repoName: env.repoName, ids, threads: {} });
  console.log(`e2e daemon up (pid ${daemon.pid}). Log: ${daemon.logPath}`);
  console.log("Drive it with `bun run e2e:say`, stop it with `bun run e2e:down` or Ctrl-C.");

  let stopping = false;
  const stop = async (code: number): Promise<never> => {
    stopping = true;
    await daemon.stop();
    await daemon.close();
    rmSync(statePath(), { force: true });
    process.exit(code);
  };
  process.on("SIGINT", () => void stop(0));
  process.on("SIGTERM", () => void stop(0));
  for (const event of ["uncaughtException", "unhandledRejection"] as const) {
    process.on(event, (e) => {
      console.error(`e2e supervisor crashed (${event}):`, e);
      void stop(1);
    });
  }
  const code = await daemon.exited();
  if (stopping) return; // the signal handler is shutting down; it exits
  console.error(`The daemon exited on its own (code ${code}). See ${daemon.logPath}`);
  await stop(1);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function context(state: State): Context {
  const settings = loadSettings();
  return new Context(
    "cli",
    state.runId,
    settings,
    { repoName: state.repoName },
    null,
    state.ids,
    new SlackApi(settings.testerBotToken),
    settings.testerUserToken ? new SlackApi(settings.testerUserToken) : null,
    new StoreReader(state.dbPath),
    (l) => console.log(l),
  );
}

async function say(argv: string[]): Promise<void> {
  let alias = "main";
  let as: Speaker = "tester";
  let timeoutSec = 600;
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-t" || a === "--thread") alias = argv[++i] ?? alias;
    else if (a === "--as") as = argv[++i] === "outsider" ? "outsider" : "tester";
    else if (a === "--timeout") {
      timeoutSec = Number(argv[++i]);
      if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) throw new Error("--timeout takes a number of seconds");
    }
    else words.push(a);
  }
  const text = words.join(" ").trim();
  if (!text) throw new Error('Nothing to say. Usage: bun run e2e:say [-t alias] [--as outsider] "<text>"');

  const state = readState();
  const t = context(state);
  let thread: Thread;
  const root = state.threads[alias];
  if (root) {
    thread = new Thread(t, root);
  } else {
    console.log(`(new thread "${alias}", assigning ${state.repoName})`);
    thread = await t.assignedThread(alias);
    state.threads[alias] = thread.root;
    writeState(state);
  }

  const command = text.match(/^@condotto\s+(.*)$/is);
  const sent = await thread.say(command ? `${t.mention} ${command[1]}` : text, as);
  const sessionId = thread.sessionOrNull()?.id;
  const turnBase = t.db.lastTurnId();

  // Over when nothing is running, no status line is left, and the thread has been
  // quiet for a while: briefly once Condotto has said something, longer when it
  // has said nothing (a message it rightly ignores). That covers commands, turns
  // and messages that never become turns, without knowing which this was.
  let lastSeen = "";
  let quietSince = Date.now();
  const posts = await waitFor(
    "Condotto to finish answering",
    async () => {
      const mine = await thread.condottoPosts(sent);
      const fingerprint = mine.map((m) => `${m.ts}:${m.text}`).join("|");
      if (fingerprint !== lastSeen) {
        lastSeen = fingerprint;
        quietSince = Date.now();
        return null;
      }
      const busy = thread.sessionOrNull()?.status === "active" || mine.some(isStatusLine);
      const quietFor = mine.length ? QUIET_MS : NO_REPLY_MS;
      return !busy && Date.now() - quietSince > quietFor ? mine : null;
    },
    timeoutSec * 1000,
  );
  if (!posts.length) console.log("\n(no reply: Condotto did not answer that)");
  for (const m of posts) {
    const files = m.files?.length ? ` [files: ${m.files.map((f) => f.name ?? f.id).join(", ")}]` : "";
    console.log(`\n— Condotto${files}:\n${m.text ?? ""}`);
  }
  const id = sessionId ?? thread.sessionOrNull()?.id;
  if (id) {
    const usd = t.db.turns(id, { afterTurnId: turnBase }).reduce((s, r) => s + (r.cost_usd ?? 0), 0);
    if (usd > 0) console.log(`\n($${usd.toFixed(2)} this exchange)`);
  }
}

async function threads(): Promise<void> {
  const state = readState();
  const t = context(state);
  for (const [alias, root] of Object.entries(state.threads)) {
    console.log(`${alias}: ${await new Thread(t, root).permalink()}`);
  }
}

function down(): void {
  const state = readState();
  if (!alive(state.supervisorPid)) {
    rmSync(statePath(), { force: true });
    console.log("Nothing was running; cleared the stale state.");
    return;
  }
  process.kill(state.supervisorPid, "SIGTERM");
  console.log(`Stopping the e2e daemon (supervisor pid ${state.supervisorPid}).`);
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === "up") await up();
  else if (cmd === "say") await say(rest);
  else if (cmd === "threads") await threads();
  else if (cmd === "down") down();
  else {
    console.error("Usage: bun run scripts/e2e/cli.ts up|say|threads|down");
    process.exit(2);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

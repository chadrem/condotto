// End-to-end suite: the real daemon, the real agent, driven through real Slack.
//
//   bun run e2e                     every scenario, in order
//   bun run e2e assign-edit budget  just these
//   bun run e2e --keep              leave the daemon up afterwards (Ctrl-C stops it)
//
// Each run wipes ~/.cache/condotto-e2e (CONDOTTO_E2E_HOME), keeping only earlier
// runs' reports, and rebuilds it: the smoke fixture repo, a fresh store, worktrees
// and memory. The daemon under test gets a generated config whose only architect
// is the tester bot, in the test channel only. Every scenario starts its own
// thread. Results, thread links and the daemon's log land in
// ~/.cache/condotto-e2e/runs/<run id>/. It costs real money (each scenario
// prints what it spent) and needs Slack, so it is not part of `bun run ci`.
//
// One-time setup:
//   1. Create the tester app at api.slack.com/apps → Create New App → From a
//      manifest, pasting scripts/e2e/tester-manifest.json. Install it to the
//      workspace, then copy the Bot User OAuth Token (xoxb-) and the User OAuth
//      Token (xoxp-) from OAuth & Permissions.
//   2. Create a test channel and invite both @Condotto and the tester bot.
//   3. Put the channel id and both tokens in condotto.e2e.toml at the repo root
//      (gitignored). The user token is optional; without it the who-is-heard
//      scenario is skipped. It posts as the person who installed the tester app,
//      who is an outsider in the generated config.
//   4. The e2e daemon runs as the operator's own Condotto app, with the Claude
//      credential condotto.toml resolves. Its Slack tokens come from condotto.toml
//      (or SLACK_BOT_TOKEN / SLACK_APP_TOKEN), unless condotto.e2e.toml sets
//      condotto_bot_token and condotto_app_token, which win.
//
// The e2e daemon connects with the operator's own Condotto app. Socket Mode gives
// each event to only one of an app's open connections, so no other Condotto daemon
// may be connected while a run is live, on this machine or any other. This machine
// is checked; others can't be. And while a run is live, a real person who mentions
// @Condotto elsewhere reaches the e2e daemon, where they are not an architect.
import { join } from "node:path";
import { Daemon } from "./lib/daemon";
import { StoreReader } from "./lib/db";
import { assertNoOtherDaemon, loadSettings, newRunDir, prepareEnv } from "./lib/env";
import { SlackApi } from "./lib/slack";
import { AssertionError, Context, type Identities, SkipError } from "./lib/thread";
import { SCENARIOS } from "./scenarios";

const DEFAULT_SCENARIO_TIMEOUT_MS = 10 * 60_000;
/** How long an overrun scenario gets to notice it was aborted and unwind. */
const ABORT_GRACE_MS = 30_000;

interface Result {
  name: string;
  status: "pass" | "fail" | "skip";
  seconds: number;
  costUsd: number;
  threads: string[];
  error?: string;
}

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const wanted = args.filter((a) => !a.startsWith("--"));
const unknown = wanted.filter((n) => !SCENARIOS.some((s) => s.name === n));
if (unknown.length) {
  console.error(`Unknown scenario: ${unknown.join(", ")}. Available: ${SCENARIOS.map((s) => s.name).join(", ")}`);
  process.exit(2);
}
const selected = wanted.length ? SCENARIOS.filter((s) => wanted.includes(s.name)) : SCENARIOS;

const settings = loadSettings();
assertNoOtherDaemon();
const tester = new SlackApi(settings.testerBotToken);
const outsider = settings.testerUserToken ? new SlackApi(settings.testerUserToken) : null;
const testerId = await tester.whoAmI();
const env = await prepareEnv(settings, testerId);
const ids: Identities = {
  condotto: await new SlackApi(env.condottoBotToken).whoAmI(),
  tester: testerId,
  ...(outsider ? { outsider: await outsider.whoAmI() } : {}),
};

const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
const runDir = newRunDir(runId);
const daemon = new Daemon(env, join(runDir, "daemon.log"));
const db = new StoreReader(env.dbPath);

console.log(`e2e run ${runId}: ${selected.length} scenario(s), model ${settings.model}/${settings.effort}`);
console.log(`  reports and daemon log: ${runDir}`);
console.log("  (no other Condotto daemon may be connected to this Slack app, on any machine)");

let stopping = false;
const shutdown = async (code: number): Promise<never> => {
  stopping = true;
  await daemon.stop();
  await daemon.close();
  process.exit(code);
};
process.on("SIGINT", () => void shutdown(130));
process.on("SIGTERM", () => void shutdown(143));
// However the runner dies, the daemon must not outlive it: it holds a Socket
// Mode connection on the operator's app and would keep taking its events.
process.on("exit", () => daemon.killNow());
for (const event of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(event, (e) => {
    console.error(`e2e runner crashed (${event}):`, e);
    void shutdown(1);
  });
}

await daemon.start();
console.log(`  daemon ready (pid ${daemon.pid})\n`);

const results: Result[] = [];
for (const s of selected) {
  if (stopping) break;
  console.log(`▶ ${s.name}: ${s.about}`);
  const t = new Context(s.name, runId, settings, env, daemon, ids, tester, outsider, db, (l) => console.log(l));
  const started = Date.now();
  let status: Result["status"] = "pass";
  let error: string | undefined;
  let timer: Timer | undefined;
  const running = s.run(t);
  try {
    const limit = s.timeoutMs ?? DEFAULT_SCENARIO_TIMEOUT_MS;
    await Promise.race([
      running,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AssertionError(`the scenario ran past ${limit / 1000}s`)), limit);
      }),
    ]);
  } catch (e) {
    if (!(e instanceof SkipError)) {
      // An overrun scenario is still running. Abort it and let it unwind before
      // the next one starts, so a late step can't act on the next scenario.
      t.abort();
      await Promise.race([running.catch(() => {}), Bun.sleep(ABORT_GRACE_MS)]);
    }
    if (e instanceof SkipError) {
      status = "skip";
      error = e.message;
    } else {
      status = "fail";
      error = e instanceof AssertionError ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e);
    }
  } finally {
    clearTimeout(timer);
  }
  let costUsd = 0;
  try {
    costUsd = db.costUsd(t.sessionIds());
  } catch {}
  const threads: string[] = [];
  for (const th of t.threads) threads.push(await th.permalink().catch(() => `${th.conversationId}`));
  const seconds = Math.round((Date.now() - started) / 1000);
  results.push({ name: s.name, status, seconds, costUsd, threads, ...(error ? { error } : {}) });

  const mark = status === "pass" ? "✔ PASS" : status === "skip" ? "○ SKIP" : "✘ FAIL";
  console.log(`${mark} ${s.name} · ${seconds}s · $${costUsd.toFixed(2)}`);
  if (error) console.log(`    ${error.split("\n").join("\n    ")}`);
  for (const link of threads) console.log(`    ${link}`);
  console.log("");
}

const failed = results.filter((r) => r.status === "fail");
const total = results.reduce((sum, r) => sum + r.costUsd, 0);
await Bun.write(join(runDir, "report.json"), JSON.stringify({ runId, settings: { model: settings.model, effort: settings.effort }, results }, null, 2));
console.log(
  `${results.filter((r) => r.status === "pass").length} passed, ${failed.length} failed, ` +
    `${results.filter((r) => r.status === "skip").length} skipped · $${total.toFixed(2)} · ${runDir}`,
);

if (keep && !stopping) {
  console.log(`\nThe daemon is still up (pid ${daemon.pid}). Ctrl-C stops it.`);
  await daemon.exited();
}
await shutdown(failed.length ? 1 : 0);

// The world an end-to-end run happens in: its settings, its scratch home, and the
// config and environment the daemon under test is started with.
//
// Everything the daemon writes lives under one home (~/.cache/condotto-e2e, or
// CONDOTTO_E2E_HOME), and every run starts from an empty one except for the
// reports of earlier runs. The repo is the smoke fixture, provisioned fresh here,
// so the agent never gets near a repo anyone cares about.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type AuthConfig, loadAuthConfig, loadSlackConfig } from "../../../src/core/config";
import { ensureFixtureRepo, FIXTURE_REPO_NAME } from "../../smoke-fixture";

export const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

/** What `condotto.e2e.toml` holds. */
export interface E2eSettings {
  channel: string;
  testerBotToken: string;
  /** Posts as the human who installed the tester app: the outsider identity. */
  testerUserToken?: string;
  model: string;
  effort: string;
  /** The Condotto app's own tokens, when condotto.toml and the environment lack them. */
  condottoBotToken?: string;
  condottoAppToken?: string;
}

export interface E2eEnv {
  home: string;
  repoName: string;
  repoPath: string;
  dbPath: string;
  configPath: string;
  /** The Condotto bot token, for the one call the runner makes as Condotto (`auth.test`). */
  condottoBotToken: string;
  /** Environment for the daemon child: tokens ride here, never in the generated file. */
  childEnv: Record<string, string>;
}

export function e2eHome(): string {
  return process.env.CONDOTTO_E2E_HOME?.trim() || join(homedir(), ".cache", "condotto-e2e");
}

export function settingsPath(): string {
  return resolve(process.env.CONDOTTO_E2E_CONFIG?.trim() || join(REPO_ROOT, "condotto.e2e.toml"));
}

const tomlParse = (input: string): unknown =>
  (Bun as unknown as { TOML: { parse(s: string): unknown } }).TOML.parse(input);

export function loadSettings(): E2eSettings {
  const path = settingsPath();
  if (!existsSync(path)) {
    throw new Error(`No ${path}. The setup steps are in the header of scripts/e2e/run.ts.`);
  }
  const raw = tomlParse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const str = (key: string): string | undefined => {
    const v = raw[key];
    if (v === undefined) return undefined;
    if (typeof v !== "string") throw new Error(`${path}: ${key} must be a string`);
    const t = v.trim();
    return t && !t.includes("REPLACE-ME") ? t : undefined;
  };
  const channel = str("channel");
  const testerBotToken = str("tester_bot_token");
  if (!channel || channel === "C0000000000") throw new Error(`${path}: set channel to the test channel's id`);
  if (!testerBotToken?.startsWith("xoxb-")) throw new Error(`${path}: set tester_bot_token to the tester's xoxb- token`);
  const condottoBotToken = str("condotto_bot_token");
  const condottoAppToken = str("condotto_app_token");
  if (!condottoBotToken !== !condottoAppToken) {
    throw new Error(`${path}: set both condotto_bot_token and condotto_app_token, or neither`);
  }
  if (condottoBotToken && !condottoBotToken.startsWith("xoxb-")) throw new Error(`${path}: condotto_bot_token must be an xoxb- token`);
  if (condottoAppToken && !condottoAppToken.startsWith("xapp-")) throw new Error(`${path}: condotto_app_token must be an xapp- token`);
  const testerUserToken = str("tester_user_token");
  if (testerUserToken && !testerUserToken.startsWith("xoxp-")) {
    throw new Error(`${path}: tester_user_token must be an xoxp- token`);
  }
  return {
    channel,
    testerBotToken,
    ...(testerUserToken ? { testerUserToken } : {}),
    model: str("model") ?? "sonnet",
    effort: str("effort") ?? "low",
    ...(condottoBotToken && condottoAppToken ? { condottoBotToken, condottoAppToken } : {}),
  };
}

/**
 * Refuse to run beside another Condotto daemon on this machine. The e2e daemon
 * connects with the operator's own Slack app, and Socket Mode hands each event to
 * just one of an app's open connections, so a second daemon would swallow some of
 * the test's events and see the rest of its traffic. Daemons on other machines
 * can't be seen from here; the runner says so when it starts.
 */
export function assertNoOtherDaemon(): void {
  // From source, the command line names daemon.ts; compiled, the process is `condotto`.
  const found = (args: string[]): string[] =>
    new TextDecoder()
      .decode(Bun.spawnSync(["pgrep", "-l", ...args]).stdout)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  const lines = [...found(["-f", "src/daemon\\.ts"]), ...found(["-x", "condotto"])];
  if (lines.length) {
    throw new Error(
      `Another Condotto daemon is running on this machine, and it would share the Slack app's events:\n  ${lines.join("\n  ")}\nStop it first.`,
    );
  }
}

/** Written into the home on first use; its absence means the home is not ours to wipe. */
const HOME_MARKER = ".condotto-e2e-home";

/**
 * The home is wiped on every run, so refuse one that holds anything this suite
 * did not put there: CONDOTTO_E2E_HOME=~/code must not mean `rm -rf ~/code/*`.
 */
function claimHome(home: string): void {
  mkdirSync(home, { recursive: true });
  const entries = readdirSync(home);
  if (entries.length && !entries.includes(HOME_MARKER)) {
    throw new Error(`${home} is not empty and was not made by the e2e suite, so it won't be wiped. Point CONDOTTO_E2E_HOME at an empty or new directory.`);
  }
  writeFileSync(join(home, HOME_MARKER), "The e2e suite wipes everything here but runs/ on every run.\n");
}

/**
 * The Claude credential, as the operator's daemon would resolve it. Without a
 * condotto.toml (an install configured by environment alone) the same rules
 * apply to the environment: a key means api_key, no key means subscription.
 */
function resolveAuth(): AuthConfig {
  try {
    return loadAuthConfig(process.env);
  } catch (e) {
    if (!(e instanceof Error) || !/No Condotto config found/i.test(e.message)) throw e;
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    return apiKey ? { mode: "api_key", apiKey } : { mode: "subscription" };
  }
}

/** TOML basic strings take JSON's escapes for everything a path or id holds. */
const q = (s: string): string => JSON.stringify(s);

/**
 * Wipe the home (keeping earlier runs' reports), provision the fixture repo, and
 * write the daemon's config. The only architect is the tester bot, and only in
 * the test channel: in this config the operator is an ordinary outsider, which is
 * what lets the user token stand in for one.
 */
export async function prepareEnv(settings: E2eSettings, testerBotUserId: string): Promise<E2eEnv> {
  // Credentials first: a run that can't start should leave the last run's world
  // in place to look at.
  // The operator's own config supplies the Claude credential and, unless
  // condotto.e2e.toml names them, the Condotto app's tokens. Read with the
  // operator's environment, as their daemon would be.
  const slack =
    settings.condottoBotToken && settings.condottoAppToken
      ? { botToken: settings.condottoBotToken, appToken: settings.condottoAppToken }
      : loadSlackConfig(process.env);
  const auth = resolveAuth();

  const home = e2eHome();
  claimHome(home);
  for (const name of readdirSync(home)) {
    if (name !== "runs" && name !== HOME_MARKER) rmSync(join(home, name), { recursive: true, force: true });
  }
  const repoPath = join(home, "repo");
  await ensureFixtureRepo(repoPath);

  const dbPath = join(home, "condotto.sqlite");
  const configPath = join(home, "condotto.toml");
  const toml = [
    "runtime_grants = true",
    "",
    "[[roles]]",
    `principal = ${q(`slack:${testerBotUserId}`)}`,
    `role = "architect"`,
    `scope = ${q(settings.channel)}`,
    "",
    "[[repos]]",
    `name = ${q(FIXTURE_REPO_NAME)}`,
    `path = ${q(repoPath)}`,
    `default_branch = "main"`,
    "",
    "[paths]",
    `db = ${q(dbPath)}`,
    `worktrees_root = ${q(join(home, "worktrees"))}`,
    `memory_root = ${q(join(home, "memory"))}`,
    "",
    "[defaults]",
    `model = ${q(settings.model)}`,
    `effort = ${q(settings.effort)}`,
    "",
  ];

  toml.push("[auth]", `mode = ${q(auth.mode)}`, "");
  writeFileSync(configPath, toml.join("\n"));

  // Every CONDOTTO_* and SLACK_* variable outranks the config file, so none of the
  // operator's may leak into the child; neither may a key the chosen auth mode
  // does not use.
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith("CONDOTTO_") || k.startsWith("SLACK_") || k === "ANTHROPIC_API_KEY") continue;
    if (auth.mode === "api_key" && k === "CLAUDE_CODE_OAUTH_TOKEN") continue;
    childEnv[k] = v;
  }
  childEnv.SLACK_BOT_TOKEN = slack.botToken;
  childEnv.SLACK_APP_TOKEN = slack.appToken;
  if (auth.apiKey) childEnv.ANTHROPIC_API_KEY = auth.apiKey;

  return {
    home,
    repoName: FIXTURE_REPO_NAME,
    repoPath,
    dbPath,
    configPath,
    condottoBotToken: slack.botToken,
    childEnv,
  };
}

/** Where one run's report and daemon log go. */
export function newRunDir(runId: string): string {
  const dir = join(e2eHome(), "runs", runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

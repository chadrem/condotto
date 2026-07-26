import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { loadConfig, loadSlackConfig, loadAuthConfig, subscriptionScaleWarning } from "./core/config";
import { Store } from "./core/store";
import { WorktreeManager } from "./core/worktrees";
import { MemoryManager } from "./core/memory";
import { SessionManager } from "./core/session-manager";
import { principalKey } from "./core/types";
import { VERSION } from "./version";
import { ClaudeCodeAdapter } from "./adapters/claude-code/adapter";
import { SlackAdapter } from "./adapters/slack/adapter";

// Condotto daemon: one long-lived Bun process wiring surfaces -> core -> harness.

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

/** How often the daemon sweeps for collectible worktrees. A boot sweep
 *  plus this tick reclaim clean-stopped (past-retention) and orphaned trees; the
 *  sweep never touches a live/parked worktree. */
const WORKTREE_GC_INTERVAL_MS = 60 * 60 * 1000; // hourly

/** The program name to show in `--help`: the compiled binary's own filename
 *  (from `process.execPath` — argv[1] is a `$bunfs` path when compiled), else
 *  the canonical `condotto` under `bun run`. */
function invokedAs(): string {
  const compiled = import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN");
  return compiled ? basename(process.execPath) : "condotto";
}

function helpText(prog: string): string {
  return [
    `condotto ${VERSION} — turn Slack threads into tickets that work themselves`,
    "",
    "Usage:",
    `  ${prog} [options]`,
    "",
    "Options:",
    "  --config <path>   Path to condotto.toml (default: ./condotto.toml; env CONDOTTO_CONFIG)",
    "  --version, -v     Print the version and exit",
    "  --help, -h        Print this help and exit",
    "",
    "Condotto reads one config file, condotto.toml. Copy condotto.example.toml to",
    "condotto.toml, fill in your Slack tokens, architects, and repos, then run it.",
    "See the README for the full setup, including creating the Slack app.",
  ].join("\n");
}

/** Minimal `--config <path>` / `--config=<path>` argv scan (the rest of
 *  the CLI — --version/--help — is handled separately). Env `CONDOTTO_CONFIG` also works. A
 *  `--config` with no path (or a flag-shaped/empty value) is an error, not a
 *  silent fall-through to default discovery. */
function parseConfigArg(argv: string[]): string | undefined {
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    let value: string | undefined;
    if (a === "--config") value = argv[i + 1];
    else if (a.startsWith("--config=")) value = a.slice("--config=".length);
    else continue;
    if (value === undefined || value.trim() === "" || value.startsWith("-")) {
      throw new Error("--config requires a path (e.g. --config /etc/condotto/condotto.toml)");
    }
    return value;
  }
  return undefined;
}

async function main(): Promise<void> {
  // Informational CLI short-circuits before any config work, so
  // `--help`/`--version` always succeed — even without a valid condotto.toml, and
  // regardless of a malformed `--config` elsewhere on the line.
  const argv = process.argv;
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(helpText(invokedAs()));
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(`condotto ${VERSION}`);
    return;
  }

  // Single source of truth is condotto.toml. A bad --config flag, a
  // missing file, malformed TOML, or a bad required field throws here with an
  // actionable message — never a half-started daemon.
  let config: ReturnType<typeof loadConfig>;
  let slackCreds: ReturnType<typeof loadSlackConfig>;
  let auth: ReturnType<typeof loadAuthConfig>;
  try {
    const configPath = parseConfigArg(process.argv);
    config = loadConfig(process.env, configPath);
    slackCreds = loadSlackConfig(process.env, configPath);
    auth = loadAuthConfig(process.env, configPath);
  } catch (err) {
    console.error(`Configuration error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  for (const repo of config.repos) {
    if (!existsSync(join(repo.path, ".git"))) {
      console.error(
        `Repo "${repo.name}" missing at ${repo.path} — point [[repos]].path in condotto.toml at a ` +
          `git repository, or remove the entry.`,
      );
      process.exit(1);
    }
  }

  const store = new Store(config.dbPath);
  for (const repo of config.repos) store.upsertRepo(repo);
  // Config is the source of truth for which repos exist (as it is for roles
  // below): drop rows for repos no longer declared, so a removed repo actually
  // stops being assignable. Rows a session still references are kept and named.
  const pruned = store.pruneReposNotIn(config.repos.map((r) => r.name));
  if (pruned.deleted.length > 0) {
    log(`[daemon] dropped ${pruned.deleted.length} repo(s) no longer in condotto.toml: ${pruned.deleted.join(", ")}`);
  }
  if (pruned.keptInUse.length > 0) {
    log(
      `[daemon] WARNING: repo(s) ${pruned.keptInUse.join(", ")} are no longer in condotto.toml but still have ` +
        `sessions, so they were kept and remain assignable. Re-declare them or stop those sessions.`,
    );
  }
  // Config is the source of truth for CONFIG roles: clear and re-seed so removing a
  // principal from config actually revokes their authority. Runtime `@Condotto grant`
  // delegations (source='grant') are preserved across the reseed.
  store.clearConfigRoles();
  for (const r of config.roles) store.setRole(r.principal, r.role, r.scope);
  const architects = config.roles.filter((r) => r.role === "architect").length;
  if (architects === 0) {
    log(
      "[daemon] WARNING: no architects configured — nobody can assign a thread or run the agent. " +
        "Set `architects` in condotto.toml (or CONDOTTO_ARCHITECTS).",
    );
  } else {
    log(`[daemon] seeded ${config.roles.length} role mapping(s), ${architects} architect(s)`);
  }
  const orphans = store.parkOrphanedActiveSessions();
  if (orphans > 0) log(`[daemon] parked ${orphans} session(s) orphaned mid-turn by a previous crash`);

  const worktrees = new WorktreeManager(config.worktreesRoot);
  const memory = new MemoryManager(config.memoryRoot);
  // Which credential the agent authenticates with — the type only, never the
  // value. An API key is rotatable and spend-cappable in Console; a personal
  // subscription credential is neither, which is why team installs want the
  // former (README, "Authenticate Claude").
  log(
    auth.mode === "api_key"
      ? "auth: Anthropic API key (Claude Console)"
      : "auth: Claude subscription login (single-operator path)",
  );
  const scaleWarning = subscriptionScaleWarning(config, auth.mode);
  if (scaleWarning) log(`WARNING ${scaleWarning}`);

  const harness = new ClaudeCodeAdapter(undefined, undefined, auth);
  const manager = new SessionManager(store, harness, worktrees, log, {
    memory,
    defaultCostCapUsd: config.defaultCostCapUsd,
    maxConcurrentTurns: config.maxConcurrentTurns,
    defaultModel: config.defaultModel,
    defaultEffort: config.defaultEffort,
    defaultSubagents: config.defaultSubagents,
    defaultWorkflows: config.defaultWorkflows,
  });
  // Warn loudly if the configured default model/effort isn't one the harness
  // accepts — better a boot-time warning than a silent per-turn fallback.
  if (!harness.capabilities.supportedModels.includes(config.defaultModel)) {
    log(`[daemon] WARNING: default model "${config.defaultModel}" not in harness models [${harness.capabilities.supportedModels.join(", ")}] — turns fall back to the SDK default`);
  }
  if (!harness.capabilities.supportedEfforts.includes(config.defaultEffort)) {
    log(`[daemon] WARNING: default effort "${config.defaultEffort}" not in harness efforts [${harness.capabilities.supportedEfforts.join(", ")}]`);
  }
  log(
    `[daemon] cost cap ${config.defaultCostCapUsd === null ? "none (default)" : `$${config.defaultCostCapUsd}/thread (default)`}, ` +
      `max ${config.maxConcurrentTurns} concurrent turns, ` +
      `default model ${config.defaultModel} @ ${config.defaultEffort} effort, ` +
      `subagents ${config.defaultSubagents ? "ON" : "off"} / workflows ${config.defaultWorkflows ? "ON" : "off"} / ` +
      `memory ${config.defaultMemory ? "ON" : "off"}`,
  );

  // Worktree GC: sweep once at boot — before any surface is live, so a
  // reactivation can't race the initial teardown — then hand off to a timer below.
  // Never touches a live/parked worktree; best-effort, never fatal.
  {
    const { cleaned, orphans } = await manager
      // orphanMinAgeMs: 0 — no surface is live yet, so no assign can be mid-flight;
      // a crash-orphan of any age is safe to reclaim immediately at boot.
      .collectWorktrees(Date.now(), { orphanMinAgeMs: 0 })
      .catch((e) => {
        log(`[daemon] initial worktree GC failed: ${e}`);
        return { cleaned: 0, orphans: 0 };
      });
    if (cleaned || orphans) log(`[daemon] boot worktree GC: ${cleaned} clean-stopped, ${orphans} orphan(s) reclaimed`);
  }

  // Surface credentials belong to the adapter, not the core domain config — the
  // composition root gets them from condotto.toml (via loadSlackConfig, validated
  // above) and hands them straight over.
  const slack = new SlackAdapter(
    slackCreds,
    { isArchitect: (p, channelId) => store.isArchitect(principalKey(p), channelId) },
    // Operator console: the core renders the daemon-wide `/condotto status`
    // dashboard and the `/condotto stop` session list; the adapter delivers them
    // ephemerally. Least-privilege object literal (not the whole manager).
    {
      operatorStatus: (p, channelId) => manager.operatorStatus(p, channelId),
      channelStopGuidance: (channelId) => manager.channelStopGuidance(channelId),
    },
    log,
  );
  manager.registerSurface(slack);
  await slack.start((event) => {
    void manager.handleEvent(event);
  });

  const parked = store.listSessions({ surfaceId: slack.id }).length;
  log(`[daemon] ready — db=${config.dbPath}, sessions on record: ${parked}`);

  // Periodic worktree GC. unref() so it never keeps the process alive; a
  // re-entrancy guard skips a tick if the prior sweep is still running (git spawns).
  let gcRunning = false;
  const gcTimer = setInterval(() => {
    if (gcRunning) return;
    gcRunning = true;
    void manager
      .collectWorktrees()
      .catch((e) => log(`[daemon] worktree GC failed: ${e}`))
      .finally(() => {
        gcRunning = false;
      });
  }, WORKTREE_GC_INTERVAL_MS);
  gcTimer.unref?.();

  const shutdown = async (signal: string) => {
    log(`[daemon] ${signal} — shutting down`);
    clearInterval(gcTimer);
    await slack.stop().catch(() => {});
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("daemon failed to start:", err);
  process.exit(1);
});

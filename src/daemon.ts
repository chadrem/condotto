import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, loadSlackConfig } from "./core/config";
import { Store } from "./core/store";
import { WorktreeManager } from "./core/worktrees";
import { SessionManager } from "./core/session-manager";
import { principalKey } from "./core/types";
import { ClaudeCodeAdapter } from "./adapters/claude-code/adapter";
import { SlackAdapter } from "./adapters/slack/adapter";

// Conduit daemon: one long-lived Bun process wiring surfaces -> core -> harness.

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

/** Minimal `--config <path>` / `--config=<path>` argv scan (M4 §1; the rest of
 *  the CLI — --version/--help — is M4 §2). Env `CONDUIT_CONFIG` also works. A
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
      throw new Error("--config requires a path (e.g. --config /etc/conduit/conduit.toml)");
    }
    return value;
  }
  return undefined;
}

async function main(): Promise<void> {
  // Single source of truth is conduit.toml (M4 §1). A bad --config flag, a
  // missing file, malformed TOML, or a bad required field throws here with an
  // actionable message — never a half-started daemon.
  let config: ReturnType<typeof loadConfig>;
  let slackCreds: ReturnType<typeof loadSlackConfig>;
  try {
    const configPath = parseConfigArg(process.argv);
    config = loadConfig(process.env, configPath);
    slackCreds = loadSlackConfig(process.env, configPath);
  } catch (err) {
    console.error(`Configuration error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  for (const repo of config.repos) {
    if (!existsSync(join(repo.path, ".git"))) {
      console.error(
        `Repo "${repo.name}" missing at ${repo.path} — point [[repos]].path in conduit.toml at a ` +
          `git repository (or remove the entry). The default throwaway testrepo lives at ` +
          `~/tmp/conduit-testrepo; create it or override CONDUIT_TEST_REPO.`,
      );
      process.exit(1);
    }
  }

  const store = new Store(config.dbPath);
  for (const repo of config.repos) store.upsertRepo(repo);
  // Config is the source of truth for CONFIG roles: clear and re-seed so removing a
  // principal from config actually revokes their authority. Runtime `@Conduit grant`
  // delegations (source='grant') are preserved across the reseed (M3.8).
  store.clearConfigRoles();
  for (const r of config.roles) store.setRole(r.principal, r.role, r.scope);
  const architects = config.roles.filter((r) => r.role === "architect").length;
  if (architects === 0) {
    log(
      "[daemon] WARNING: no architects configured — gated actions (writes, bash, deploys) " +
        "will have no one who can approve them. Set `architects` in conduit.toml (or CONDUIT_ARCHITECTS).",
    );
  } else {
    log(`[daemon] seeded ${config.roles.length} role mapping(s), ${architects} architect(s)`);
  }
  const orphans = store.parkOrphanedActiveSessions();
  if (orphans > 0) log(`[daemon] parked ${orphans} session(s) orphaned mid-turn by a previous crash`);

  const worktrees = new WorktreeManager(config.worktreesRoot);
  const harness = new ClaudeCodeAdapter();
  const manager = new SessionManager(store, harness, worktrees, log, {
    defaultCostCapUsd: config.defaultCostCapUsd,
    maxConcurrentTurns: config.maxConcurrentTurns,
    defaultModel: config.defaultModel,
    defaultEffort: config.defaultEffort,
    defaultAutoApprove: config.defaultAutoApprove,
  });
  // Warn loudly if the configured default model/effort isn't one the harness
  // accepts — better a boot-time warning than a silent per-turn fallback (M3.5).
  if (!harness.capabilities.supportedModels.includes(config.defaultModel)) {
    log(`[daemon] WARNING: default model "${config.defaultModel}" not in harness models [${harness.capabilities.supportedModels.join(", ")}] — turns fall back to the SDK default`);
  }
  if (!harness.capabilities.supportedEfforts.includes(config.defaultEffort)) {
    log(`[daemon] WARNING: default effort "${config.defaultEffort}" not in harness efforts [${harness.capabilities.supportedEfforts.join(", ")}]`);
  }
  log(
    `[daemon] cost cap $${config.defaultCostCapUsd}/thread (default), ` +
      `max ${config.maxConcurrentTurns} concurrent turns, ` +
      `default model ${config.defaultModel} @ ${config.defaultEffort} effort, ` +
      `architect auto-approve ${config.defaultAutoApprove ? "ON" : "off"} by default`,
  );

  // Surface credentials belong to the adapter, not the core domain config — the
  // composition root gets them from conduit.toml (via loadSlackConfig, validated
  // above) and hands them straight over.
  const slack = new SlackAdapter(
    slackCreds,
    { isArchitect: (p, channelId) => store.isArchitect(principalKey(p), channelId) },
    log,
  );
  manager.registerSurface(slack);
  await slack.start((event) => {
    void manager.handleEvent(event);
  });

  const parked = store.listSessions({ surfaceId: slack.id }).length;
  log(`[daemon] ready — db=${config.dbPath}, sessions on record: ${parked}`);

  const shutdown = async (signal: string) => {
    log(`[daemon] ${signal} — shutting down`);
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

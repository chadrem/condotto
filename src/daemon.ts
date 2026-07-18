import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./core/config";
import { Store } from "./core/store";
import { WorktreeManager } from "./core/worktrees";
import { SessionManager } from "./core/session-manager";
import { principalKey } from "./core/types";
import { ClaudeCodeAdapter } from "./adapters/claude-code/adapter";
import { SlackAdapter } from "./adapters/slack/adapter";

// Conduit daemon: one long-lived Bun process wiring surfaces -> core -> harness.

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

async function main(): Promise<void> {
  const config = loadConfig();

  for (const repo of config.repos) {
    if (!existsSync(join(repo.path, ".git"))) {
      console.error(
        `Test repo missing at ${repo.path} — create a throwaway git repo there ` +
          `(build-time safety: Conduit only ever points at throwaway repos until M4).`,
      );
      process.exit(1);
    }
  }

  const store = new Store(config.dbPath);
  for (const repo of config.repos) store.upsertRepo(repo);
  // Config is the source of truth for roles: clear and re-seed so removing a
  // principal from config actually revokes their authority.
  store.clearRoles();
  for (const r of config.roles) store.setRole(r.principal, r.role, r.scope);
  const architects = config.roles.filter((r) => r.role === "architect").length;
  if (architects === 0) {
    log(
      "[daemon] WARNING: no architects configured — gated actions (writes, bash, deploys) " +
        "will have no one who can approve them. Set CONDUIT_ARCHITECTS or conduit.roles.json.",
    );
  } else {
    log(`[daemon] seeded ${config.roles.length} role mapping(s), ${architects} architect(s)`);
  }
  const orphans = store.parkOrphanedActiveSessions();
  if (orphans > 0) log(`[daemon] parked ${orphans} session(s) orphaned mid-turn by a previous crash`);

  const worktrees = new WorktreeManager(config.worktreesRoot);
  const harness = new ClaudeCodeAdapter();
  const manager = new SessionManager(store, harness, worktrees, log);

  // Surface credentials belong to the adapter, not core config — the
  // composition root reads them and hands them straight over.
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  if (!botToken || !appToken) {
    console.error(
      "No Slack tokens found. Create .env with SLACK_BOT_TOKEN and SLACK_APP_TOKEN " +
        "(see DESIGN.md Appendix C for the Slack app setup), then rerun.",
    );
    process.exit(1);
  }

  const slack = new SlackAdapter(
    { botToken, appToken },
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

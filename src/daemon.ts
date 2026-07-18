import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./core/config";
import { Store } from "./core/store";
import { WorktreeManager } from "./core/worktrees";
import { SessionManager } from "./core/session-manager";
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

  const worktrees = new WorktreeManager(config.worktreesRoot);
  const harness = new ClaudeCodeAdapter();
  const manager = new SessionManager(store, harness, worktrees, log);

  if (!config.slack) {
    console.error(
      "No Slack tokens found. Create .env with SLACK_BOT_TOKEN and SLACK_APP_TOKEN " +
        "(see DESIGN.md Appendix C for the Slack app setup), then rerun.",
    );
    process.exit(1);
  }

  const slack = new SlackAdapter(config.slack, log);
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

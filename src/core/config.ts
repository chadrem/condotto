import { homedir } from "node:os";
import { resolve } from "node:path";
import type { RepoConfig } from "./types";

export interface ConduitConfig {
  dbPath: string;
  worktreesRoot: string; // absolute; worktree paths must be stable forever
  repos: RepoConfig[];
  slack?: { botToken: string; appToken: string };
}

function expandHome(p: string): string {
  return p.startsWith("~") ? resolve(homedir(), p.slice(2)) : resolve(p);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ConduitConfig {
  // Build-time safety (DESIGN.md §8): the only repo the daemon knows about is
  // a throwaway test repo. Real repo registration is a post-M4 concern.
  const testRepoPath = expandHome(env.CONDUIT_TEST_REPO ?? "~/tmp/conduit-testrepo");

  const botToken = env.SLACK_BOT_TOKEN;
  const appToken = env.SLACK_APP_TOKEN;

  return {
    dbPath: env.CONDUIT_DB_PATH ?? resolve("conduit.sqlite"),
    worktreesRoot: expandHome(env.CONDUIT_WORKTREES_ROOT ?? "~/tmp/conduit-worktrees"),
    repos: [{ name: "testrepo", path: testRepoPath, defaultBranch: "main" }],
    slack: botToken && appToken ? { botToken, appToken } : undefined,
  };
}

import { homedir } from "node:os";
import { resolve } from "node:path";
import type { RepoConfig } from "./types";

// Core configuration only — surface adapter credentials (Slack tokens etc.)
// are read by the composition root (daemon.ts) and handed straight to their
// adapter; the core never sees them.

export interface ConduitConfig {
  dbPath: string;
  worktreesRoot: string; // absolute; worktree paths must be stable forever
  repos: RepoConfig[];
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return resolve(p); // "~user" and everything else resolve as-is
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ConduitConfig {
  // Build-time safety (DESIGN.md §8): the only repo the daemon knows about is
  // a throwaway test repo. Real repo registration is a post-M4 concern.
  const testRepoPath = expandHome(env.CONDUIT_TEST_REPO ?? "~/tmp/conduit-testrepo");

  return {
    dbPath: env.CONDUIT_DB_PATH ?? resolve("conduit.sqlite"),
    worktreesRoot: expandHome(env.CONDUIT_WORKTREES_ROOT ?? "~/tmp/conduit-worktrees"),
    repos: [{ name: "testrepo", path: testRepoPath, defaultBranch: "main" }],
  };
}

import { homedir } from "node:os";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
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

/**
 * Optional repo registry: a JSON array of { name, path, defaultBranch? }.
 * Machine-specific (absolute paths), so the file is gitignored. Sessions only
 * ever see committed content via worktrees — a registered repo's working
 * tree, untracked files, and ignored files are never visible to the agent.
 */
function loadReposFile(path: string): RepoConfig[] {
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`could not parse ${path}: ${err}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${path} must be a JSON array of repos`);
  return parsed.map((entry, i) => {
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== "string" || !/^[a-z0-9][a-z0-9_-]*$/i.test(e.name)) {
      throw new Error(`${path}[${i}]: "name" must be a simple identifier`);
    }
    if (typeof e.path !== "string" || e.path.length === 0) {
      throw new Error(`${path}[${i}]: "path" is required`);
    }
    return {
      name: e.name,
      path: expandHome(e.path),
      defaultBranch: typeof e.defaultBranch === "string" ? e.defaultBranch : "main",
    };
  });
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ConduitConfig {
  // The throwaway test repo is always registered (build-time safety default,
  // DESIGN.md §8). Additional repos come from the registry file; an entry
  // named "testrepo" overrides the default.
  const testRepoPath = expandHome(env.CONDUIT_TEST_REPO ?? "~/tmp/conduit-testrepo");
  const extras = loadReposFile(resolve(env.CONDUIT_REPOS_FILE ?? "conduit.repos.json"));

  // Last entry wins on duplicate names (so the file can override testrepo).
  const byName = new Map<string, RepoConfig>();
  for (const repo of [{ name: "testrepo", path: testRepoPath, defaultBranch: "main" }, ...extras]) {
    byName.set(repo.name, repo);
  }

  return {
    dbPath: env.CONDUIT_DB_PATH ?? resolve("conduit.sqlite"),
    worktreesRoot: expandHome(env.CONDUIT_WORKTREES_ROOT ?? "~/tmp/conduit-worktrees"),
    repos: [...byName.values()],
  };
}

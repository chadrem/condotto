import { homedir } from "node:os";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { RepoConfig, Role } from "./types";

// Condotto's single source of truth is one TOML file, `condotto.toml`,
// consolidating what used to be scattered across `.env`, `condotto.repos.json`,
// `condotto.roles.json`, and `CONDOTTO_*` env vars. This module is the ONLY config
// parser: it discovers, reads, validates, and shapes that file into the core
// `CondottoConfig` the daemon consumes. It also exposes the surface adapter's
// credentials (`loadSlackConfig`) as bare strings for the composition root
// (`daemon.ts`) to hand straight to its adapter — the core domain `CondottoConfig`
// still never carries transport credentials, and nothing here constructs a Slack
// type (check-ports stays clean).
//
// Discovery: `--config <path>` (daemon argv) > `CONDOTTO_CONFIG` > `./condotto.toml`.
// Env-var overrides (`CONDOTTO_*`, `SLACK_*`) win over any value in the file, so an
// operator can keep secrets out of the file if they prefer. Boot validation fails
// fast with an actionable message rather than half-starting the daemon.

export interface RoleMapping {
  principal: string; // surface-qualified, e.g. "slack:U0123ABC"
  role: Role;
  scope: string; // channel_id or "*"
}

export interface CondottoConfig {
  dbPath: string;
  worktreesRoot: string; // absolute; worktree paths must be stable forever
  repos: RepoConfig[];
  roles: RoleMapping[]; // seeded into the store at boot
  /** Daemon-wide per-thread cost ceiling, used when a repo sets none. */
  defaultCostCapUsd: number;
  /** Max harness turns running at once across all sessions (concurrency). */
  maxConcurrentTurns: number;
  /**
   * Daemon-wide default model/effort tokens, used when a repo sets
   * none. Opaque tokens the harness adapter validates; the north-star wants the
   * implementer to be first-class, so the default is Opus + high (DESIGN §1, §8).
   */
  defaultModel: string;
  defaultEffort: string;
  /**
   * Daemon-wide default for the architect self-approve setting, used when a
   * repo sets no `auto_approve`. On by default (DESIGN §4 sanctions
   * per-thread widening; the architect dials it off per thread/repo). Override
   * with `[defaults].auto_approve = false` or `CONDOTTO_AUTO_APPROVE=off`.
   */
  defaultAutoApprove: boolean;
}

/** Surface (Slack) credentials — owned by the composition root, never the core. */
export interface SlackCredentials {
  botToken: string;
  appToken: string;
}

/** Fallback per-thread cost ceiling in USD when neither repo nor config sets one. */
export const DEFAULT_COST_CAP_USD = 10;
/** Default cap on concurrently-executing harness turns (protects the box). */
export const DEFAULT_MAX_CONCURRENT_TURNS = 6;
/**
 * Default implementer model/effort. Opus + high: the implementer
 * must be first-class for a PM to build a real feature (DESIGN §1 north-star).
 * Opaque tokens — the harness adapter maps/validates them.
 */
export const DEFAULT_MODEL = "opus";
export const DEFAULT_EFFORT = "high";

/** Default location and env override for the single config file. */
export const DEFAULT_CONFIG_PATH = "condotto.toml";

/**
 * Commands auto-allowed without approval on any repo. Deliberately conservative:
 * only read-only git subcommands and version/identity checks — commands whose
 * behavior can't grant file access outside the worktree.
 *
 * NOTE (deviation from DESIGN.md §4's examples, logged in DECISIONS.md): `cat`
 * and `ls` are intentionally NOT here. Auto-allowing them via Bash would bypass
 * worktree read-confinement (Bash arg confinement is only heuristic), so
 * file reads go through the confined Read/Grep tools instead. A repo may add its
 * own commands (incl. its test command) via `safe_bash_allowlist` if it accepts
 * the risk. Positive Bash-arg confinement is future hardening.
 */
export const DEFAULT_SAFE_BASH_ALLOWLIST = [
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "git stash list",
  "pwd",
  "which",
  "node --version",
  "bun --version",
];

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return resolve(p); // "~user" and everything else resolve as-is
}

// ---------------------------------------------------------------------------
// TOML discovery + parse

// @types/bun 1.3.14 ships the runtime `Bun.TOML.parse` (a zero-dep string parser)
// but does not yet type it, so reach it through a localized cast. Simplify this
// once the types catch up.
const tomlParse = (input: string): unknown =>
  (Bun as unknown as { TOML: { parse(s: string): unknown } }).TOML.parse(input);

function discoverConfigPath(env: Record<string, string | undefined>, override?: string): string {
  const raw = override ?? env.CONDOTTO_CONFIG ?? DEFAULT_CONFIG_PATH;
  return resolve(raw);
}

/** Discover, read, and TOML-parse the config file. Throws fast + actionable. */
function readParsedConfig(
  env: Record<string, string | undefined>,
  override?: string,
): { toml: Record<string, unknown>; path: string } {
  const path = discoverConfigPath(env, override);
  if (!existsSync(path)) {
    throw new Error(
      `No Condotto config found at ${path}. Copy condotto.example.toml to condotto.toml and fill ` +
        `it in, or point at one with --config <path> or CONDOTTO_CONFIG.`,
    );
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`could not read config ${path}: ${err}`);
  }
  let parsed: unknown;
  try {
    parsed = tomlParse(text);
  } catch (err) {
    throw new Error(`could not parse ${path} as TOML: ${err instanceof Error ? err.message : err}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must be a TOML table at the top level`);
  }
  return { toml: parsed as Record<string, unknown>, path };
}

// ---------------------------------------------------------------------------
// Typed value helpers (all take a `where` string used verbatim in error messages)

function asTable(v: unknown, where: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`${where} must be a table`);
  }
  return v as Record<string, unknown>;
}

/** A non-empty trimmed string, or undefined when absent/blank (mirrors optStr). */
function optString(v: unknown, where: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new Error(`${where} must be a string`);
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function optBool(v: unknown, where: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new Error(`${where} must be a boolean (true/false)`);
  return v;
}

function optPosNumber(v: unknown, where: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new Error(`${where} must be a positive number`);
  }
  return v;
}

function optPosInt(v: unknown, where: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new Error(`${where} must be a positive integer`);
  }
  return v;
}

function optStringArray(v: unknown, where: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new Error(`${where} must be an array of strings`);
  }
  return v as string[];
}

/** Warn (never throw) on keys we don't recognize — catches operator typos. */
function warnUnknownKeys(obj: Record<string, unknown>, known: readonly string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) {
      console.warn(`[config] ${where}: unrecognized key "${key}" ignored — check for a typo`);
    }
  }
}

// ---------------------------------------------------------------------------
// Env-override helpers (env strings win over file values)

const envStr = (raw: string | undefined): string | undefined =>
  raw !== undefined && raw.trim() !== "" ? raw.trim() : undefined;

function envPosNumber(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
  return n;
}

function envPosInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return n;
}

// ---------------------------------------------------------------------------
// Section parsers

const REPO_KEYS = [
  "name",
  "path",
  "default_branch",
  "safe_bash_allowlist",
  "test_cmd",
  "land_cmd",
  "deploy_cmd",
  "cost_cap_usd",
  "default_model",
  "default_effort",
  "trusted",
  "auto_approve",
] as const;

function parseRepoEntry(entry: unknown, where: string): RepoConfig {
  const e = asTable(entry, where);
  warnUnknownKeys(e, REPO_KEYS, where);
  if (typeof e.name !== "string" || !/^[a-z0-9][a-z0-9_-]*$/i.test(e.name)) {
    throw new Error(`${where}: "name" must be a simple identifier`);
  }
  if (typeof e.path !== "string" || e.path.length === 0) {
    throw new Error(`${where}: "path" is required`);
  }
  const allow = optStringArray(e.safe_bash_allowlist, `${where}.safe_bash_allowlist`);
  return {
    name: e.name,
    path: expandHome(e.path),
    defaultBranch: optString(e.default_branch, `${where}.default_branch`) ?? "main",
    safeBashAllowlist: allow ?? DEFAULT_SAFE_BASH_ALLOWLIST,
    testCmd: optString(e.test_cmd, `${where}.test_cmd`),
    landCmd: optString(e.land_cmd, `${where}.land_cmd`),
    deployCmd: optString(e.deploy_cmd, `${where}.deploy_cmd`),
    costCapUsd: optPosNumber(e.cost_cap_usd, `${where}.cost_cap_usd`),
    // Opaque model/effort tokens (validated by the harness adapter) and the
    // trust flag. `trusted` must be an explicit boolean true — a truthy
    // string won't do, since it opens a repo's config/MCP to the agent. optBool
    // fails fast on a non-boolean (e.g. trusted = "true"), so a typo can't
    // silently disable trust the operator thinks they enabled.
    defaultModel: optString(e.default_model, `${where}.default_model`),
    defaultEffort: optString(e.default_effort, `${where}.default_effort`),
    trusted: optBool(e.trusted, `${where}.trusted`) === true,
    // Per-repo default for architect self-approve. Only an explicit boolean
    // pins it; anything else (absent) = fall back to the daemon-wide default.
    autoApprove: optBool(e.auto_approve, `${where}.auto_approve`),
  };
}

/**
 * Every repo Condotto can work in is declared by the operator as a `[[repos]]`
 * entry. There is no implicit or default repo: at least one entry is required,
 * and a config with none fails fast at boot rather than half-starting a daemon
 * that has nothing to be assigned to.
 *
 * Sessions only ever see committed content via worktrees — a registered repo's
 * working tree, untracked files, and ignored files are never visible to the agent.
 */
function parseRepos(toml: Record<string, unknown>, configPath: string): RepoConfig[] {
  const rawRepos = toml.repos;
  if (rawRepos !== undefined && !Array.isArray(rawRepos)) {
    throw new Error(`"repos" must be an array of tables ([[repos]])`);
  }
  const repos: RepoConfig[] =
    rawRepos === undefined ? [] : rawRepos.map((entry, i) => parseRepoEntry(entry, `[[repos]][${i}]`));

  if (repos.length === 0) {
    throw new Error(
      `No repos configured — add at least one [[repos]] entry to ${configPath}:\n\n` +
        `  [[repos]]\n` +
        `  name = "my-app"\n` +
        `  path = "~/code/my-app"\n\n` +
        `See condotto.example.toml for the full set of per-repo options.`,
    );
  }

  // Names key the repos table and every `assign <repo>`, so a duplicate is an
  // operator typo that would silently discard a repo. Fail instead.
  const seen = new Set<string>();
  for (const [i, repo] of repos.entries()) {
    if (seen.has(repo.name)) {
      throw new Error(`[[repos]][${i}]: duplicate name "${repo.name}" — repo names must be unique.`);
    }
    seen.add(repo.name);
  }
  return repos;
}

/**
 * Admin role mappings (DESIGN.md §2). Three sources, merged and de-duped by
 * (principal, scope): the `architects = [...]` array (surface-qualified principals
 * → architect at scope "*", the quick path), richer `[[roles]]` entries
 * ({principal, role, scope?}), and the `CONDOTTO_ARCHITECTS` env var (a comma/space
 * list, the single-architect convenience). A principal is surface-qualified:
 * "slack:U0123ABC".
 *
 * Precedence (matches the previous reader): on a same-(principal, scope) collision
 * the FILE wins over the env `CONDOTTO_ARCHITECTS` quick-list — so an explicit
 * `[[roles]]` demotion in the authoritative file sticks even if the same
 * principal is still named in the env var. (This is the one place env does NOT
 * override the file: role assignments are authority, and a demote in the owned
 * file must not be silently re-elevated by a leftover env entry. Scalar defaults
 * still take the general env-wins rule.) We seed env FIRST, then the file sources,
 * relying on the Map's last-write-wins to let the file overwrite.
 */
function parseRoles(toml: Record<string, unknown>, env: Record<string, string | undefined>): RoleMapping[] {
  const byKey = new Map<string, RoleMapping>();
  const put = (m: RoleMapping) => byKey.set(`${m.principal} ${m.scope}`, m);
  const validPrincipal = (p: string) => /^[a-z0-9_]+:.+$/i.test(p);

  // Env quick-list first, so any file entry below overrides it on a collision.
  for (const raw of (env.CONDOTTO_ARCHITECTS ?? "").split(/[\s,]+/).filter(Boolean)) {
    if (!validPrincipal(raw)) {
      throw new Error(`CONDOTTO_ARCHITECTS: "${raw}" is not a surface-qualified principal (e.g. slack:U0123ABC)`);
    }
    put({ principal: raw, role: "architect", scope: "*" });
  }

  const architects = toml.architects;
  if (architects !== undefined) {
    if (!Array.isArray(architects) || !architects.every((x) => typeof x === "string")) {
      throw new Error(`"architects" must be an array of surface-qualified principals`);
    }
    architects.forEach((raw, i) => {
      if (!validPrincipal(raw)) {
        throw new Error(`architects[${i}]: "${raw}" is not a surface-qualified principal (e.g. slack:U0123ABC)`);
      }
      put({ principal: raw, role: "architect", scope: "*" });
    });
  }

  const roles = toml.roles;
  if (roles !== undefined) {
    if (!Array.isArray(roles)) throw new Error(`"roles" must be an array of tables ([[roles]])`);
    roles.forEach((entry, i) => {
      const where = `[[roles]][${i}]`;
      const e = asTable(entry, where);
      warnUnknownKeys(e, ["principal", "role", "scope"], where);
      if (typeof e.principal !== "string" || !validPrincipal(e.principal)) {
        throw new Error(`${where}: "principal" must be surface-qualified (e.g. slack:U0123ABC)`);
      }
      if (e.role !== "architect" && e.role !== "member" && e.role !== "observer") {
        throw new Error(`${where}: "role" must be architect|member|observer`);
      }
      put({ principal: e.principal, role: e.role, scope: typeof e.scope === "string" ? e.scope : "*" });
    });
  }

  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Public API

const TOP_LEVEL_KEYS = ["slack", "architects", "roles", "repos", "paths", "defaults"] as const;
const PATHS_KEYS = ["db", "worktrees_root"] as const;
const DEFAULTS_KEYS = ["model", "effort", "auto_approve", "cost_cap_usd", "max_concurrent_turns"] as const;

/**
 * Load and validate the core configuration from `condotto.toml`. `env`
 * supplies overrides (defaults to `process.env`); `configPathOverride` is the
 * daemon's `--config` argument. Throws fast with an actionable message on a
 * missing file, malformed TOML, or an invalid required field.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  configPathOverride?: string,
): CondottoConfig {
  const { toml, path: configPath } = readParsedConfig(env, configPathOverride);
  warnUnknownKeys(toml, TOP_LEVEL_KEYS, "condotto.toml");

  const paths = toml.paths === undefined ? {} : asTable(toml.paths, "[paths]");
  warnUnknownKeys(paths, PATHS_KEYS, "[paths]");
  const defaults = toml.defaults === undefined ? {} : asTable(toml.defaults, "[defaults]");
  warnUnknownKeys(defaults, DEFAULTS_KEYS, "[defaults]");

  // Architect self-approve, on unless explicitly disabled. Accept the usual
  // falsey spellings so `CONDOTTO_AUTO_APPROVE=off|false|0|no` all turn it off.
  const autoApproveEnv = envStr(env.CONDOTTO_AUTO_APPROVE)?.toLowerCase();
  const autoApproveFile = optBool(defaults.auto_approve, "[defaults].auto_approve");
  const defaultAutoApprove =
    autoApproveEnv !== undefined
      ? !/^(off|false|0|no)$/.test(autoApproveEnv)
      : (autoApproveFile ?? true);

  return {
    dbPath: expandHome(envStr(env.CONDOTTO_DB_PATH) ?? optString(paths.db, "[paths].db") ?? "condotto.sqlite"),
    worktreesRoot: expandHome(
      envStr(env.CONDOTTO_WORKTREES_ROOT) ?? optString(paths.worktrees_root, "[paths].worktrees_root") ?? "~/tmp/condotto-worktrees",
    ),
    repos: parseRepos(toml, configPath),
    roles: parseRoles(toml, env),
    defaultCostCapUsd:
      envPosNumber(env.CONDOTTO_COST_CAP_USD, "CONDOTTO_COST_CAP_USD") ??
      optPosNumber(defaults.cost_cap_usd, "[defaults].cost_cap_usd") ??
      DEFAULT_COST_CAP_USD,
    maxConcurrentTurns:
      envPosInt(env.CONDOTTO_MAX_CONCURRENT_TURNS, "CONDOTTO_MAX_CONCURRENT_TURNS") ??
      optPosInt(defaults.max_concurrent_turns, "[defaults].max_concurrent_turns") ??
      DEFAULT_MAX_CONCURRENT_TURNS,
    // Opaque tokens: the harness adapter validates them (never core policy).
    defaultModel: envStr(env.CONDOTTO_DEFAULT_MODEL) ?? optString(defaults.model, "[defaults].model") ?? DEFAULT_MODEL,
    defaultEffort:
      envStr(env.CONDOTTO_DEFAULT_EFFORT) ?? optString(defaults.effort, "[defaults].effort") ?? DEFAULT_EFFORT,
    defaultAutoApprove,
  };
}

/**
 * Load the surface (Slack) credentials the composition root hands to its adapter.
 * From `[slack].bot_token`/`app_token`, with `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN`
 * env overrides. Kept separate from `CondottoConfig` so the core domain never
 * carries transport credentials; returns bare strings (no Slack type). Throws
 * fast with an actionable message if either token is missing.
 */
export function loadSlackConfig(
  env: Record<string, string | undefined> = process.env,
  configPathOverride?: string,
): SlackCredentials {
  const { toml, path } = readParsedConfig(env, configPathOverride);
  const slack = toml.slack === undefined ? {} : asTable(toml.slack, "[slack]");
  warnUnknownKeys(slack, ["bot_token", "app_token"], "[slack]");
  const botToken = envStr(env.SLACK_BOT_TOKEN) ?? optString(slack.bot_token, "[slack].bot_token");
  const appToken = envStr(env.SLACK_APP_TOKEN) ?? optString(slack.app_token, "[slack].app_token");
  if (!botToken || !appToken) {
    throw new Error(
      `Missing Slack tokens. Set [slack].bot_token and [slack].app_token in ${path} ` +
        `(or SLACK_BOT_TOKEN / SLACK_APP_TOKEN) — see the README ("Create the Slack app") for setup.`,
    );
  }
  return { botToken, appToken };
}

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
  /**
   * Absolute root for per-(repo, channel) agent memory. Unlike a worktree this
   * OUTLIVES the session that wrote it — that is the entire point — so it must
   * not default anywhere disposable.
   */
  memoryRoot: string;
  repos: RepoConfig[];
  roles: RoleMapping[]; // seeded into the store at boot
  /** Daemon-wide per-thread cost ceiling, used when a repo sets none. */
  defaultCostCapUsd: number;
  /** Max harness turns running at once across all sessions (concurrency). */
  maxConcurrentTurns: number;
  /**
   * Daemon-wide default model/effort tokens, used when a repo sets
   * none. Opaque tokens the harness adapter validates. The default is Opus 5 +
   * xhigh: the implementer has to be first-class for a PM to build a real feature.
   */
  defaultModel: string;
  defaultEffort: string;
  /**
   * Daemon-wide default harness posture for a new session, used when a repo sets
   * no `subagents`/`workflows`. Both on by default: together with the `xhigh`
   * effort default, a thread arrives at full strength instead of waiting for an
   * architect to remember to raise it.
   * Override with `[defaults].subagents = false` / `CONDOTTO_SUBAGENTS=off`
   * (same for workflows). Confinement is unchanged — see DEFAULT_SUBAGENTS.
   */
  defaultSubagents: boolean;
  defaultWorkflows: boolean;
  /** Daemon-wide default for durable agent memory, used when a repo sets none. */
  defaultMemory: boolean;
}

/** Surface (Slack) credentials — owned by the composition root, never the core. */
export interface SlackCredentials {
  botToken: string;
  appToken: string;
}

/**
 * Which credential the harness authenticates to Anthropic with.
 *
 * `api_key`      — an Anthropic API key from Claude Console. The documented path
 *                  for developers building on the Agent SDK, and the only one
 *                  whose plan limits contemplate more than one person driving
 *                  sessions. Rotatable and spend-cappable in Console.
 * `subscription` — the machine's Claude subscription login (keychain OAuth, or a
 *                  headless `CLAUDE_CODE_OAUTH_TOKEN`). Anthropic scopes OAuth to
 *                  ordinary individual use of Claude Code and the Agent SDK, so
 *                  this is the single-operator path: one architect driving their
 *                  own sessions. Supported, not deprecated — just not for teams.
 */
export type AuthMode = "api_key" | "subscription";

/** Harness credentials — like SlackCredentials, owned by the composition root. */
export interface AuthConfig {
  mode: AuthMode;
  /** Present iff `mode === "api_key"`. Never logged, never persisted. */
  apiKey?: string;
}

/**
 * Fallback per-thread cost ceiling in USD when neither repo nor config sets one.
 * Sized for the shipped posture below: xhigh effort with subagents and workflows
 * on spends real money per thread, and a cap that pauses healthy work is worse
 * than no cap at all — this is a runaway brake, not a budget.
 */
export const DEFAULT_COST_CAP_USD = 50;
/** Default cap on concurrently-executing harness turns (protects the box). */
export const DEFAULT_MAX_CONCURRENT_TURNS = 6;
/**
 * Default implementer model/effort. Opus 5 + xhigh: Anthropic's guidance is to
 * step up to xhigh for demanding coding and agentic work. Opaque tokens — the
 * harness adapter maps/validates them.
 */
export const DEFAULT_MODEL = "opus";
export const DEFAULT_EFFORT = "xhigh";
/**
 * Default harness posture for a NEW session: subagents and workflows both on.
 *
 * These are on-by-default because the product's job is a thread that works
 * itself, not because the confinement around them relaxed — it did not. A
 * subagent or workflow agent is confined to the worktree exactly as the main
 * agent is, and the floor applies to it identically. Fanning out changes how much
 * gets read at once, not what may be reached.
 */
export const DEFAULT_SUBAGENTS = true;
export const DEFAULT_WORKFLOWS = true;
/**
 * Durable agent memory, ON by default.
 *
 * Without it every thread starts from zero and the install never appears to
 * learn anything, which is the single biggest difference between Condotto
 * feeling useful on day 30 and feeling the same as day 1. It is still an
 * operator-level setting rather than a per-thread toggle — what one thread
 * records lands in the SYSTEM PROMPT of every later thread in that channel,
 * above `framing.ts` and so outside the `user=`-header authority rule — so
 * turning it off is `[defaults].memory = false`, or per repo.
 */
export const DEFAULT_MEMORY = true;

/** Default location and env override for the single config file. */
export const DEFAULT_CONFIG_PATH = "condotto.toml";

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
  "cost_cap_usd",
  "default_model",
  "default_effort",
  "subagents",
  "workflows",
  "memory",
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
  return {
    name: e.name,
    path: expandHome(e.path),
    defaultBranch: optString(e.default_branch, `${where}.default_branch`) ?? "main",
    // `test_cmd`, `land_cmd` and `deploy_cmd` are deliberately NOT read
    // (2026-07-26). The daemon-run command path existed because the agent's shell
    // was gated; now the agent runs its own tests. An existing config that still
    // declares them boots fine — the keys are ignored, not rejected.
    costCapUsd: optPosNumber(e.cost_cap_usd, `${where}.cost_cap_usd`),
    // Opaque model/effort tokens, validated by the harness adapter.
    // Per-repo harness posture is tri-state: an explicit boolean pins it, absent
    // falls through to the daemon default.
    subagents: optBool(e.subagents, `${where}.subagents`),
    workflows: optBool(e.workflows, `${where}.workflows`),
    // Durable agent memory. Tri-state like the two above: an explicit boolean
    // pins it, absent falls through to the daemon default (on). A non-boolean
    // still THROWS rather than being coerced — what memory records reaches a
    // later thread's system prompt, so `memory = "no"` must be an error, not a
    // silent posture.
    memory: optBool(e.memory, `${where}.memory`),
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
 * Admin role mappings. Three sources, merged and de-duped by
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
      if (e.role !== "architect" && e.role !== "member") {
        throw new Error(`${where}: "role" must be architect or member`);
      }
      put({ principal: e.principal, role: e.role, scope: typeof e.scope === "string" ? e.scope : "*" });
    });
  }

  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Public API

const TOP_LEVEL_KEYS = ["slack", "auth", "architects", "roles", "repos", "paths", "defaults"] as const;
const AUTH_KEYS = ["mode", "api_key"] as const;
const PATHS_KEYS = ["db", "worktrees_root", "memory_root"] as const;
const DEFAULTS_KEYS = [
  "model",
  "effort",
  "subagents",
  "workflows",
  "memory",
  "cost_cap_usd",
  "max_concurrent_turns",
] as const;

/**
 * Resolve a daemon-wide boolean default: env override wins, then the file, then
 * the built-in. The env form accepts the usual falsey spellings (`off|false|0|no`,
 * any case) so `CONDOTTO_WORKFLOWS=off` reads the way an operator expects; any
 * other non-empty value is true. Shared by every `[defaults]` toggle so they
 * cannot drift apart in how they parse.
 */
function resolveBoolDefault(
  envRaw: string | undefined,
  fileValue: unknown,
  where: string,
  builtIn: boolean,
): boolean {
  const fromEnv = envStr(envRaw)?.toLowerCase();
  if (fromEnv !== undefined) return !/^(off|false|0|no)$/.test(fromEnv);
  return optBool(fileValue, where) ?? builtIn;
}

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

  // Both on unless explicitly disabled, which with `[defaults].effort = "xhigh"`
  // is the full-strength posture a new thread starts in.
  const defaultSubagents = resolveBoolDefault(
    env.CONDOTTO_SUBAGENTS,
    defaults.subagents,
    "[defaults].subagents",
    DEFAULT_SUBAGENTS,
  );
  const defaultWorkflows = resolveBoolDefault(
    env.CONDOTTO_WORKFLOWS,
    defaults.workflows,
    "[defaults].workflows",
    DEFAULT_WORKFLOWS,
  );
  const defaultMemory = resolveBoolDefault(
    env.CONDOTTO_MEMORY,
    defaults.memory,
    "[defaults].memory",
    DEFAULT_MEMORY,
  );

  return {
    dbPath: expandHome(envStr(env.CONDOTTO_DB_PATH) ?? optString(paths.db, "[paths].db") ?? "condotto.sqlite"),
    worktreesRoot: expandHome(
      envStr(env.CONDOTTO_WORKTREES_ROOT) ?? optString(paths.worktrees_root, "[paths].worktrees_root") ?? "~/tmp/condotto-worktrees",
    ),
    memoryRoot: expandHome(
      envStr(env.CONDOTTO_MEMORY_ROOT) ?? optString(paths.memory_root, "[paths].memory_root") ?? "~/.condotto/memory",
    ),
    // Each repo's tri-state memory flag is resolved against the daemon default
    // HERE, so `RepoConfig.memory` is a plain boolean by the time it reaches the
    // store and nothing downstream has to re-derive it.
    repos: parseRepos(toml, configPath).map((r) => ({ ...r, memory: r.memory ?? defaultMemory })),
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
    defaultSubagents,
    defaultWorkflows,
    defaultMemory,
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

/**
 * Load the harness credentials the composition root hands to its adapter.
 *
 * Key resolution, first match wins:
 *   1. `[auth].api_key` in condotto.toml  (explicit config)
 *   2. `ANTHROPIC_API_KEY` in the environment
 *   3. neither → subscription OAuth (no key material to carry)
 *
 * Note this is config-over-env, the reverse of `loadSlackConfig` — an operator
 * who writes the key into the file means it, and a stray `ANTHROPIC_API_KEY`
 * left in a shell profile should not silently outrank it. As with Slack, the key
 * is *never required* to sit in the TOML: the env var alone is a complete
 * configuration, which is the documented default in the README.
 *
 * `[auth].mode` is authoritative when set. When it is absent the mode is inferred
 * from whether a key is available, so an existing subscription install keeps
 * booting unchanged after upgrading; condotto.example.toml ships `mode = "api_key"`
 * so a fresh install following the README lands on the API-key path.
 */
export function loadAuthConfig(
  env: Record<string, string | undefined> = process.env,
  configPathOverride?: string,
): AuthConfig {
  const { toml, path } = readParsedConfig(env, configPathOverride);
  const auth = toml.auth === undefined ? {} : asTable(toml.auth, "[auth]");
  warnUnknownKeys(auth, AUTH_KEYS, "[auth]");

  const apiKey = optString(auth.api_key, "[auth].api_key") ?? envStr(env.ANTHROPIC_API_KEY);

  const declared = optString(auth.mode, "[auth].mode");
  if (declared !== undefined && declared !== "api_key" && declared !== "subscription") {
    throw new Error(`[auth].mode must be "api_key" or "subscription", got "${declared}" (in ${path})`);
  }
  const mode: AuthMode = declared ?? (apiKey ? "api_key" : "subscription");

  if (mode === "api_key" && !apiKey) {
    throw new Error(
      `[auth].mode = "api_key" but no API key is available. Set ANTHROPIC_API_KEY in the ` +
        `daemon's environment (recommended — keeps the key out of ${path}), or set ` +
        `[auth].api_key in ${path}. Create a key at https://platform.claude.com/. ` +
        `To run against a personal Claude subscription instead — single operator only — ` +
        `set [auth].mode = "subscription". See the README ("Authenticate Claude").`,
    );
  }

  // Subscription mode carries no key material: drop anything we resolved so it
  // cannot reach the agent's environment on a path the operator did not choose.
  return mode === "api_key" ? { mode, apiKey } : { mode };
}

/**
 * Warn — never refuse — when subscription auth is paired with a config that lets
 * more than one person drive sessions. Anthropic scopes OAuth to ordinary
 * individual use of Claude Code and the Agent SDK, so a team on one personal
 * subscription is outside what that credential is for; the API-key path is the
 * documented answer. Whether to keep going is the operator's call, not ours.
 *
 * Returns the warning text, or null when the pairing raises no question. Grants
 * made at runtime (`@Condotto grant`) are deliberately not re-checked here — this
 * is a boot-time signal about how the install is configured, not a live monitor.
 */
export function subscriptionScaleWarning(config: CondottoConfig, mode: AuthMode): string | null {
  if (mode !== "subscription") return null;
  const architects = config.roles.filter((r) => r.role === "architect").length;
  const drivers = config.roles.filter((r) => r.role === "architect" || r.role === "member").length;
  if (drivers <= 1) return null;
  return (
    `subscription auth is configured, but ${drivers} principals can drive sessions ` +
    `(${architects} architect${architects === 1 ? "" : "s"}). Anthropic's plan limits for ` +
    `Claude Free/Pro/Max assume ordinary, individual use of Claude Code and the Agent SDK, ` +
    `so subscription auth is intended for a single operator driving their own sessions. ` +
    `For team use, switch to an API key from Claude Console: set ANTHROPIC_API_KEY and ` +
    `[auth].mode = "api_key". See the README ("Authenticate Claude"). Continuing.`
  );
}

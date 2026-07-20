import { Database } from "bun:sqlite";
import type { Role, SessionHandle } from "./types";

// SQLite store (DESIGN.md §5). One process, one file, WAL mode.
// Invariants enforced here in code, not just schema:
//   - (surface_id, conversation_id) -> exactly one session, forever (UNIQUE).
//   - worktree_path is absolute and never rewritten once set.
//   - harness_session_handle is opaque JSON: persisted verbatim, never parsed
//     beyond JSON round-tripping.

export type SessionStatus = "active" | "parked" | "stopped";

export interface SessionRow {
  id: string;
  surface_id: string;
  conversation_id: string;
  channel_id: string;
  repo_id: string;
  worktree_path: string;
  harness_id: string;
  harness_session_handle: SessionHandle | null;
  branch: string;
  status: SessionStatus;
  /** Per-thread cost ceiling in USD; null = use the daemon-wide default. */
  budget_limit_usd: number | null;
  /**
   * Harness capability state. model/effort are opaque tokens (null =
   * fall back to the daemon-wide default); subagents/workflows/workflow_write are
   * 0/1 flags gating the multi-agent tools (default 0 — architect opt-in). Invariant
   * (enforced in the session manager): workflow_write ⟹ workflows ⟹ subagents.
   */
  model: string | null;
  effort: string | null;
  subagents: number;
  workflows: number;
  /** The informed worktree-write opt-in for workflow/escaped calls. */
  workflow_write: number;
  /**
   * Architect self-approve: when 1, a gated tool call on a turn initiated by
   * an architect runs without the Approve click (the hard-deny floor still
   * applies). Default 1 (on) — an architect toggles it per thread with
   * `@Condotto auto-approve on|off`.
   */
  auto_approve: number;
  /**
   * Worktree GC: when non-null, this session was explicitly stopped with
   * the `clean` variant and its worktree becomes collectible at this ISO
   * timestamp (the stop time + retention interval). NULL is the resting state —
   * a live/parked session, or a plain `stop` that keeps its worktree for
   * reactivation (DESIGN §2 journey 6). The GC NEVER collects a NULL row's
   * worktree, which is how the park-and-resume invariant (§2 journey 5) is held.
   */
  cleanup_at: string | null;
  created_at: string;
  last_active_at: string;
}

export class ConflictError extends Error {}

/** A repo as read back from the store (includes test/land/deploy + cost cap). */
export interface RepoRow {
  id: string;
  name: string;
  path: string;
  default_branch: string;
  safe_bash_allowlist: string[];
  test_cmd: string | null;
  land_cmd: string | null;
  deploy_cmd: string | null;
  cost_cap_usd: number | null;
  /** Per-repo default model/effort tokens; null = daemon-wide default. */
  default_model: string | null;
  default_effort: string | null;
  /** Trust flag: 1 loads project config/skills/MCP; 0 stays isolated. */
  trusted: number;
  /**
   * Per-repo default for architect self-approve, seeded onto each new
   * session. 1 = on, 0 = off, null = fall back to the daemon-wide default.
   */
  default_auto_approve: number | null;
}

interface RawRepoRow extends Omit<RepoRow, "safe_bash_allowlist"> {
  safe_bash_allowlist: string;
}

interface RawSessionRow extends Omit<SessionRow, "harness_session_handle"> {
  harness_session_handle: string | null;
}

function inflate(row: RawSessionRow | null): SessionRow | null {
  if (!row) return null;
  return {
    ...row,
    harness_session_handle:
      row.harness_session_handle === null ? null : JSON.parse(row.harness_session_handle),
  };
}

function parseJsonArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export type ApprovalDecision = "pending" | "approved" | "denied" | "expired";

/**
 * Where a role mapping came from. `config` rows are wiped + reseeded from
 * `condotto.toml` (`architects`/`[[roles]]`) / `CONDOTTO_ARCHITECTS` on every boot
 * (config stays authoritative); `grant` rows are runtime `@Condotto grant`
 * delegations that survive restart.
 */
export type RoleSource = "config" | "grant";

export interface ApprovalRow {
  id: string; // == requestId, carried in the surface's approval control
  session_id: string;
  tool_use_id: string | null;
  tool_name: string;
  tool_input: unknown;
  requested_at: string;
  decided_by: string | null;
  decision: ApprovalDecision;
  decided_at: string | null;
  /**
   * The principalKey of the human whose turn caused this gated call. Carried
   * so a defer→resume continuation is governed by the ORIGINAL initiator (never the
   * approving decider), which prevents laundering a member's turn into architect
   * auto-approval. Null on older rows and on daemon-run ship approvals.
   */
  initiated_by: string | null;
}

interface RawApprovalRow extends Omit<ApprovalRow, "tool_input"> {
  tool_input: string;
}

function inflateApproval(row: RawApprovalRow | null): ApprovalRow | null {
  if (!row) return null;
  let toolInput: unknown = {};
  try {
    toolInput = JSON.parse(row.tool_input);
  } catch {
    toolInput = {};
  }
  return { ...row, tool_input: toolInput };
}

/**
 * Schema baseline — migration **v1** of the ordered `user_version` runner.
 * The full schema, expressed **idempotently** (`CREATE TABLE IF NOT
 * EXISTS` + `ensureColumn`) so it lands the same result whether it runs on:
 *   - a brand-new empty DB (creates every table + column), or
 *   - the pre-runner store, which sat at `user_version` 0 with every column
 *     already added by the old ad-hoc bootstrap — here every statement is a
 *     no-op and the runner simply stamps it to v1.
 * That idempotent shape is exactly what makes adopting the version runner over
 * the existing live store lossless. Do NOT "tidy" it into inline-columned
 * `CREATE`s, and do NOT add new schema here — a NEW change is a NEW migration
 * appended to the `migrations` list, never an edit to this baseline.
 */
function migrateBaselineV1(db: Database): void {
  db.run(`
      CREATE TABLE IF NOT EXISTS repos (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        path TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        safe_bash_allowlist TEXT NOT NULL DEFAULT '[]',
        deploy_cmd TEXT,
        land_cmd TEXT,
        policy_overrides TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS surfaces (
        id TEXT PRIMARY KEY,
        config TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        surface_id TEXT NOT NULL REFERENCES surfaces(id),
        external_channel_id TEXT NOT NULL,
        repo_id TEXT REFERENCES repos(id),
        default_role_map TEXT NOT NULL DEFAULT '{}',
        UNIQUE(surface_id, external_channel_id)
      );

      CREATE TABLE IF NOT EXISTS roles (
        principal TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT '*',
        role TEXT NOT NULL CHECK (role IN ('architect','member','observer')),
        PRIMARY KEY (principal, scope)
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        surface_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        harness_id TEXT NOT NULL,
        harness_session_handle TEXT,
        branch TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active','parked','stopped')),
        created_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL,
        UNIQUE(surface_id, conversation_id)
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        tool_use_id TEXT,
        tool_name TEXT NOT NULL,
        tool_input TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        decided_by TEXT,
        decision TEXT NOT NULL DEFAULT 'pending'
          CHECK (decision IN ('pending','approved','denied','expired')),
        decided_at TEXT,
        resume_token TEXT
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        ts TEXT NOT NULL,
        actor TEXT NOT NULL,
        event TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        direction TEXT NOT NULL CHECK (direction IN ('in','out')),
        principal TEXT,
        text TEXT NOT NULL,
        cost_usd REAL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        result_subtype TEXT
      );
    `);

  // Idempotent column adds for DBs created by the earlier schema (the
  // approvals table predates tool_use_id). CREATE TABLE IF NOT EXISTS never
  // alters an existing table, so evolve columns explicitly, then build any
  // index that references them.
  ensureColumn(db, "approvals", "tool_use_id", "TEXT");
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_approvals_tooluse ON approvals (session_id, tool_use_id);`,
  );

  // Per-repo test command + cost cap, and a per-session cost ceiling.
  // (deploy_cmd/land_cmd already exist from the earlier repos schema above.)
  ensureColumn(db, "repos", "test_cmd", "TEXT");
  ensureColumn(db, "repos", "cost_cap_usd", "REAL");
  ensureColumn(db, "sessions", "budget_limit_usd", "REAL");

  // Per-session harness capability state + per-repo defaults/trust. NOT
  // NULL flags carry a DEFAULT so older rows migrate cleanly (subagents/
  // workflows/trusted default off — the conservative posture).
  ensureColumn(db, "sessions", "model", "TEXT");
  ensureColumn(db, "sessions", "effort", "TEXT");
  ensureColumn(db, "sessions", "subagents", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "sessions", "workflows", "INTEGER NOT NULL DEFAULT 0");
  // The worktree-write opt-in for workflow/escaped calls.
  ensureColumn(db, "sessions", "workflow_write", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "repos", "default_model", "TEXT");
  ensureColumn(db, "repos", "default_effort", "TEXT");
  ensureColumn(db, "repos", "trusted", "INTEGER NOT NULL DEFAULT 0");

  // Architect self-approve (per-session flag, DEFAULT 1 so it is ON by
  // default and existing sessions adopt it on upgrade — the deliberate posture
  // choice, 2026-07-19) + per-repo default. Runtime role grants that survive the
  // boot reseed (`source` separates config-seeded rows, wiped+reseeded each boot,
  // from runtime grants, kept; granted_by/granted_at are grant provenance). And
  // the initiating principal on an approval, so a defer→resume is governed by the
  // original initiator, not the approving decider.
  ensureColumn(db, "sessions", "auto_approve", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "repos", "default_auto_approve", "INTEGER");
  ensureColumn(db, "roles", "source", "TEXT NOT NULL DEFAULT 'config'");
  ensureColumn(db, "roles", "granted_by", "TEXT");
  ensureColumn(db, "roles", "granted_at", "TEXT");
  ensureColumn(db, "approvals", "initiated_by", "TEXT");
}

/**
 * Migration **v2** (worktree GC): schedule column for the worktree garbage
 * collector. `cleanup_at` is set only by an explicit `@Condotto stop clean` (to
 * stop-time + retention interval); the GC collects the worktree once due and then
 * discards the session row. A plain stop leaves it NULL — never collected. Plain
 * forward DDL: unlike the baseline it only ever runs on a store already at v1, so
 * no `ensureColumn` gymnastics are needed (the runner guarantees exactly-once).
 */
function migrateV2(db: Database): void {
  db.run(`ALTER TABLE sessions ADD COLUMN cleanup_at TEXT`);
}

/** Add `column` to `table` only if absent (idempotent ALTER — SQLite has no
 *  `ADD COLUMN IF NOT EXISTS`). Used by the baseline migration to evolve tables
 *  a pre-runner DB already created. */
function ensureColumn(db: Database, table: string, column: string, ddl: string): void {
  const cols = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

export class Store {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("PRAGMA journal_mode = WAL;");
    this.db.run("PRAGMA foreign_keys = ON;");
    this.db.run("PRAGMA busy_timeout = 5000;"); // fail slow, not sporadically, if a second process appears
    this.migrate();
  }

  /**
   * Ordered, append-only schema migrations. Entry `i` (0-based) carries
   * a store from `user_version` i to i+1; `migrations.length` IS the current
   * schema version. Because an operator upgrades a binary in place over a
   * persistent SQLite store, this list is the contract that never strands an
   * install. RULES:
   *   - NEVER edit, delete, or reorder a shipped entry — only APPEND. Editing a
   *     past migration diverges freshly-created DBs from upgraded ones.
   *   - Each step + its version bump run in ONE transaction. `bun:sqlite` makes
   *     DDL and `PRAGMA user_version` transactional (verified), so a
   *     crash mid-upgrade rolls the whole step back and the next boot retries it.
   *   - A store from a NEWER binary (version > what we know) is refused, not
   *     silently run against — downgrades are unsupported.
   */
  private migrate(): void {
    const migrations: Array<(db: Database) => void> = [
      migrateBaselineV1, // v1: the schema as one idempotent baseline.
      migrateV2, // v2: sessions.cleanup_at for the worktree GC.
      // v3+: append new migrations here. They only ever run on a store already
      // at the prior version, so they can be plain forward DDL — no IF NOT EXISTS
      // gymnastics.
    ];

    const current = this.userVersion();
    if (current > migrations.length) {
      throw new Error(
        `condotto database schema is at version ${current}, but this Condotto build only ` +
          `understands up to ${migrations.length}. You are running an OLDER binary against a ` +
          `store written by a NEWER one — upgrade the binary (downgrade migrations are not supported).`,
      );
    }
    for (let v = current; v < migrations.length; v++) {
      const step = migrations[v]!;
      // v + 1 is an internal loop counter, never user input; PRAGMA forbids
      // bound parameters, so interpolating it here is safe.
      this.db.transaction(() => {
        step(this.db);
        this.db.run(`PRAGMA user_version = ${v + 1}`);
      })();
    }
  }

  private userVersion(): number {
    return this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
  }

  close(): void {
    this.db.close();
  }

  // -- repos ----------------------------------------------------------------

  upsertRepo(repo: {
    name: string;
    path: string;
    defaultBranch: string;
    safeBashAllowlist?: string[];
    testCmd?: string;
    landCmd?: string;
    deployCmd?: string;
    costCapUsd?: number;
    defaultModel?: string;
    defaultEffort?: string;
    trusted?: boolean;
    autoApprove?: boolean;
  }): void {
    this.db
      .query(
        `INSERT INTO repos
           (id, name, path, default_branch, safe_bash_allowlist,
            test_cmd, land_cmd, deploy_cmd, cost_cap_usd,
            default_model, default_effort, trusted, default_auto_approve)
         VALUES ($id, $name, $path, $branch, $allow, $test, $land, $deploy, $cap,
                 $model, $effort, $trusted, $autoApprove)
         ON CONFLICT(name) DO UPDATE SET
           path = $path, default_branch = $branch, safe_bash_allowlist = $allow,
           test_cmd = $test, land_cmd = $land, deploy_cmd = $deploy, cost_cap_usd = $cap,
           default_model = $model, default_effort = $effort, trusted = $trusted,
           default_auto_approve = $autoApprove`,
      )
      .run({
        id: repo.name,
        name: repo.name,
        path: repo.path,
        branch: repo.defaultBranch,
        allow: JSON.stringify(repo.safeBashAllowlist ?? []),
        test: repo.testCmd ?? null,
        land: repo.landCmd ?? null,
        deploy: repo.deployCmd ?? null,
        cap: repo.costCapUsd ?? null,
        model: repo.defaultModel ?? null,
        effort: repo.defaultEffort ?? null,
        trusted: repo.trusted ? 1 : 0,
        // undefined = leave to the daemon default; only an explicit bool pins it.
        autoApprove: repo.autoApprove === undefined ? null : repo.autoApprove ? 1 : 0,
      });
  }

  /**
   * Reconcile the repos table with config: drop rows for repos no longer
   * declared in `condotto.toml`. Config is the source of truth for which repos
   * exist, but `upsertRepo` only ever inserts/updates — without this, a repo an
   * operator removed (or the synthesized `testrepo` from before it was deleted)
   * lingers in the DB and stays assignable, since every runtime lookup reads the
   * store rather than config.
   *
   * A row still referenced by a session is KEPT and reported, never deleted:
   * `sessions.repo_id` carries the name, so dropping it would strand that
   * thread's history and its worktree GC. The caller surfaces those so an
   * operator can re-declare the repo or stop the session.
   */
  pruneReposNotIn(declared: string[]): { deleted: string[]; keptInUse: string[] } {
    const keep = new Set(declared);
    const deleted: string[] = [];
    const keptInUse: string[] = [];
    const inUse = this.db.query<{ repo_id: string }, []>(`SELECT DISTINCT repo_id FROM sessions`).all();
    const referenced = new Set(inUse.map((r) => r.repo_id));
    for (const row of this.db.query<{ name: string }, []>(`SELECT name FROM repos`).all()) {
      if (keep.has(row.name)) continue;
      if (referenced.has(row.name)) {
        keptInUse.push(row.name);
        continue;
      }
      this.db.query<unknown, { name: string }>(`DELETE FROM repos WHERE name = $name`).run({ name: row.name });
      deleted.push(row.name);
    }
    return { deleted, keptInUse };
  }

  getRepo(name: string): RepoRow | null {
    const row = this.db
      .query<RawRepoRow, { name: string }>(
        `SELECT id, name, path, default_branch, safe_bash_allowlist,
                test_cmd, land_cmd, deploy_cmd, cost_cap_usd,
                default_model, default_effort, trusted, default_auto_approve
         FROM repos WHERE name = $name`,
      )
      .get({ name });
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      path: row.path,
      default_branch: row.default_branch,
      safe_bash_allowlist: parseJsonArray(row.safe_bash_allowlist),
      test_cmd: row.test_cmd,
      land_cmd: row.land_cmd,
      deploy_cmd: row.deploy_cmd,
      cost_cap_usd: row.cost_cap_usd,
      default_model: row.default_model,
      default_effort: row.default_effort,
      trusted: row.trusted,
      default_auto_approve: row.default_auto_approve,
    };
  }

  listRepos(): { name: string; path: string; default_branch: string }[] {
    return this.db
      .query<{ name: string; path: string; default_branch: string }, []>(
        `SELECT name, path, default_branch FROM repos ORDER BY name`,
      )
      .all();
  }

  // -- sessions -------------------------------------------------------------

  createSession(
    s: Omit<
      SessionRow,
      "created_at" | "last_active_at" | "budget_limit_usd" | "model" | "effort" | "subagents" | "workflows" | "workflow_write" | "auto_approve" | "cleanup_at"
    > & {
      budget_limit_usd?: number | null;
      model?: string | null;
      effort?: string | null;
      subagents?: number;
      workflows?: number;
      auto_approve?: number;
    },
  ): SessionRow {
    const now = new Date().toISOString();
    const budget = s.budget_limit_usd ?? null;
    const model = s.model ?? null;
    const effort = s.effort ?? null;
    const subagents = s.subagents ?? 0;
    const workflows = s.workflows ?? 0;
    // On by default (matches the column DEFAULT and the shipped posture);
    // assign passes the repo/daemon-resolved value explicitly.
    const autoApprove = s.auto_approve ?? 1;
    try {
      this.db
        .query(
          `INSERT INTO sessions
             (id, surface_id, conversation_id, channel_id, repo_id, worktree_path,
              harness_id, harness_session_handle, branch, status, budget_limit_usd,
              model, effort, subagents, workflows, auto_approve, created_at, last_active_at)
           VALUES ($id, $surface_id, $conversation_id, $channel_id, $repo_id, $worktree_path,
                   $harness_id, $handle, $branch, $status, $budget,
                   $model, $effort, $subagents, $workflows, $autoApprove, $now, $now)`,
        )
        .run({
          id: s.id,
          surface_id: s.surface_id,
          conversation_id: s.conversation_id,
          channel_id: s.channel_id,
          repo_id: s.repo_id,
          worktree_path: s.worktree_path,
          harness_id: s.harness_id,
          handle: s.harness_session_handle === null ? null : JSON.stringify(s.harness_session_handle),
          branch: s.branch,
          status: s.status,
          budget,
          model,
          effort,
          subagents,
          workflows,
          autoApprove,
          now,
        });
    } catch (err) {
      if (err instanceof Error && /UNIQUE/.test(err.message)) {
        throw new ConflictError(
          `session already exists for (${s.surface_id}, ${s.conversation_id})`,
        );
      }
      throw err;
    }
    return {
      ...s,
      budget_limit_usd: budget,
      model,
      effort,
      subagents,
      workflows,
      workflow_write: 0,
      auto_approve: autoApprove,
      cleanup_at: null,
      created_at: now,
      last_active_at: now,
    };
  }

  getSessionByConversation(surfaceId: string, conversationId: string): SessionRow | null {
    const row = this.db
      .query<RawSessionRow, { s: string; c: string }>(
        `SELECT * FROM sessions WHERE surface_id = $s AND conversation_id = $c`,
      )
      .get({ s: surfaceId, c: conversationId });
    return inflate(row);
  }

  getSession(id: string): SessionRow | null {
    const row = this.db
      .query<RawSessionRow, { id: string }>(`SELECT * FROM sessions WHERE id = $id`)
      .get({ id });
    return inflate(row);
  }

  listSessions(opts: { surfaceId?: string; statuses?: SessionStatus[] } = {}): SessionRow[] {
    const statuses = opts.statuses ?? ["active", "parked"];
    const rows = this.db
      .query<RawSessionRow, Record<string, string>>(
        `SELECT * FROM sessions
         WHERE status IN (${statuses.map((_, i) => `$st${i}`).join(",")})
           ${opts.surfaceId ? "AND surface_id = $surface" : ""}
         ORDER BY last_active_at DESC`,
      )
      .all({
        ...Object.fromEntries(statuses.map((st, i) => [`st${i}`, st])),
        ...(opts.surfaceId ? { surface: opts.surfaceId } : {}),
      });
    return rows.map((r) => inflate(r)!) as SessionRow[];
  }

  updateSessionHandle(id: string, handle: SessionHandle): void {
    this.db
      .query(`UPDATE sessions SET harness_session_handle = $handle WHERE id = $id`)
      .run({ id, handle: JSON.stringify(handle) });
  }

  updateSessionStatus(id: string, status: SessionStatus): void {
    this.db.query(`UPDATE sessions SET status = $status WHERE id = $id`).run({ id, status });
  }

  /**
   * Atomically move a session to 'active' only if it is not stopped. Returns
   * false if it was stopped — a stop that landed while a turn was starting must
   * never be resurrected (DESIGN.md: stop is irreversible mid-flight).
   */
  tryActivate(id: string): boolean {
    return (
      this.db
        .query(`UPDATE sessions SET status = 'active' WHERE id = $id AND status != 'stopped'`)
        .run({ id }).changes > 0
    );
  }

  /**
   * Startup reconciliation: 'active' means a turn is in flight, so any
   * 'active' row at boot is an orphan from a crash mid-turn. Park them so the
   * state machine starts clean.
   */
  parkOrphanedActiveSessions(): number {
    return this.db.query(`UPDATE sessions SET status = 'parked' WHERE status = 'active'`).run()
      .changes;
  }

  touchSession(id: string): void {
    this.db
      .query(`UPDATE sessions SET last_active_at = $now WHERE id = $id`)
      .run({ id, now: new Date().toISOString() });
  }

  /** Raise/lower a session's cost ceiling (architect `@Condotto budget`). */
  setSessionBudgetLimit(id: string, usd: number): void {
    this.db.query(`UPDATE sessions SET budget_limit_usd = $usd WHERE id = $id`).run({ id, usd });
  }

  /** Set a session's model token (`@Condotto model`). null = daemon default. */
  setSessionModel(id: string, model: string | null): void {
    this.db.query(`UPDATE sessions SET model = $model WHERE id = $id`).run({ id, model });
  }

  /** Set a session's effort token (`@Condotto effort`). null = daemon default. */
  setSessionEffort(id: string, effort: string | null): void {
    this.db.query(`UPDATE sessions SET effort = $effort WHERE id = $id`).run({ id, effort });
  }

  /** Toggle a session's subagent tools (`@Condotto subagents`). */
  setSessionSubagents(id: string, on: boolean): void {
    this.db.query(`UPDATE sessions SET subagents = $v WHERE id = $id`).run({ id, v: on ? 1 : 0 });
  }

  /** Toggle a session's architect self-approve (`@Condotto auto-approve`). */
  setSessionAutoApprove(id: string, on: boolean): void {
    this.db.query(`UPDATE sessions SET auto_approve = $v WHERE id = $id`).run({ id, v: on ? 1 : 0 });
  }

  /**
   * Toggle a session's Workflow tool (part of the `ultra` preset). Turning
   * it OFF also clears the worktree-write opt-in (invariant: workflow_write ⟹
   * workflows), so a re-enable never silently resurrects write mode.
   */
  setSessionWorkflows(id: string, on: boolean): void {
    if (on) {
      this.db.query(`UPDATE sessions SET workflows = 1 WHERE id = $id`).run({ id });
    } else {
      this.db.query(`UPDATE sessions SET workflows = 0, workflow_write = 0 WHERE id = $id`).run({ id });
    }
  }

  /**
   * Toggle a session's worktree-write opt-in for workflow/escaped calls.
   * Enabling it also asserts the `write ⟹ workflows ⟹ subagents` invariant in the DB
   * (defense-in-depth — the manager already enables both first, but this keeps the
   * store self-consistent no matter the caller).
   */
  setSessionWorkflowWrite(id: string, on: boolean): void {
    if (on) {
      this.db.query(`UPDATE sessions SET workflow_write = 1, workflows = 1, subagents = 1 WHERE id = $id`).run({ id });
    } else {
      this.db.query(`UPDATE sessions SET workflow_write = 0 WHERE id = $id`).run({ id });
    }
  }

  /**
   * Cumulative spend for a session in USD (runaway cap, DESIGN §4). Sums the
   * per-turn `cost_usd` the harness reported; SQLite returns NULL for an empty
   * set, coalesced to 0.
   */
  sessionCostUsd(id: string): number {
    const row = this.db
      .query<{ total: number }, { id: string }>(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM turns WHERE session_id = $id`,
      )
      .get({ id });
    return row?.total ?? 0;
  }

  // -- worktree GC --------------------------------------------------

  /**
   * Schedule this session's worktree for collection at `cleanupAt` (ISO) — set by
   * an explicit `@Condotto stop clean`. Only a `stopped` session is ever marked;
   * the GC re-checks status before acting. Reactivation clears it via
   * `clearSessionCleanup`, so a within-window resume cancels the teardown.
   */
  markSessionForCleanup(id: string, cleanupAt: string): void {
    this.db.query(`UPDATE sessions SET cleanup_at = $at WHERE id = $id`).run({ id, at: cleanupAt });
  }

  /** Cancel a scheduled worktree cleanup (a clean-stopped session was reactivated). */
  clearSessionCleanup(id: string): void {
    this.db.query(`UPDATE sessions SET cleanup_at = NULL WHERE id = $id`).run({ id });
  }

  /**
   * Sessions whose worktree is due for collection: explicitly clean-stopped
   * (`cleanup_at` set) and past that instant. The `status = 'stopped'` guard bakes
   * the park-and-resume invariant (§2 journey 5) into the query itself — a
   * live/parked row can never surface here even if a `cleanup_at` somehow lingered.
   * ISO-8601 UTC strings compare lexically == chronologically, so the `<=` is safe.
   */
  sessionsDueForCleanup(nowIso: string): SessionRow[] {
    const rows = this.db
      .query<RawSessionRow, { now: string }>(
        `SELECT * FROM sessions
         WHERE status = 'stopped' AND cleanup_at IS NOT NULL AND cleanup_at <= $now
         ORDER BY cleanup_at ASC`,
      )
      .all({ now: nowIso });
    return rows.map((r) => inflate(r)!) as SessionRow[];
  }

  /**
   * Delete a session and its operational rows (approvals, turns) in one
   * transaction — used by the GC to discard a clean-stopped session once its
   * worktree is gone. The `audit_log` is deliberately KEPT (it has no FK to
   * sessions): the durable security/decision trail must survive a discard, even
   * though the conversational turn history and approval ledger rows do not. FK
   * ordering matters — children before the parent — or the parent delete is
   * blocked (`foreign_keys = ON`).
   */
  deleteSession(id: string): void {
    this.db.transaction(() => {
      this.db.query(`DELETE FROM approvals WHERE session_id = $id`).run({ id });
      this.db.query(`DELETE FROM turns WHERE session_id = $id`).run({ id });
      this.db.query(`DELETE FROM sessions WHERE id = $id`).run({ id });
    })();
  }

  // -- turns ----------------------------------------------------------------

  insertTurn(t: {
    sessionId: string;
    direction: "in" | "out";
    principal?: string;
    text: string;
    costUsd?: number;
    resultSubtype?: string;
  }): void {
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO turns (session_id, direction, principal, text, cost_usd, started_at, ended_at, result_subtype)
         VALUES ($sid, $dir, $principal, $text, $cost, $now, $now, $subtype)`,
      )
      .run({
        sid: t.sessionId,
        dir: t.direction,
        principal: t.principal ?? null,
        text: t.text,
        cost: t.costUsd ?? null,
        now,
        subtype: t.resultSubtype ?? null,
      });
  }

  // -- audit ----------------------------------------------------------------

  audit(entry: { sessionId?: string; actor: string; event: string; detail?: unknown }): void {
    this.db
      .query(
        `INSERT INTO audit_log (session_id, ts, actor, event, detail)
         VALUES ($sid, $ts, $actor, $event, $detail)`,
      )
      .run({
        sid: entry.sessionId ?? null,
        ts: new Date().toISOString(),
        actor: entry.actor,
        event: entry.event,
        detail: JSON.stringify(entry.detail ?? {}),
      });
  }

  /** Audit entries for a session, oldest first. */
  listAudit(sessionId: string): { actor: string; event: string; detail: unknown }[] {
    return this.db
      .query<{ actor: string; event: string; detail: string }, { sid: string }>(
        `SELECT actor, event, detail FROM audit_log WHERE session_id = $sid ORDER BY id ASC`,
      )
      .all({ sid: sessionId })
      .map((r) => {
        let detail: unknown = {};
        try {
          detail = JSON.parse(r.detail);
        } catch {
          detail = {};
        }
        return { actor: r.actor, event: r.event, detail };
      });
  }

  // -- roles ----------------------------------------------------------------

  /**
   * Upsert a role mapping. scope is a channel_id or '*' (all channels). `source`
   * separates config-seeded rows — wiped + reseeded every boot by
   * `clearConfigRoles` — from runtime grants (`'grant'`), which survive restart.
   * Default `'config'` keeps every earlier caller (boot reseed, assign, tests)
   * unchanged. `roleOf`/`isArchitect` ignore `source`, so a grant is authoritative
   * exactly like a config row.
   */
  setRole(
    principal: string,
    role: Role,
    scope = "*",
    source: RoleSource = "config",
    grantedBy: string | null = null,
  ): void {
    this.db
      .query(
        `INSERT INTO roles (principal, scope, role, source, granted_by, granted_at)
         VALUES ($p, $s, $r, $src, $by, $at)
         ON CONFLICT(principal, scope) DO UPDATE SET
           role = $r, source = $src, granted_by = $by, granted_at = $at`,
      )
      .run({ p: principal, s: scope, r: role, src: source, by: grantedBy, at: grantedBy ? new Date().toISOString() : null });
  }

  /**
   * Remove a role mapping. When `source` is given, only a row of that source is
   * removed — `deleteRole(p, scope, "grant")` can never touch a config-seeded row,
   * so a runtime `revoke` cannot override the admin's config. Returns the number of
   * rows removed (0 = nothing matched).
   */
  deleteRole(principal: string, scope = "*", source?: RoleSource): number {
    const sql = source
      ? `DELETE FROM roles WHERE principal = $p AND scope = $s AND source = $src`
      : `DELETE FROM roles WHERE principal = $p AND scope = $s`;
    const params = source ? { p: principal, s: scope, src: source } : { p: principal, s: scope };
    return this.db.query(sql).run(params as Record<string, string>).changes;
  }

  /**
   * The effective role of a principal in a channel. A channel-scoped mapping
   * wins over a '*' mapping; absent any mapping, everyone is a `member`
   * (they can converse; only architects hold command authority — DESIGN.md §2).
   */
  roleOf(principal: string, channelId: string): Role {
    const rows = this.db
      .query<{ scope: string; role: Role }, { p: string; c: string }>(
        `SELECT scope, role FROM roles WHERE principal = $p AND scope IN ($c, '*')`,
      )
      .all({ p: principal, c: channelId });
    const scoped = rows.find((r) => r.scope === channelId);
    if (scoped) return scoped.role;
    const global = rows.find((r) => r.scope === "*");
    return global ? global.role : "member";
  }

  isArchitect(principal: string, channelId: string): boolean {
    return this.roleOf(principal, channelId) === "architect";
  }

  /**
   * Daemon-wide count of distinct principals holding an `architect` role at any
   * scope (operator status config summary). Counts a person once even if
   * they are an architect in several channels — the gauge is "how many people can
   * approve", not "how many role rows exist".
   */
  countArchitects(): number {
    const row = this.db
      .query<{ n: number }, []>(`SELECT COUNT(DISTINCT principal) AS n FROM roles WHERE role = 'architect'`)
      .get();
    return row?.n ?? 0;
  }

  /**
   * The exact role row for a (principal, scope) pair, with its source — used
   * by `grant`/`revoke` to reason about provenance (e.g. refuse to shadow-demote a
   * config architect). Null when no row exists at that exact scope. NOTE: this is an
   * EXACT-scope lookup, not the effective-role precedence of `roleOf`.
   */
  getRoleRow(principal: string, scope: string): { role: Role; source: RoleSource } | null {
    return this.db
      .query<{ role: Role; source: RoleSource }, { p: string; s: string }>(
        `SELECT role, source FROM roles WHERE principal = $p AND scope = $s`,
      )
      .get({ p: principal, s: scope });
  }

  /**
   * Remove all role mappings. Config is the source of truth for roles, so
   * the daemon clears and re-seeds at boot — removing a principal from config
   * must actually revoke their authority, not leave a stale row behind.
   */
  clearRoles(): void {
    this.db.run(`DELETE FROM roles`);
  }

  /**
   * Boot reconcile: remove only config-seeded rows so runtime `@Condotto
   * grant` delegations (source='grant') survive the restart, then the daemon
   * reseeds config rows. Removing a principal from config still revokes their
   * config authority; grants are a separate, additive namespace.
   */
  clearConfigRoles(): void {
    this.db.run(`DELETE FROM roles WHERE source = 'config'`);
  }

  // -- approvals ------------------------------------------------------------

  createApproval(a: {
    id: string;
    sessionId: string;
    toolUseId: string | null;
    toolName: string;
    toolInput: unknown;
    /** principalKey of the human whose turn caused this call (see ApprovalRow). */
    initiatedBy?: string | null;
  }): void {
    this.db
      .query(
        `INSERT INTO approvals (id, session_id, tool_use_id, tool_name, tool_input, requested_at, decision, initiated_by)
         VALUES ($id, $sid, $tuid, $name, $input, $now, 'pending', $initBy)`,
      )
      .run({
        id: a.id,
        sid: a.sessionId,
        tuid: a.toolUseId,
        name: a.toolName,
        input: JSON.stringify(a.toolInput ?? {}),
        now: new Date().toISOString(),
        initBy: a.initiatedBy ?? null,
      });
  }

  /**
   * Record an architect auto-approval as an already-decided `approved` row —
   * so the `approvals` ledger stays complete (every consequential action is
   * attributable) with no transient `pending` window that `hasPendingApproval`
   * would trip. `decided_by` = the architect whose standing authority stood in.
   */
  recordAutoApproval(a: {
    sessionId: string;
    toolUseId: string | null;
    toolName: string;
    toolInput: unknown;
    initiator: string;
  }): void {
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO approvals
           (id, session_id, tool_use_id, tool_name, tool_input, requested_at, decision, decided_by, decided_at, initiated_by)
         VALUES ($id, $sid, $tuid, $name, $input, $now, 'approved', $by, $now, $by)`,
      )
      .run({
        id: crypto.randomUUID(),
        sid: a.sessionId,
        tuid: a.toolUseId,
        name: a.toolName,
        input: JSON.stringify(a.toolInput ?? {}),
        now,
        by: a.initiator,
      });
  }

  getApproval(id: string): ApprovalRow | null {
    const row = this.db
      .query<RawApprovalRow, { id: string }>(`SELECT * FROM approvals WHERE id = $id`)
      .get({ id });
    return inflateApproval(row);
  }

  /** True if the session is currently blocked on an undecided approval. */
  hasPendingApproval(sessionId: string): boolean {
    const row = this.db
      .query<{ one: number }, { sid: string }>(
        `SELECT 1 AS one FROM approvals WHERE session_id = $sid AND decision = 'pending' LIMIT 1`,
      )
      .get({ sid: sessionId });
    return row !== null;
  }

  /**
   * Daemon-wide count of undecided approvals (operator status). Every
   * pending row is a session waiting on an architect's Approve/Deny click, so the
   * total is the operator's "how many threads are blocked on me right now" gauge.
   */
  countPendingApprovals(): number {
    const row = this.db
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM approvals WHERE decision = 'pending'`)
      .get();
    return row?.n ?? 0;
  }

  /** Most recent approval for a re-driven tool call, keyed by tool_use_id. */
  getApprovalByToolUse(sessionId: string, toolUseId: string): ApprovalRow | null {
    const row = this.db
      .query<RawApprovalRow, { sid: string; tuid: string }>(
        // rowid is monotonic with insertion — deterministic even when two
        // approvals for the same tool_use_id land in the same millisecond.
        `SELECT * FROM approvals WHERE session_id = $sid AND tool_use_id = $tuid
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get({ sid: sessionId, tuid: toolUseId });
    return inflateApproval(row);
  }

  /**
   * Transition a pending approval to approved/denied. Returns true iff this
   * call actually made the transition — a second click (Slack delivers actions
   * at-least-once, and buttons can be double-clicked) returns false so the
   * caller resumes the session exactly once.
   */
  decideApproval(id: string, decidedBy: string, decision: "approved" | "denied"): boolean {
    const changes = this.db
      .query(
        `UPDATE approvals SET decision = $d, decided_by = $by, decided_at = $now
         WHERE id = $id AND decision = 'pending'`,
      )
      .run({ id, d: decision, by: decidedBy, now: new Date().toISOString() }).changes;
    return changes > 0;
  }

  /**
   * Expire every still-pending approval for a session. Used when the approval
   * can't be delivered, and when a session is stopped or reactivated — so a
   * stale 'pending' row never wedges the session (hasPendingApproval) or lets an
   * abandoned action re-drive later.
   */
  expirePendingApprovals(sessionId: string): number {
    return this.db
      .query(
        `UPDATE approvals SET decision = 'expired', decided_at = $now
         WHERE session_id = $sid AND decision = 'pending'`,
      )
      .run({ sid: sessionId, now: new Date().toISOString() }).changes;
  }
}

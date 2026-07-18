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
  /** Per-thread cost ceiling in USD (M3); null = use the daemon-wide default. */
  budget_limit_usd: number | null;
  /**
   * Harness capability state (M3.5). model/effort are opaque tokens (null = fall
   * back to the daemon-wide default); subagents/workflows are 0/1 flags gating
   * the multi-agent tools (default 0 — architect opt-in, Tier B).
   */
  model: string | null;
  effort: string | null;
  subagents: number;
  workflows: number;
  created_at: string;
  last_active_at: string;
}

export class ConflictError extends Error {}

/** A repo as read back from the store (M3 adds test/land/deploy + cost cap). */
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
  /** Per-repo default model/effort tokens (M3.5); null = daemon-wide default. */
  default_model: string | null;
  default_effort: string | null;
  /** Trust flag (M3.5 Tier C): 1 loads project config/skills/MCP; 0 stays isolated. */
  trusted: number;
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

export class Store {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("PRAGMA journal_mode = WAL;");
    this.db.run("PRAGMA foreign_keys = ON;");
    this.db.run("PRAGMA busy_timeout = 5000;"); // fail slow, not sporadically, if a second process appears
    this.migrate();
  }

  private migrate(): void {
    this.db.run(`
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

    // Idempotent column adds for DBs created by an earlier milestone (the M1
    // approvals table predates tool_use_id). CREATE TABLE IF NOT EXISTS never
    // alters an existing table, so evolve columns explicitly, then build any
    // index that references them.
    this.ensureColumn("approvals", "tool_use_id", "TEXT");
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_approvals_tooluse ON approvals (session_id, tool_use_id);`,
    );

    // M3: per-repo test command + cost cap, and a per-session cost ceiling.
    // (deploy_cmd/land_cmd already exist from the M1 repos schema above.)
    this.ensureColumn("repos", "test_cmd", "TEXT");
    this.ensureColumn("repos", "cost_cap_usd", "REAL");
    this.ensureColumn("sessions", "budget_limit_usd", "REAL");

    // M3.5: per-session harness capability state + per-repo defaults/trust. NOT
    // NULL flags carry a DEFAULT so pre-M3.5 rows migrate cleanly (subagents/
    // workflows/trusted default off — the conservative posture).
    this.ensureColumn("sessions", "model", "TEXT");
    this.ensureColumn("sessions", "effort", "TEXT");
    this.ensureColumn("sessions", "subagents", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("sessions", "workflows", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("repos", "default_model", "TEXT");
    this.ensureColumn("repos", "default_effort", "TEXT");
    this.ensureColumn("repos", "trusted", "INTEGER NOT NULL DEFAULT 0");
  }

  private ensureColumn(table: string, column: string, ddl: string): void {
    const cols = this.db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all();
    if (!cols.some((c) => c.name === column)) {
      this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
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
  }): void {
    this.db
      .query(
        `INSERT INTO repos
           (id, name, path, default_branch, safe_bash_allowlist,
            test_cmd, land_cmd, deploy_cmd, cost_cap_usd,
            default_model, default_effort, trusted)
         VALUES ($id, $name, $path, $branch, $allow, $test, $land, $deploy, $cap,
                 $model, $effort, $trusted)
         ON CONFLICT(name) DO UPDATE SET
           path = $path, default_branch = $branch, safe_bash_allowlist = $allow,
           test_cmd = $test, land_cmd = $land, deploy_cmd = $deploy, cost_cap_usd = $cap,
           default_model = $model, default_effort = $effort, trusted = $trusted`,
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
      });
  }

  getRepo(name: string): RepoRow | null {
    const row = this.db
      .query<RawRepoRow, { name: string }>(
        `SELECT id, name, path, default_branch, safe_bash_allowlist,
                test_cmd, land_cmd, deploy_cmd, cost_cap_usd,
                default_model, default_effort, trusted
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
      "created_at" | "last_active_at" | "budget_limit_usd" | "model" | "effort" | "subagents" | "workflows"
    > & {
      budget_limit_usd?: number | null;
      model?: string | null;
      effort?: string | null;
      subagents?: number;
      workflows?: number;
    },
  ): SessionRow {
    const now = new Date().toISOString();
    const budget = s.budget_limit_usd ?? null;
    const model = s.model ?? null;
    const effort = s.effort ?? null;
    const subagents = s.subagents ?? 0;
    const workflows = s.workflows ?? 0;
    try {
      this.db
        .query(
          `INSERT INTO sessions
             (id, surface_id, conversation_id, channel_id, repo_id, worktree_path,
              harness_id, harness_session_handle, branch, status, budget_limit_usd,
              model, effort, subagents, workflows, created_at, last_active_at)
           VALUES ($id, $surface_id, $conversation_id, $channel_id, $repo_id, $worktree_path,
                   $harness_id, $handle, $branch, $status, $budget,
                   $model, $effort, $subagents, $workflows, $now, $now)`,
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

  /** Raise/lower a session's cost ceiling (architect `@Conduit budget`, M3). */
  setSessionBudgetLimit(id: string, usd: number): void {
    this.db.query(`UPDATE sessions SET budget_limit_usd = $usd WHERE id = $id`).run({ id, usd });
  }

  /** Set a session's model token (M3.5, `@Conduit model`). null = daemon default. */
  setSessionModel(id: string, model: string | null): void {
    this.db.query(`UPDATE sessions SET model = $model WHERE id = $id`).run({ id, model });
  }

  /** Set a session's effort token (M3.5, `@Conduit effort`). null = daemon default. */
  setSessionEffort(id: string, effort: string | null): void {
    this.db.query(`UPDATE sessions SET effort = $effort WHERE id = $id`).run({ id, effort });
  }

  /** Toggle a session's subagent tools (M3.5 Tier B, `@Conduit subagents`). */
  setSessionSubagents(id: string, on: boolean): void {
    this.db.query(`UPDATE sessions SET subagents = $v WHERE id = $id`).run({ id, v: on ? 1 : 0 });
  }

  /** Toggle a session's Workflow tool (M3.5 Tier B, part of the `ultra` preset). */
  setSessionWorkflows(id: string, on: boolean): void {
    this.db.query(`UPDATE sessions SET workflows = $v WHERE id = $id`).run({ id, v: on ? 1 : 0 });
  }

  /**
   * Cumulative spend for a session in USD (M3 runaway cap, DESIGN §4). Sums the
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

  /** Upsert a role mapping. scope is a channel_id or '*' (all channels). */
  setRole(principal: string, role: Role, scope = "*"): void {
    this.db
      .query(
        `INSERT INTO roles (principal, scope, role) VALUES ($p, $s, $r)
         ON CONFLICT(principal, scope) DO UPDATE SET role = $r`,
      )
      .run({ p: principal, s: scope, r: role });
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
   * Remove all role mappings. Config is the source of truth for roles in M2, so
   * the daemon clears and re-seeds at boot — removing a principal from config
   * must actually revoke their authority, not leave a stale row behind.
   */
  clearRoles(): void {
    this.db.run(`DELETE FROM roles`);
  }

  // -- approvals ------------------------------------------------------------

  createApproval(a: {
    id: string;
    sessionId: string;
    toolUseId: string | null;
    toolName: string;
    toolInput: unknown;
  }): void {
    this.db
      .query(
        `INSERT INTO approvals (id, session_id, tool_use_id, tool_name, tool_input, requested_at, decision)
         VALUES ($id, $sid, $tuid, $name, $input, $now, 'pending')`,
      )
      .run({
        id: a.id,
        sid: a.sessionId,
        tuid: a.toolUseId,
        name: a.toolName,
        input: JSON.stringify(a.toolInput ?? {}),
        now: new Date().toISOString(),
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

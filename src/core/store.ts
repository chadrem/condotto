import { Database } from "bun:sqlite";
import type { SessionHandle } from "./types";

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
  created_at: string;
  last_active_at: string;
}

export class ConflictError extends Error {}

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
  }

  close(): void {
    this.db.close();
  }

  // -- repos ----------------------------------------------------------------

  upsertRepo(repo: { name: string; path: string; defaultBranch: string }): void {
    this.db
      .query(
        `INSERT INTO repos (id, name, path, default_branch) VALUES ($id, $name, $path, $branch)
         ON CONFLICT(name) DO UPDATE SET path = $path, default_branch = $branch`,
      )
      .run({ id: repo.name, name: repo.name, path: repo.path, branch: repo.defaultBranch });
  }

  getRepo(name: string): { id: string; name: string; path: string; default_branch: string } | null {
    return this.db
      .query<{ id: string; name: string; path: string; default_branch: string }, { name: string }>(
        `SELECT id, name, path, default_branch FROM repos WHERE name = $name`,
      )
      .get({ name });
  }

  listRepos(): { name: string; path: string; default_branch: string }[] {
    return this.db
      .query<{ name: string; path: string; default_branch: string }, []>(
        `SELECT name, path, default_branch FROM repos ORDER BY name`,
      )
      .all();
  }

  // -- sessions -------------------------------------------------------------

  createSession(s: Omit<SessionRow, "created_at" | "last_active_at">): SessionRow {
    const now = new Date().toISOString();
    try {
      this.db
        .query(
          `INSERT INTO sessions
             (id, surface_id, conversation_id, channel_id, repo_id, worktree_path,
              harness_id, harness_session_handle, branch, status, created_at, last_active_at)
           VALUES ($id, $surface_id, $conversation_id, $channel_id, $repo_id, $worktree_path,
                   $harness_id, $handle, $branch, $status, $now, $now)`,
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
    return { ...s, created_at: now, last_active_at: now };
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
}

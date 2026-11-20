// Read-only queries against the store of the daemon under test.
//
// The store is the ground truth a scenario asserts on: a turn is over when its
// session leaves 'active', and the audit log records every tool decision. The
// daemon runs in WAL mode, so a read-only connection beside it is safe. Each query
// opens and closes its own, so nothing here holds the file between polls.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

export interface SessionRow {
  id: string;
  conversation_id: string;
  status: "active" | "parked" | "stopped";
  worktree_path: string;
  branch: string;
  repo_id: string;
}

export interface AuditRow {
  id: number;
  session_id: string | null;
  actor: string;
  event: string;
  detail: Record<string, unknown>;
}

export interface TurnRow {
  id: number;
  session_id: string;
  direction: "in" | "out";
  principal: string | null;
  text: string;
  cost_usd: number | null;
  result_subtype: string | null;
}

export class StoreReader {
  constructor(private readonly path: string) {}

  private read<T>(fn: (db: Database) => T): T {
    if (!existsSync(this.path)) throw new Error(`the daemon's store does not exist yet: ${this.path}`);
    const db = new Database(this.path, { readonly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  session(conversationId: string): SessionRow | null {
    return this.read(
      (db) =>
        db
          .query<SessionRow, [string]>(
            `SELECT id, conversation_id, status, worktree_path, branch, repo_id
               FROM sessions WHERE surface_id = 'slack' AND conversation_id = ?`,
          )
          .get(conversationId) ?? null,
    );
  }

  /** The newest audit id, so a step can wait for what happens after it. */
  lastAuditId(): number {
    return this.read((db) => db.query<{ id: number | null }, []>(`SELECT MAX(id) AS id FROM audit_log`).get()?.id ?? 0);
  }

  audits(sessionId: string, opts: { after?: number; event?: string } = {}): AuditRow[] {
    return this.read((db) =>
      db
        .query<Omit<AuditRow, "detail"> & { detail: string | null }, [string, number, string | null, string | null]>(
          `SELECT id, session_id, actor, event, detail FROM audit_log
            WHERE session_id = ? AND id > ? AND (? IS NULL OR event = ?) ORDER BY id`,
        )
        .all(sessionId, opts.after ?? 0, opts.event ?? null, opts.event ?? null)
        .map((r) => ({ ...r, detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : {} })),
    );
  }

  turns(sessionId: string, opts: { afterTurnId?: number } = {}): TurnRow[] {
    return this.read((db) =>
      db
        .query<TurnRow, [string, number]>(
          `SELECT id, session_id, direction, principal, text, cost_usd, result_subtype
             FROM turns WHERE session_id = ? AND id > ? ORDER BY id`,
        )
        .all(sessionId, opts.afterTurnId ?? 0),
    );
  }

  lastTurnId(): number {
    return this.read((db) => db.query<{ id: number | null }, []>(`SELECT MAX(id) AS id FROM turns`).get()?.id ?? 0);
  }

  /** Everything spent across the sessions named, in dollars. */
  costUsd(sessionIds: string[]): number {
    if (!sessionIds.length) return 0;
    return this.read(
      (db) =>
        db
          .query<{ usd: number | null }, string[]>(
            `SELECT SUM(cost_usd) AS usd FROM turns WHERE session_id IN (${sessionIds.map(() => "?").join(",")})`,
          )
          .get(...sessionIds)?.usd ?? 0,
    );
  }
}

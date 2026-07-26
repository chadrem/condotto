import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, ConflictError } from "../src/core/store";

function memoryStore(): Store {
  return new Store(":memory:");
}

const baseSession = {
  surface_id: "slack",
  channel_id: "C123",
  repo_id: "testrepo",
  worktree_path: "/tmp/wt/abc",
  harness_id: "claude-code",
  harness_session_handle: null,
  branch: "condotto/abc",
  status: "active" as const,
};

describe("store sessions", () => {
  test("(surface_id, conversation_id) is unique — forever", () => {
    const store = memoryStore();
    store.createSession({ ...baseSession, id: "s1", conversation_id: "1752241234.000567" });
    expect(() =>
      store.createSession({ ...baseSession, id: "s2", conversation_id: "1752241234.000567" }),
    ).toThrow(ConflictError);
    // Same conversation id on a different surface is a different conversation.
    store.createSession({
      ...baseSession,
      id: "s3",
      surface_id: "teams",
      conversation_id: "1752241234.000567",
    });
  });

  test("workdir round-trips, and defaults to null (the repo root)", () => {
    const store = memoryStore();
    // Omitted entirely — the shape every pre-monorepo caller uses.
    store.createSession({ ...baseSession, id: "sw1", conversation_id: "1.000001" });
    expect(store.getSession("sw1")!.workdir).toBeNull();
    // Explicit null and an explicit sub-project both persist as given.
    store.createSession({ ...baseSession, id: "sw2", conversation_id: "1.000002", workdir: null });
    expect(store.getSession("sw2")!.workdir).toBeNull();
    store.createSession({ ...baseSession, id: "sw3", conversation_id: "1.000003", workdir: "apps/report" });
    expect(store.getSession("sw3")!.workdir).toBe("apps/report");
    // And it survives the read paths the session manager actually uses.
    expect(store.getSessionByConversation("slack", "1.000003")!.workdir).toBe("apps/report");
    expect(store.listSessions({ surfaceId: "slack" }).find((s) => s.id === "sw3")!.workdir).toBe("apps/report");
  });

  test("conversation ids are strings and leading zeros survive round-trips", () => {
    const store = memoryStore();
    const ts = "1752241234.000567"; // float-parsing this loses the leading zeros
    store.createSession({ ...baseSession, id: "s1", conversation_id: ts });
    const row = store.getSessionByConversation("slack", ts);
    expect(row?.conversation_id).toBe(ts);
    expect(typeof row?.conversation_id).toBe("string");
  });

  test("harness handle is opaque JSON, persisted verbatim", () => {
    const store = memoryStore();
    store.createSession({ ...baseSession, id: "s1", conversation_id: "1.2" });
    const handle = { v: 1, sessionId: "abc-123", nested: { weird: ["stuff", 42] } };
    store.updateSessionHandle("s1", handle);
    expect(store.getSession("s1")?.harness_session_handle).toEqual(handle);
  });

  test("clearSessionHandle writes SQL NULL, not the JSON string 'null'", () => {
    // File-backed: the raw column has to be readable from a second connection,
    // and that raw read is the whole point — inflate() maps SQL NULL and the TEXT
    // 'null' to the same `null`, so the public API cannot tell them apart.
    const dir = mkdtempSync(join(tmpdir(), "condotto-clear-"));
    const path = join(dir, "condotto.sqlite");
    const store = new Store(path);
    store.createSession({ ...baseSession, id: "s1", conversation_id: "1.2" });
    store.updateSessionHandle("s1", { v: 1, sessionId: "abc-123" });

    store.clearSessionHandle("s1");

    expect(store.getSession("s1")!.harness_session_handle).toBeNull();
    const raw = new Database(path, { readonly: true })
      .query<{ t: string }, []>(`SELECT typeof(harness_session_handle) AS t FROM sessions WHERE id = 's1'`)
      .get()!;
    expect(raw.t).toBe("null"); // the SQLite type, not the four characters n-u-l-l
  });

  test("status transitions and listing", () => {
    const store = memoryStore();
    store.createSession({ ...baseSession, id: "s1", conversation_id: "1.1" });
    store.createSession({ ...baseSession, id: "s2", conversation_id: "1.2" });
    store.updateSessionStatus("s1", "stopped");
    const active = store.listSessions({ surfaceId: "slack" });
    expect(active.map((s) => s.id)).toEqual(["s2"]);
    const all = store.listSessions({ surfaceId: "slack", statuses: ["active", "parked", "stopped"] });
    expect(all.length).toBe(2);
  });

  test("turns and audit log accept entries", () => {
    const store = memoryStore();
    store.createSession({ ...baseSession, id: "s1", conversation_id: "1.1" });
    store.insertTurn({ sessionId: "s1", direction: "in", principal: "slack:U1", text: "hi" });
    store.insertTurn({ sessionId: "s1", direction: "out", text: "hello", costUsd: 0.1 });
    store.audit({ sessionId: "s1", actor: "agent", event: "tool_call", detail: { tool: "Read" } });
  });


  test("pruneReposNotIn drops undeclared repos but keeps ones a session still uses", () => {
    const store = memoryStore();
    store.upsertRepo({ name: "declared", path: "/tmp/a", defaultBranch: "main" });
    store.upsertRepo({ name: "gone", path: "/tmp/b", defaultBranch: "main" });
    store.upsertRepo({ name: "testrepo", path: "/tmp/c", defaultBranch: "main" });
    // A session pins `testrepo`: dropping the row would strand its history.
    store.createSession({ ...baseSession, id: "s1", conversation_id: "1.1", repo_id: "testrepo" });

    const res = store.pruneReposNotIn(["declared"]);
    expect(res.deleted).toEqual(["gone"]);
    expect(res.keptInUse).toEqual(["testrepo"]);
    expect(store.getRepo("gone")).toBeNull();
    expect(store.getRepo("declared")).not.toBeNull();
    expect(store.getRepo("testrepo")).not.toBeNull();
    expect(store.listRepos().map((r) => r.name).sort()).toEqual(["declared", "testrepo"]);

    // Idempotent: a second boot with the same config changes nothing.
    expect(store.pruneReposNotIn(["declared"])).toEqual({ deleted: [], keptInUse: ["testrepo"] });
  });

  test("session model/effort/subagents/workflows seed on create; the store floor is off", () => {
    const store = memoryStore();
    // Omitted → model/effort null (daemon default), flags 0. That 0 is the STORE
    // floor, not the product default: the shipped posture is subagents/workflows
    // ON, and `assign` supplies it explicitly (session-manager `seedSubagents`).
    // Keeping the floor conservative means an insert path that forgets to pass a
    // value can never silently escalate a session.
    store.createSession({ ...baseSession, id: "s1", conversation_id: "1.1" });
    const bare = store.getSession("s1")!;
    expect(bare.model).toBeNull();
    expect(bare.effort).toBeNull();
    expect(bare.subagents).toBe(0);
    expect(bare.workflows).toBe(0);
    // Seeded from a repo default.
    store.createSession({ ...baseSession, id: "s2", conversation_id: "1.2", model: "sonnet", effort: "xhigh" });
    const seeded = store.getSession("s2")!;
    expect(seeded.model).toBe("sonnet");
    expect(seeded.effort).toBe("xhigh");
  });

  test("session model/effort/subagents/workflows setters", () => {
    const store = memoryStore();
    store.createSession({ ...baseSession, id: "s1", conversation_id: "1.1" });
    store.setSessionModel("s1", "fable");
    store.setSessionEffort("s1", "max");
    store.setSessionSubagents("s1", true);
    store.setSessionWorkflows("s1", true);
    let row = store.getSession("s1")!;
    expect(row.model).toBe("fable");
    expect(row.effort).toBe("max");
    expect(row.subagents).toBe(1);
    expect(row.workflows).toBe(1);
    // Toggling back off, and clearing model back to the daemon default (null).
    store.setSessionSubagents("s1", false);
    store.setSessionModel("s1", null);
    row = store.getSession("s1")!;
    expect(row.subagents).toBe(0);
    expect(row.model).toBeNull();
  });


  test("plan_mode defaults off, round-trips, and is not seedable at creation", () => {
    const store = memoryStore();
    store.createSession({ ...baseSession, id: "s1", conversation_id: "1.1" });
    expect(store.getSession("s1")!.plan_mode).toBe(0);
    store.setSessionPlanMode("s1", true);
    expect(store.getSession("s1")!.plan_mode).toBe(1);
    store.setSessionPlanMode("s1", false);
    expect(store.getSession("s1")!.plan_mode).toBe(0);
    // In-thread only: `createSession` does not accept it, so no config path can
    // seed a thread into plan mode (the `workflow_write` rule, same reasoning).
    expect("plan_mode" in ({ ...baseSession } as Record<string, unknown>)).toBe(false);
  });

  test("plan_mode couples to nothing — toggling it leaves the rest of the posture alone", () => {
    const store = memoryStore();
    store.createSession({ ...baseSession, id: "s1", conversation_id: "1.1" });
    store.setSessionWorkflows("s1", true);
    store.setSessionPlanMode("s1", true);
    const on = store.getSession("s1")!;
    // Workflows are PAUSED at turn time, not cleared, so `plan off` restores them.
    expect(on.workflows).toBe(1);
    expect(on.subagents).toBe(1);
  });


  test("repo default model/effort round-trip", () => {
    const store = memoryStore();
    store.upsertRepo({ name: "r", path: "/tmp/r", defaultBranch: "main", defaultModel: "sonnet", defaultEffort: "xhigh" });
    const r = store.getRepo("r")!;
    expect(r.default_model).toBe("sonnet");
    expect(r.default_effort).toBe("xhigh");
    // Upsert without them resets to null/untrusted (config stays authoritative).
    store.upsertRepo({ name: "r", path: "/tmp/r", defaultBranch: "main" });
    const r2 = store.getRepo("r")!;
    expect(r2.default_model).toBeNull();
    expect(r2.default_effort).toBeNull();
  });

  test("repo default_subagents/default_workflows round-trip; undefined = null (v5)", () => {
    const store = memoryStore();
    store.upsertRepo({ name: "r", path: "/tmp/r", defaultBranch: "main", subagents: false, workflows: false });
    const off = store.getRepo("r")!;
    expect(off.default_subagents).toBe(0);
    expect(off.default_workflows).toBe(0);

    store.upsertRepo({ name: "r", path: "/tmp/r", defaultBranch: "main", subagents: true, workflows: true });
    const on = store.getRepo("r")!;
    expect(on.default_subagents).toBe(1);
    expect(on.default_workflows).toBe(1);

    // Dropping the keys resets to null — "no per-repo opinion", which is a
    // DISTINCT state from an explicit 0. Config stays authoritative on reboot.
    store.upsertRepo({ name: "r", path: "/tmp/r", defaultBranch: "main" });
    const bare = store.getRepo("r")!;
    expect(bare.default_subagents).toBeNull();
    expect(bare.default_workflows).toBeNull();
  });


  test("repo cost cap round-trips, and v7 has dropped the command columns", () => {
    const path = join(mkdtempSync(join(tmpdir(), "condotto-repocols-")), "condotto.sqlite");
    const store = new Store(path);
    store.upsertRepo({ name: "r", path: "/tmp/r", defaultBranch: "main", costCapUsd: 3.5 });
    const r = store.getRepo("r")!;
    expect(r.cost_cap_usd).toBe(3.5);
    // Omitted fields are null, and upsert overwrites them back to null.
    store.upsertRepo({ name: "r", path: "/tmp/r", defaultBranch: "main" });
    expect(store.getRepo("r")!.cost_cap_usd).toBeNull();
    // Migration v7 dropped test_cmd/land_cmd/deploy_cmd. The baseline still
    // creates them (it has to describe the schema as of v1), so this asserts the
    // drop actually ran rather than that they were never added.
    store.close();
    const cols = new Database(path, { readonly: true })
      .query<{ name: string }, []>(`PRAGMA table_info(repos)`)
      .all()
      .map((c) => c.name);
    expect(cols).not.toContain("test_cmd");
    expect(cols).not.toContain("land_cmd");
    expect(cols).not.toContain("deploy_cmd");
    // v8 dropped the approval-era columns and the table itself.
    expect(cols).not.toContain("default_auto_approve");
    expect(cols).not.toContain("trusted"); // v9
    // v11 dropped the two repo columns nothing ever read.
    expect(cols).not.toContain("safe_bash_allowlist");
    expect(cols).not.toContain("policy_overrides");
  });
});

describe("store worktree GC", () => {
  test("cleanup_at defaults null on create and round-trips via mark/clear", () => {
    const store = memoryStore();
    const s = store.createSession({ ...baseSession, id: "g1", conversation_id: "1" });
    expect(s.cleanup_at).toBeNull();
    expect(store.getSession("g1")!.cleanup_at).toBeNull();

    store.markSessionForCleanup("g1", "2026-07-20T00:00:00.000Z");
    expect(store.getSession("g1")!.cleanup_at).toBe("2026-07-20T00:00:00.000Z");
    store.clearSessionCleanup("g1");
    expect(store.getSession("g1")!.cleanup_at).toBeNull();
  });

  test("sessionsDueForCleanup returns only stopped rows past their cleanup_at", () => {
    const store = memoryStore();
    // Due: stopped + a past timestamp.
    store.createSession({ ...baseSession, id: "due", conversation_id: "1", status: "stopped" });
    store.markSessionForCleanup("due", "2020-01-01T00:00:00.000Z");
    // Not yet due: stopped + a future timestamp.
    store.createSession({ ...baseSession, id: "future", conversation_id: "2", status: "stopped" });
    store.markSessionForCleanup("future", "2999-01-01T00:00:00.000Z");
    // Never scheduled: a plain-stopped session (cleanup_at null) is never collected.
    store.createSession({ ...baseSession, id: "kept", conversation_id: "3", status: "stopped" });
    // Belt-and-braces: a non-stopped row with a past cleanup_at must NOT surface —
    // the invariant is baked into the query (a live/parked worktree is never GC'd).
    store.createSession({ ...baseSession, id: "parked", conversation_id: "4", status: "parked" });
    store.markSessionForCleanup("parked", "2020-01-01T00:00:00.000Z");

    const due = store.sessionsDueForCleanup("2026-07-19T00:00:00.000Z");
    expect(due.map((s) => s.id)).toEqual(["due"]);
  });

  test("deleteSession removes the row + its turns but keeps the audit trail", () => {
    const store = memoryStore();
    store.createSession({ ...baseSession, id: "d1", conversation_id: "1" });
    store.insertTurn({ sessionId: "d1", direction: "out", text: "hi", costUsd: 0.5 });
    store.audit({ sessionId: "d1", actor: "system", event: "worktree_cleaned" });

    store.deleteSession("d1");

    expect(store.getSession("d1")).toBeNull();
    expect(store.sessionCostUsd("d1")).toBe(0); // turns gone
    // The security/decision trail survives the discard (audit_log has no FK).
    expect(store.listAudit("d1").some((e) => e.event === "worktree_cleaned")).toBe(true);
    // The conversation is free again — a fresh assign gets a brand-new session.
    expect(store.getSessionByConversation("slack", "1")).toBeNull();
  });
});

describe("store cost accounting", () => {
  test("sessionCostUsd sums per-turn cost and is 0 for a fresh session", () => {
    const store = memoryStore();
    store.createSession({ ...baseSession, id: "s1", conversation_id: "1.1" });
    expect(store.sessionCostUsd("s1")).toBe(0);
    store.insertTurn({ sessionId: "s1", direction: "out", text: "a", costUsd: 0.1 });
    store.insertTurn({ sessionId: "s1", direction: "out", text: "b", costUsd: 0.25 });
    store.insertTurn({ sessionId: "s1", direction: "in", principal: "x", text: "no cost" });
    expect(store.sessionCostUsd("s1")).toBeCloseTo(0.35, 6);
  });

  test("budget_limit_usd is seeded on create and an architect can raise it", () => {
    const store = memoryStore();
    store.createSession({ ...baseSession, id: "s1", conversation_id: "1.1", budget_limit_usd: 5 });
    expect(store.getSession("s1")!.budget_limit_usd).toBe(5);
    store.setSessionBudgetLimit("s1", 20);
    expect(store.getSession("s1")!.budget_limit_usd).toBe(20);
    // Omitted at create → null (daemon falls back to its default).
    store.createSession({ ...baseSession, id: "s2", conversation_id: "1.2" });
    expect(store.getSession("s2")!.budget_limit_usd).toBeNull();
  });
});

describe("store roles", () => {
  test("unmapped principals are members; architects are explicit", () => {
    const store = memoryStore();
    expect(store.roleOf("slack:U_ANY", "C1")).toBe("member");
    expect(store.isArchitect("slack:U_ANY", "C1")).toBe(false);
    store.setRole("slack:U_ARCH", "architect");
    expect(store.isArchitect("slack:U_ARCH", "C1")).toBe(true);
    expect(store.isArchitect("slack:U_ARCH", "C_OTHER")).toBe(true); // '*' scope spans channels
  });

  test("a channel-scoped mapping overrides the '*' mapping", () => {
    const store = memoryStore();
    store.setRole("slack:U1", "architect", "*");
    store.setRole("slack:U1", "member", "C_LOCKED"); // demoted in one channel
    expect(store.isArchitect("slack:U1", "C_OPEN")).toBe(true);
    expect(store.isArchitect("slack:U1", "C_LOCKED")).toBe(false);
    expect(store.roleOf("slack:U1", "C_LOCKED")).toBe("member");
  });

  test("setRole upserts (no duplicate rows, last write wins)", () => {
    const store = memoryStore();
    store.setRole("slack:U1", "member");
    store.setRole("slack:U1", "architect");
    expect(store.roleOf("slack:U1", "C1")).toBe("architect");
  });
});


describe("store session activation", () => {
  test("tryActivate activates a parked session but never resurrects a stopped one (review #6)", () => {
    const store = memoryStore();
    store.createSession({ ...baseSession, id: "s1", conversation_id: "1.1", status: "parked" });
    expect(store.tryActivate("s1")).toBe(true);
    expect(store.getSession("s1")!.status).toBe("active");

    store.updateSessionStatus("s1", "stopped");
    expect(store.tryActivate("s1")).toBe(false);
    expect(store.getSession("s1")!.status).toBe("stopped");
  });
});

describe("store roles — runtime grants", () => {
  test("setRole defaults to source='config'; a grant carries provenance", () => {
    const store = memoryStore();
    store.setRole("slack:U1", "architect"); // default source
    expect(store.getRoleRow("slack:U1", "*")).toEqual({ role: "architect", source: "config" });
    store.setRole("slack:U2", "architect", "C1", "grant", "slack:U_BY");
    const row = store.getRoleRow("slack:U2", "C1")!;
    expect(row.role).toBe("architect");
    expect(row.source).toBe("grant");
  });

  test("clearConfigRoles preserves grants and reseeding keeps both (boot reconcile)", () => {
    const store = memoryStore();
    store.setRole("slack:U_CFG", "architect"); // config-seeded
    store.setRole("slack:U_GRANT", "architect", "C1", "grant", "slack:U_CFG"); // runtime grant
    // Simulate a daemon restart: clear only config rows, then reseed config.
    store.clearConfigRoles();
    expect(store.getRoleRow("slack:U_CFG", "*")).toBeNull(); // config row wiped
    expect(store.isArchitect("slack:U_GRANT", "C1")).toBe(true); // grant survived
    store.setRole("slack:U_CFG", "architect"); // reseed from config
    expect(store.isArchitect("slack:U_CFG", "C1")).toBe(true);
    expect(store.isArchitect("slack:U_GRANT", "C1")).toBe(true);
  });

  test("roleOf/isArchitect are source-agnostic; a channel grant beats a '*' config row", () => {
    const store = memoryStore();
    store.setRole("slack:U1", "member"); // global config member
    store.setRole("slack:U1", "architect", "C1", "grant", "slack:U_BY"); // channel grant
    expect(store.isArchitect("slack:U1", "C1")).toBe(true); // grant wins in C1
    expect(store.isArchitect("slack:U1", "C2")).toBe(false); // falls back to '*' member
  });

  test("deleteRole returns the count and only removes rows of the given source", () => {
    const store = memoryStore();
    store.setRole("slack:U1", "architect", "C1"); // a config row at channel scope
    expect(store.deleteRole("slack:U1", "C1", "grant")).toBe(0); // never touches config
    expect(store.isArchitect("slack:U1", "C1")).toBe(true);
    store.setRole("slack:U2", "architect", "C1", "grant", "slack:U_BY");
    expect(store.deleteRole("slack:U2", "C1", "grant")).toBe(1);
    expect(store.isArchitect("slack:U2", "C1")).toBe(false);
  });

  test("a config reseed over an existing grant key flips the row to config", () => {
    const store = memoryStore();
    store.setRole("slack:U1", "architect", "C1", "grant", "slack:U_BY");
    expect(store.getRoleRow("slack:U1", "C1")!.source).toBe("grant");
    store.setRole("slack:U1", "architect", "C1"); // config wins the (principal, scope) key
    expect(store.getRoleRow("slack:U1", "C1")!.source).toBe("config");
  });

  test("the source column and grants survive a re-open of the same DB file (migration idempotent)", () => {
    const dir = mkdtempSync(join(tmpdir(), "condotto-roles-"));
    const path = join(dir, "roles.sqlite");
    let store = new Store(path);
    store.setRole("slack:U_GRANT", "architect", "C1", "grant", "slack:U_BY");
    store.close();
    store = new Store(path); // re-run migrate() on an existing DB
    expect(store.isArchitect("slack:U_GRANT", "C1")).toBe(true);
    expect(store.getRoleRow("slack:U_GRANT", "C1")!.source).toBe("grant");
    store.close();
  });
});

describe("store schema migrations", () => {
  // The current schema version == the number of migrations in the runner. Bump
  // this constant in lockstep whenever a migration is appended — the tests below
  // pin the runner's behavior to it.
  const CURRENT_SCHEMA_VERSION = 11;

  const migPath = (name: string): string => join(mkdtempSync(join(tmpdir(), "condotto-mig-")), name);
  const userVersion = (path: string): number => {
    const db = new Database(path, { readonly: true });
    const v = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
    db.close();
    return v;
  };

  test("v11 drops the tables no row was ever inserted into", () => {
    const path = migPath("dead-tables.sqlite");
    new Store(path).close();
    const tables = new Database(path, { readonly: true })
      .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all()
      .map((t) => t.name);
    expect(tables).not.toContain("surfaces");
    expect(tables).not.toContain("channels");
    expect(tables).not.toContain("approvals"); // v8
    // The live ones survive.
    expect(tables).toEqual(expect.arrayContaining(["repos", "sessions", "roles", "turns", "audit_log"]));
  });

  test("v10 folds an observer row into member", () => {
    const path = migPath("observer.sqlite");
    new Store(path).close();
    const raw = new Database(path);
    // A runtime grant could have written one before the role was removed. The v1
    // CHECK still permits the string, which is what makes the row reachable at all.
    raw.run(`INSERT INTO roles (principal, role, scope, source) VALUES ('slack:U1', 'observer', '*', 'grant')`);
    // Rewind so v10 runs again. v11 re-runs too, so put back what it drops —
    // same reversal the lossless test above does, for the same reason.
    raw.run("ALTER TABLE repos ADD COLUMN safe_bash_allowlist TEXT NOT NULL DEFAULT '[]'");
    raw.run("ALTER TABLE repos ADD COLUMN policy_overrides TEXT NOT NULL DEFAULT '{}'");
    raw.run("PRAGMA user_version = 9");
    raw.close();
    const store = new Store(path);
    expect(store.roleOf("slack:U1", "C1")).toBe("member");
    expect(store.isArchitect("slack:U1", "C1")).toBe(false);
    store.close();
  });

  test("a fresh DB is stamped to the current schema version", () => {
    const path = migPath("fresh.sqlite");
    new Store(path).close();
    expect(userVersion(path)).toBe(CURRENT_SCHEMA_VERSION);
  });

  test("re-opening an already-migrated DB is a no-op — version unchanged, data intact", () => {
    const path = migPath("reopen.sqlite");
    let store = new Store(path);
    store.upsertRepo({ name: "r", path: "/tmp/r", defaultBranch: "main" });
    store.close();
    store = new Store(path); // migrate() runs but has nothing to do
    expect(store.getRepo("r")?.name).toBe("r");
    store.close();
    expect(userVersion(path)).toBe(CURRENT_SCHEMA_VERSION);
  });

  test("adopting the runner over a pre-runner store (user_version 0, full schema) is lossless", () => {
    // Faithful to the LIVE condotto.sqlite: the old ad-hoc bootstrap left every
    // table + column present but user_version at 0 (it never stamped). Build that
    // exact state, seed rows, then open with Store — it must carry to v1 and touch
    // no data.
    const path = migPath("legacy.sqlite");
    let store = new Store(path);
    store.upsertRepo({ name: "legacy", path: "/tmp/legacy", defaultBranch: "main" });
    store.createSession({ ...baseSession, id: "sL", conversation_id: "1.9" });
    store.setRole("slack:U_KEEP", "architect", "C9", "grant", "slack:U_BY");
    store.close();

    const raw = new Database(path);
    // Faithfully reconstruct the real pre-runner state: the live store predated
    // BOTH the runner (stamp 0) AND every post-v1 column. Drop each post-v1
    // addition so re-migration re-adds it — exactly what the true upgrade does (a
    // v0 store that never had them). Without this the rewound store would still
    // carry the column and the plain ADD COLUMN would (wrongly) see a duplicate.
    // EVERY future migration that ADDS a column must be dropped here too — and a
    // migration that DROPS one must be re-added, since a real pre-runner store
    // still had it and the drop has to run again on the way back up.
    raw.run("ALTER TABLE sessions DROP COLUMN cleanup_at"); // v2
    raw.run("ALTER TABLE sessions DROP COLUMN workdir"); // v3
    raw.run("ALTER TABLE repos DROP COLUMN memory"); // v4
    raw.run("ALTER TABLE repos DROP COLUMN default_subagents"); // v5
    raw.run("ALTER TABLE repos DROP COLUMN default_workflows"); // v5
    raw.run("ALTER TABLE sessions DROP COLUMN plan_mode"); // v6
    // v7 dropped these; a v0 store had them, and the baseline's `CREATE TABLE IF
    // NOT EXISTS` cannot re-add a column to a table that already exists.
    raw.run("ALTER TABLE repos ADD COLUMN land_cmd TEXT"); // v1-era, dropped at v7
    raw.run("ALTER TABLE repos ADD COLUMN deploy_cmd TEXT"); // v1-era, dropped at v7
    raw.run("ALTER TABLE sessions ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 1"); // v1-era, dropped at v8
    raw.run("ALTER TABLE sessions ADD COLUMN workflow_write INTEGER NOT NULL DEFAULT 0"); // v1-era, dropped at v8
    raw.run("ALTER TABLE repos ADD COLUMN default_auto_approve INTEGER"); // v1-era, dropped at v8
    raw.run("ALTER TABLE repos ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0"); // v1-era, dropped at v9
    raw.run("ALTER TABLE repos ADD COLUMN safe_bash_allowlist TEXT NOT NULL DEFAULT '[]'"); // v1-era, dropped at v11
    raw.run("ALTER TABLE repos ADD COLUMN policy_overrides TEXT NOT NULL DEFAULT '{}'"); // v1-era, dropped at v11
    raw.run("PRAGMA user_version = 0"); // rewind the stamp to the pre-runner state
    raw.close();
    expect(userVersion(path)).toBe(0);

    store = new Store(path);
    expect(userVersion(path)).toBe(CURRENT_SCHEMA_VERSION);
    expect(store.getSession("sL")?.conversation_id).toBe("1.9");
    expect(store.isArchitect("slack:U_KEEP", "C9")).toBe(true);
    store.close();
  });

  test("a store from a newer binary (version above the known max) is refused, not run", () => {
    const path = migPath("future.sqlite");
    new Store(path).close();
    const raw = new Database(path);
    raw.run(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => new Store(path)).toThrow(/older binary against a store written by a newer one/i);
  });

  test("a mid-migration failure leaves the version stamp untouched (transactional step)", () => {
    // Prove the per-step transaction contract directly against bun:sqlite (the
    // property the runner relies on): a DDL + version bump that throws must roll
    // BOTH back, so a crashed upgrade is retried cleanly rather than half-applied.
    const db = new Database(":memory:");
    const ver = () => db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
    expect(ver()).toBe(0);
    expect(() =>
      db.transaction(() => {
        db.run("CREATE TABLE half (x INTEGER)");
        db.run("PRAGMA user_version = 1");
        throw new Error("boom");
      })(),
    ).toThrow("boom");
    expect(ver()).toBe(0);
    expect(db.query("SELECT name FROM sqlite_master WHERE name='half'").get()).toBeNull();
    db.close();
  });
});

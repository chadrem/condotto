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
  test("(surface_id, conversation_id) is unique — forever, per DESIGN.md §5", () => {
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

  test("repo safe_bash_allowlist round-trips", () => {
    const store = memoryStore();
    store.upsertRepo({ name: "r", path: "/tmp/r", defaultBranch: "main", safeBashAllowlist: ["git status", "ls"] });
    expect(store.getRepo("r")?.safe_bash_allowlist).toEqual(["git status", "ls"]);
    // Default when omitted is an empty allowlist (nothing auto-allowed).
    store.upsertRepo({ name: "r2", path: "/tmp/r2", defaultBranch: "main" });
    expect(store.getRepo("r2")?.safe_bash_allowlist).toEqual([]);
  });

  test("session model/effort/subagents/workflows seed on create and default off", () => {
    const store = memoryStore();
    // Omitted → model/effort null (daemon default), flags 0 (opt-in, off).
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

  test("auto_approve defaults ON and the setter round-trips", () => {
    const store = memoryStore();
    store.createSession({ ...baseSession, id: "s1", conversation_id: "1.1" });
    // On by default (matches the column DEFAULT 1 and the shipped posture).
    expect(store.getSession("s1")!.auto_approve).toBe(1);
    store.setSessionAutoApprove("s1", false);
    expect(store.getSession("s1")!.auto_approve).toBe(0);
    store.setSessionAutoApprove("s1", true);
    expect(store.getSession("s1")!.auto_approve).toBe(1);
    // An explicit seed value at creation wins over the default.
    store.createSession({ ...baseSession, id: "s2", conversation_id: "2.2", auto_approve: 0 });
    expect(store.getSession("s2")!.auto_approve).toBe(0);
  });

  test("workflow_write defaults off and turning workflows off clears it (invariant)", () => {
    const store = memoryStore();
    store.createSession({ ...baseSession, id: "s1", conversation_id: "1.1" });
    expect(store.getSession("s1")!.workflow_write).toBe(0);
    store.setSessionWorkflows("s1", true);
    store.setSessionWorkflowWrite("s1", true);
    expect(store.getSession("s1")!.workflow_write).toBe(1);
    // Turning workflows off must also clear the worktree-write opt-in.
    store.setSessionWorkflows("s1", false);
    const row = store.getSession("s1")!;
    expect(row.workflows).toBe(0);
    expect(row.workflow_write).toBe(0);
  });

  test("repo default model/effort and trust flag round-trip", () => {
    const store = memoryStore();
    store.upsertRepo({ name: "r", path: "/tmp/r", defaultBranch: "main", defaultModel: "sonnet", defaultEffort: "xhigh", trusted: true });
    const r = store.getRepo("r")!;
    expect(r.default_model).toBe("sonnet");
    expect(r.default_effort).toBe("xhigh");
    expect(r.trusted).toBe(1);
    // Upsert without them resets to null/untrusted (config stays authoritative).
    store.upsertRepo({ name: "r", path: "/tmp/r", defaultBranch: "main" });
    const r2 = store.getRepo("r")!;
    expect(r2.default_model).toBeNull();
    expect(r2.default_effort).toBeNull();
    expect(r2.trusted).toBe(0);
  });

  test("repo default_auto_approve round-trips; undefined = null", () => {
    const store = memoryStore();
    store.upsertRepo({ name: "r", path: "/tmp/r", defaultBranch: "main", autoApprove: false });
    expect(store.getRepo("r")!.default_auto_approve).toBe(0);
    store.upsertRepo({ name: "r", path: "/tmp/r", defaultBranch: "main", autoApprove: true });
    expect(store.getRepo("r")!.default_auto_approve).toBe(1);
    // Omitting it = fall back to the daemon default (null, not a pinned 0).
    store.upsertRepo({ name: "r", path: "/tmp/r", defaultBranch: "main" });
    expect(store.getRepo("r")!.default_auto_approve).toBeNull();
  });

  test("repo test/land/deploy commands and cost cap round-trip", () => {
    const store = memoryStore();
    store.upsertRepo({
      name: "r",
      path: "/tmp/r",
      defaultBranch: "main",
      testCmd: "bun test",
      landCmd: "echo land",
      deployCmd: "echo deploy",
      costCapUsd: 3.5,
    });
    const r = store.getRepo("r")!;
    expect(r.test_cmd).toBe("bun test");
    expect(r.land_cmd).toBe("echo land");
    expect(r.deploy_cmd).toBe("echo deploy");
    expect(r.cost_cap_usd).toBe(3.5);
    // Omitted fields are null, and upsert overwrites them back to null.
    store.upsertRepo({ name: "r", path: "/tmp/r", defaultBranch: "main" });
    const r2 = store.getRepo("r")!;
    expect(r2.test_cmd).toBeNull();
    expect(r2.land_cmd).toBeNull();
    expect(r2.cost_cap_usd).toBeNull();
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

  test("deleteSession removes the row + its turns/approvals but keeps the audit trail", () => {
    const store = memoryStore();
    store.createSession({ ...baseSession, id: "d1", conversation_id: "1" });
    store.insertTurn({ sessionId: "d1", direction: "out", text: "hi", costUsd: 0.5 });
    store.createApproval({ id: "ap1", sessionId: "d1", toolUseId: "t1", toolName: "Write", toolInput: {} });
    store.audit({ sessionId: "d1", actor: "system", event: "worktree_cleaned" });

    store.deleteSession("d1");

    expect(store.getSession("d1")).toBeNull();
    expect(store.getApproval("ap1")).toBeNull();
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

describe("store approvals", () => {
  function withSession(): Store {
    const store = memoryStore();
    store.createSession({ ...baseSession, id: "s1", conversation_id: "1.1" });
    return store;
  }

  test("create → lookup by id and by tool_use_id; opaque input round-trips", () => {
    const store = withSession();
    const input = { file_path: "src/x.ts", content: "hi", nested: { a: [1, 2] } };
    store.createApproval({ id: "req-1", sessionId: "s1", toolUseId: "tu-1", toolName: "Write", toolInput: input });

    const byId = store.getApproval("req-1");
    expect(byId?.decision).toBe("pending");
    expect(byId?.tool_use_id).toBe("tu-1");
    expect(byId?.tool_input).toEqual(input);

    const byTool = store.getApprovalByToolUse("s1", "tu-1");
    expect(byTool?.id).toBe("req-1");
    expect(store.getApprovalByToolUse("s1", "nope")).toBeNull();
  });

  test("createApproval persists initiated_by; default is null", () => {
    const store = withSession();
    store.createApproval({ id: "req-i", sessionId: "s1", toolUseId: "tu-1", toolName: "Write", toolInput: {}, initiatedBy: "slack:U_MEMBER" });
    expect(store.getApproval("req-i")?.initiated_by).toBe("slack:U_MEMBER");
    store.createApproval({ id: "req-n", sessionId: "s1", toolUseId: "tu-2", toolName: "Write", toolInput: {} });
    expect(store.getApproval("req-n")?.initiated_by).toBeNull();
  });

  test("recordAutoApproval inserts an already-approved row without a pending window", () => {
    const store = withSession();
    store.recordAutoApproval({ sessionId: "s1", toolUseId: "tu-auto", toolName: "Write", toolInput: { file_path: "x.ts" }, initiator: "slack:U_ARCH" });
    // No transient 'pending' row — hasPendingApproval must stay false.
    expect(store.hasPendingApproval("s1")).toBe(false);
    const row = store.getApprovalByToolUse("s1", "tu-auto")!;
    expect(row.decision).toBe("approved");
    expect(row.decided_by).toBe("slack:U_ARCH");
    expect(row.initiated_by).toBe("slack:U_ARCH");
  });

  test("decideApproval transitions once; a second decision is a no-op", () => {
    const store = withSession();
    store.createApproval({ id: "req-1", sessionId: "s1", toolUseId: "tu-1", toolName: "Write", toolInput: {} });

    expect(store.decideApproval("req-1", "slack:U_ARCH", "approved")).toBe(true);
    expect(store.getApproval("req-1")?.decision).toBe("approved");
    expect(store.getApproval("req-1")?.decided_by).toBe("slack:U_ARCH");
    // Second click (Slack at-least-once / double-click) does not re-transition.
    expect(store.decideApproval("req-1", "slack:U_OTHER", "denied")).toBe(false);
    expect(store.getApproval("req-1")?.decision).toBe("approved");
  });

  test("getApprovalByToolUse returns the most recent when a tool_use_id repeats", () => {
    const store = withSession();
    store.createApproval({ id: "req-1", sessionId: "s1", toolUseId: "tu-1", toolName: "Write", toolInput: {} });
    store.decideApproval("req-1", "slack:U_ARCH", "denied");
    store.createApproval({ id: "req-2", sessionId: "s1", toolUseId: "tu-1", toolName: "Write", toolInput: {} });
    expect(store.getApprovalByToolUse("s1", "tu-1")?.id).toBe("req-2");
    expect(store.getApprovalByToolUse("s1", "tu-1")?.decision).toBe("pending");
  });

  test("expirePendingApprovals clears the wedge and leaves decided ones alone", () => {
    const store = withSession();
    store.createApproval({ id: "p1", sessionId: "s1", toolUseId: "tu-1", toolName: "Write", toolInput: {} });
    store.createApproval({ id: "d1", sessionId: "s1", toolUseId: "tu-2", toolName: "Bash", toolInput: {} });
    store.decideApproval("d1", "slack:U_ARCH", "approved");
    expect(store.hasPendingApproval("s1")).toBe(true);

    expect(store.expirePendingApprovals("s1")).toBe(1);
    expect(store.hasPendingApproval("s1")).toBe(false);
    expect(store.getApproval("p1")!.decision).toBe("expired");
    expect(store.getApproval("d1")!.decision).toBe("approved"); // untouched
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

describe("store roles (revocation)", () => {
  test("clearRoles removes all mappings so config can be authoritative (review #8)", () => {
    const store = memoryStore();
    store.setRole("slack:U1", "architect");
    expect(store.isArchitect("slack:U1", "C1")).toBe(true);
    store.clearRoles();
    expect(store.isArchitect("slack:U1", "C1")).toBe(false);
    expect(store.roleOf("slack:U1", "C1")).toBe("member");
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
  const CURRENT_SCHEMA_VERSION = 2;

  const migPath = (name: string): string => join(mkdtempSync(join(tmpdir(), "condotto-mig-")), name);
  const userVersion = (path: string): number => {
    const db = new Database(path, { readonly: true });
    const v = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
    db.close();
    return v;
  };

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
    store.upsertRepo({ name: "legacy", path: "/tmp/legacy", defaultBranch: "main", trusted: true });
    store.createSession({ ...baseSession, id: "sL", conversation_id: "1.9" });
    store.setRole("slack:U_KEEP", "architect", "C9", "grant", "slack:U_BY");
    store.close();

    const raw = new Database(path);
    // Faithfully reconstruct the real pre-runner state: the live store predated
    // BOTH the runner (stamp 0) AND every post-v1 column. Drop the v2 addition so
    // re-migration re-adds it — exactly what the true upgrade does (a v0 store that
    // never had cleanup_at). Without this the rewound store would still carry the
    // column and migrateV2's plain ADD COLUMN would (wrongly) see a duplicate.
    raw.run("ALTER TABLE sessions DROP COLUMN cleanup_at");
    raw.run("PRAGMA user_version = 0"); // rewind the stamp to the pre-runner state
    raw.close();
    expect(userVersion(path)).toBe(0);

    store = new Store(path);
    expect(userVersion(path)).toBe(CURRENT_SCHEMA_VERSION);
    expect(store.getRepo("legacy")?.trusted).toBe(1);
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

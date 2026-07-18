import { describe, expect, test } from "bun:test";
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
  branch: "conduit/abc",
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

  test("session model/effort/subagents/workflows seed on create and default off (M3.5)", () => {
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

  test("session model/effort/subagents/workflows setters (M3.5)", () => {
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

  test("workflow_write defaults off and turning workflows off clears it (M3.6 invariant)", () => {
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

  test("repo default model/effort and trust flag round-trip (M3.5)", () => {
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

  test("repo test/land/deploy commands and cost cap round-trip (M3)", () => {
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
    // Omitted M3 fields are null, and upsert overwrites them back to null.
    store.upsertRepo({ name: "r", path: "/tmp/r", defaultBranch: "main" });
    const r2 = store.getRepo("r")!;
    expect(r2.test_cmd).toBeNull();
    expect(r2.land_cmd).toBeNull();
    expect(r2.cost_cap_usd).toBeNull();
  });
});

describe("store cost accounting (M3)", () => {
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

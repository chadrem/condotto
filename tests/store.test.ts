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
});

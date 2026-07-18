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
});

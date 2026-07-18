import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { SessionManager } from "../src/core/session-manager";
import { WorktreeManager } from "../src/core/worktrees";
import type { ConversationRef, Principal } from "../src/core/types";
import { FakeHarness, FakeSurface } from "./fakes";

let repoPath: string;
let worktreesRoot: string;

const architect: Principal = { surface: "fake", externalId: "U_ARCH" };

function conv(conversationId: string): ConversationRef {
  return { surfaceId: "fake", channelId: "C1", conversationId };
}

async function run(cmd: string[], cwd?: string): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "ignore", stderr: "ignore" });
  if ((await proc.exited) !== 0) throw new Error(`command failed: ${cmd.join(" ")}`);
}

beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), "conduit-test-"));
  repoPath = join(base, "repo");
  worktreesRoot = join(base, "worktrees");
  await run(["git", "init", "-q", "-b", "main", repoPath]);
  await Bun.write(join(repoPath, "README.md"), "# fixture repo\n");
  await run(["git", "-C", repoPath, "add", "-A"]);
  await run([
    "git",
    "-C",
    repoPath,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-qm",
    "init",
  ]);
});

interface World {
  store: Store;
  surface: FakeSurface;
  harness: FakeHarness;
  manager: SessionManager;
}

function makeWorld(store?: Store): World {
  const s = store ?? new Store(":memory:");
  s.upsertRepo({ name: "testrepo", path: repoPath, defaultBranch: "main", safeBashAllowlist: ["git status"] });
  s.setRole("fake:U_ARCH", "architect"); // command authority (assign/stop/approve)
  const surface = new FakeSurface();
  const harness = new FakeHarness();
  const manager = new SessionManager(s, harness, new WorktreeManager(worktreesRoot), () => {});
  manager.registerSurface(surface);
  return { store: s, surface, harness, manager };
}

const member: Principal = { surface: "fake", externalId: "U_MEMBER" };

describe("assign", () => {
  test("creates a session, provisions a worktree, posts the intro", async () => {
    const w = makeWorld();
    await w.manager.handleEvent({
      kind: "command",
      conv: conv("100.000001"),
      author: architect,
      name: "assign",
      args: "",
    });

    const row = w.store.getSessionByConversation("fake", "100.000001");
    expect(row).not.toBeNull();
    expect(row!.repo_id).toBe("testrepo");
    expect(row!.branch).toStartWith("conduit/");
    expect(row!.worktree_path).toStartWith(worktreesRoot);
    expect(existsSync(join(row!.worktree_path, "README.md"))).toBe(true);
    expect(w.surface.posts.at(-1)?.text).toContain("I'm on it");
  });

  test("assigning an already-assigned conversation is refused", async () => {
    const w = makeWorld();
    const c = conv("200.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "assign", args: "" });
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "assign", args: "" });
    expect(w.surface.posts.at(-1)?.text).toContain("already assigned");
    expect(w.store.listSessions({ surfaceId: "fake" }).length).toBe(1);
  });

  test("unknown repo is refused", async () => {
    const w = makeWorld();
    await w.manager.handleEvent({
      kind: "command",
      conv: conv("300.000001"),
      author: architect,
      name: "assign",
      args: "prod-webapp",
    });
    expect(w.surface.posts.at(-1)?.text).toContain('Unknown repo "prod-webapp"');
    expect(w.store.getSessionByConversation("fake", "300.000001")).toBeNull();
  });
});

describe("conversing", () => {
  async function assignAndMessage(w: World, id: string, text: string): Promise<void> {
    await w.manager.handleEvent({ kind: "command", conv: conv(id), author: architect, name: "assign", args: "" });
    await w.manager.handleEvent({
      kind: "message",
      conv: conv(id),
      author: { surface: "fake", externalId: "U_PM" },
      text,
      attachments: [],
    });
  }

  test("thread messages become framed turns; replies land in the thread", async () => {
    const w = makeWorld();
    await assignAndMessage(w, "400.000001", "what does this repo do?");

    // The harness saw exactly one framed turn in the session's worktree.
    expect(w.harness.created.length).toBe(1);
    const turn = w.harness.allTurns[0]!;
    expect(turn.text).toContain("user=fake:U_PM");
    expect(turn.text).toContain("> what does this repo do?");
    const row = w.store.getSessionByConversation("fake", "400.000001");
    expect(turn.cwd).toBe(row!.worktree_path);

    // The human saw a status message that became the reply.
    expect(w.surface.updates.at(-1)?.text).toContain("echo(fake-session-1)");
    // Gate allowed the in-worktree read and denied the /etc/hosts escape.
    expect(w.surface.updates.at(-1)?.text).toContain("gate=allow,deny");
    // Handle was persisted for park & resume.
    expect(row!.harness_session_handle).toMatchObject({ sessionId: "fake-session-1" });
  });

  test("messages in unassigned conversations are ignored", async () => {
    const w = makeWorld();
    await w.manager.handleEvent({
      kind: "message",
      conv: conv("999.000001"),
      author: architect,
      text: "hello?",
      attachments: [],
    });
    expect(w.surface.posts.length).toBe(0);
    expect(w.harness.created.length).toBe(0);
  });

  test("park & resume: a fresh daemon resumes from the persisted handle", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "conduit-db-")), "test.sqlite");
    const w1 = makeWorld(new Store(dbPath));
    await assignAndMessage(w1, "500.000001", "first message");
    const row = w1.store.getSessionByConversation("fake", "500.000001")!;
    w1.store.close();

    // Simulate a daemon restart: new store connection, new manager, new adapters.
    const w2 = makeWorld(new Store(dbPath));
    await w2.manager.handleEvent({
      kind: "message",
      conv: conv("500.000001"),
      author: architect,
      text: "are you still there?",
      attachments: [],
    });

    expect(w2.harness.created.length).toBe(0); // resumed, not re-created
    expect(w2.harness.resumed.length).toBe(1);
    expect(w2.harness.resumed[0]!.cwd).toBe(row.worktree_path);
    expect(w2.harness.resumed[0]!.handle).toMatchObject({ sessionId: "fake-session-1" });
    expect(w2.surface.updates.at(-1)?.text).toContain("echo(fake-session-1)");
  });

  test("queued messages run as sequential turns, never interleaved", async () => {
    const w = makeWorld();
    await w.manager.handleEvent({ kind: "command", conv: conv("600.000001"), author: architect, name: "assign", args: "" });
    await Promise.all([
      w.manager.handleEvent({ kind: "message", conv: conv("600.000001"), author: architect, text: "one", attachments: [] }),
      w.manager.handleEvent({ kind: "message", conv: conv("600.000001"), author: architect, text: "two", attachments: [] }),
    ]);
    const texts = w.harness.allTurns.map((t) => t.text);
    expect(texts.length).toBe(2);
    expect(texts[0]).toContain("> one");
    expect(texts[1]).toContain("> two");
  });
});

describe("stop & status", () => {
  test("stop parks the session permanently; later messages are ignored", async () => {
    const w = makeWorld();
    const c = conv("700.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "assign", args: "" });
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "stop", args: "" });
    expect(w.surface.posts.at(-1)?.text).toContain("Session stopped");

    const before = w.harness.allTurns.length;
    await w.manager.handleEvent({ kind: "message", conv: c, author: architect, text: "hi?", attachments: [] });
    expect(w.harness.allTurns.length).toBe(before);
  });

  test("re-assign after stop reactivates the same session (one conversation, one session, forever)", async () => {
    const w = makeWorld();
    const c = conv("800.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "assign", args: "" });
    const first = w.store.getSessionByConversation("fake", "800.000001")!;
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "stop", args: "" });
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "assign", args: "" });
    const second = w.store.getSessionByConversation("fake", "800.000001")!;
    expect(second.id).toBe(first.id);
    expect(second.status).toBe("parked");
  });

  test("stop during an in-flight turn sticks — the turn's cleanup never resurrects the session", async () => {
    const w = makeWorld();
    const c = conv("810.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "assign", args: "" });

    // Hold the turn open until we release it, so stop lands mid-turn.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    w.harness.beforeReply = () => held;

    const turnPromise = w.manager.handleEvent({
      kind: "message",
      conv: c,
      author: architect,
      text: "long running question",
      attachments: [],
    });
    await Bun.sleep(10); // let the turn start
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "stop", args: "" });
    w.harness.beforeReply = null;
    release();
    await turnPromise;

    expect(w.store.getSessionByConversation("fake", "810.000001")!.status).toBe("stopped");
    const before = w.harness.allTurns.length;
    await w.manager.handleEvent({ kind: "message", conv: c, author: architect, text: "hi?", attachments: [] });
    expect(w.harness.allTurns.length).toBe(before);
  });

  test("status lists sessions", async () => {
    const w = makeWorld();
    await w.manager.handleEvent({ kind: "command", conv: conv("900.000001"), author: architect, name: "assign", args: "" });
    await w.manager.handleEvent({
      kind: "command",
      conv: { surfaceId: "fake", channelId: "C1", conversationId: "" },
      author: architect,
      name: "status",
      args: "",
    });
    expect(w.surface.posts.at(-1)?.text).toContain("testrepo");
  });
});

describe("roles: command authority (M2)", () => {
  test("a member cannot assign a session", async () => {
    const w = makeWorld();
    await w.manager.handleEvent({ kind: "command", conv: conv("a00.000001"), author: member, name: "assign", args: "" });
    expect(w.surface.posts.at(-1)?.text).toContain("Only architects can assign");
    expect(w.store.getSessionByConversation("fake", "a00.000001")).toBeNull();
  });

  test("a member cannot stop an architect's session", async () => {
    const w = makeWorld();
    const c = conv("a10.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "assign", args: "" });
    await w.manager.handleEvent({ kind: "command", conv: c, author: member, name: "stop", args: "" });
    expect(w.surface.posts.at(-1)?.text).toContain("Only architects can stop");
    expect(w.store.getSessionByConversation("fake", "a10.000001")!.status).not.toBe("stopped");
  });
});

describe("gating & approval loop (M2)", () => {
  const writeCall = { id: "tu-write", name: "Write", input: { file_path: "hello.txt", content: "hi" } };

  async function assignWithScript(w: World, id: string, calls: any[]): Promise<void> {
    await w.manager.handleEvent({ kind: "command", conv: conv(id), author: architect, name: "assign", args: "" });
    w.harness.scriptTurn(calls);
    await w.manager.handleEvent({
      kind: "message",
      conv: conv(id),
      author: member,
      text: "please add a hello file",
      attachments: [],
    });
  }

  test("a gated write defers: an approval is requested and the session parks", async () => {
    const w = makeWorld();
    await assignWithScript(w, "b00.000001", [writeCall]);

    const session = w.store.getSessionByConversation("fake", "b00.000001")!;
    expect(w.surface.approvalRequests.length).toBe(1);
    expect(w.surface.approvalRequests[0]!.req.toolName).toBe("Write");
    expect(w.store.hasPendingApproval(session.id)).toBe(true);
    expect(w.harness.executed.length).toBe(0); // nothing ran yet
    expect(w.surface.transcript().some((t) => t.includes("approval"))).toBe(true);
    expect(session.status).toBe("parked");
  });

  test("architect approval resumes the session and the tool executes", async () => {
    const w = makeWorld();
    await assignWithScript(w, "b10.000001", [writeCall]);
    const requestId = w.surface.lastApprovalRequestId()!;
    const session = w.store.getSessionByConversation("fake", "b10.000001")!;

    await w.manager.handleEvent({
      kind: "approval_decision",
      requestId,
      decider: architect,
      decision: "approved",
    });

    expect(w.harness.executed.map((c) => c.name)).toEqual(["Write"]);
    expect(w.store.getApproval(requestId)!.decision).toBe("approved");
    expect(w.store.hasPendingApproval(session.id)).toBe(false);
    expect(w.surface.transcript().some((t) => t.includes("applied Write"))).toBe(true);

    const events = w.store.listAudit(session.id).map((a) => a.event);
    expect(events).toContain("approval_request");
    expect(events).toContain("approval_decision");
    // The gate was consulted twice: gated on the first pass, allowed on re-drive.
    expect(w.store.listAudit(session.id).filter((a) => a.event === "tool_call").length).toBeGreaterThanOrEqual(2);
  });

  test("architect denial resumes with feedback and nothing executes", async () => {
    const w = makeWorld();
    await assignWithScript(w, "b20.000001", [writeCall]);
    const requestId = w.surface.lastApprovalRequestId()!;

    await w.manager.handleEvent({ kind: "approval_decision", requestId, decider: architect, decision: "denied" });

    expect(w.harness.executed.length).toBe(0);
    expect(w.store.getApproval(requestId)!.decision).toBe("denied");
    expect(w.surface.transcript().some((t) => t.includes("did not run Write"))).toBe(true);
  });

  test("a member's approval click is rejected server-side; the session does not resume", async () => {
    const w = makeWorld();
    await assignWithScript(w, "b30.000001", [writeCall]);
    const requestId = w.surface.lastApprovalRequestId()!;
    const session = w.store.getSessionByConversation("fake", "b30.000001")!;

    await w.manager.handleEvent({ kind: "approval_decision", requestId, decider: member, decision: "approved" });

    expect(w.harness.executed.length).toBe(0);
    expect(w.store.getApproval(requestId)!.decision).toBe("pending"); // not decided by a non-architect
    expect(w.store.hasPendingApproval(session.id)).toBe(true);
    expect(w.store.listAudit(session.id).some((a) => a.event === "approval_rejected")).toBe(true);
  });

  test("a hard-deny (write outside the worktree) is refused outright — no approval", async () => {
    const w = makeWorld();
    await assignWithScript(w, "b40.000001", [{ id: "tu-esc", name: "Write", input: { file_path: "/etc/evil", content: "x" } }]);
    const session = w.store.getSessionByConversation("fake", "b40.000001")!;

    expect(w.surface.approvalRequests.length).toBe(0);
    expect(w.store.hasPendingApproval(session.id)).toBe(false);
    expect(w.harness.executed.length).toBe(0);
    expect(w.surface.transcript().some((t) => t.includes("outside your worktree"))).toBe(true);
  });

  test("a message during a pending approval is held, not stacked into a second turn", async () => {
    const w = makeWorld();
    await assignWithScript(w, "b50.000001", [writeCall]);
    const turnsBefore = w.harness.allTurns.length;

    await w.manager.handleEvent({
      kind: "message",
      conv: conv("b50.000001"),
      author: member,
      text: "actually wait",
      attachments: [],
    });

    expect(w.harness.allTurns.length).toBe(turnsBefore); // no new turn ran
    expect(w.surface.posts.at(-1)?.text).toContain("pending approval request");
  });

  test("approval that arrives after stop does not resume", async () => {
    const w = makeWorld();
    await assignWithScript(w, "b60.000001", [writeCall]);
    const requestId = w.surface.lastApprovalRequestId()!;
    await w.manager.handleEvent({ kind: "command", conv: conv("b60.000001"), author: architect, name: "stop", args: "" });

    await w.manager.handleEvent({ kind: "approval_decision", requestId, decider: architect, decision: "approved" });

    expect(w.harness.executed.length).toBe(0);
    expect(w.surface.transcript().some((t) => t.includes("after the session was stopped"))).toBe(true);
  });

  test("safe-allowlisted bash auto-runs without approval", async () => {
    const w = makeWorld();
    await assignWithScript(w, "b70.000001", [{ id: "tu-bash", name: "Bash", input: { command: "git status" } }]);
    expect(w.surface.approvalRequests.length).toBe(0);
    expect(w.harness.executed.map((c) => c.name)).toEqual(["Bash"]);
  });

  test("a failed approval post expires the pending row instead of wedging the session (review #3)", async () => {
    const w = makeWorld();
    w.surface.failApprovals = true;
    await assignWithScript(w, "b80.000001", [writeCall]);
    const session = w.store.getSessionByConversation("fake", "b80.000001")!;

    expect(w.store.hasPendingApproval(session.id)).toBe(false); // expired, not stuck pending
    expect(w.surface.posts.some((p) => p.text.includes("couldn't post the approval"))).toBe(true);

    // The next message runs a normal turn (the session is not wedged).
    w.surface.failApprovals = false;
    w.harness.scriptTurn([{ id: "tu-read", name: "Read", input: { file_path: "README.md" } }]);
    await w.manager.handleEvent({ kind: "message", conv: conv("b80.000001"), author: member, text: "try again", attachments: [] });
    expect(w.harness.executed.map((c) => c.name)).toContain("Read");
  });

  test("stop expires a pending approval so a reassigned session is not wedged (review #7)", async () => {
    const w = makeWorld();
    await assignWithScript(w, "b90.000001", [writeCall]);
    const session = w.store.getSessionByConversation("fake", "b90.000001")!;
    expect(w.store.hasPendingApproval(session.id)).toBe(true);

    await w.manager.handleEvent({ kind: "command", conv: conv("b90.000001"), author: architect, name: "stop", args: "" });
    expect(w.store.hasPendingApproval(session.id)).toBe(false);

    // Reassign, then a message runs a normal turn — no leftover pending block.
    await w.manager.handleEvent({ kind: "command", conv: conv("b90.000001"), author: architect, name: "assign", args: "" });
    w.harness.scriptTurn([{ id: "tu-read2", name: "Read", input: { file_path: "README.md" } }]);
    await w.manager.handleEvent({ kind: "message", conv: conv("b90.000001"), author: member, text: "hello again", attachments: [] });
    expect(w.harness.executed.map((c) => c.name)).toContain("Read");
  });
});

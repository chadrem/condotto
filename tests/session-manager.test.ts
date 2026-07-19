import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { SessionManager } from "../src/core/session-manager";
import { WorktreeManager } from "../src/core/worktrees";
import type { ConversationRef, Principal } from "../src/core/types";
import { FakeHarness, FakeSurface, FakeCommandRunner } from "./fakes";

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
  runner: FakeCommandRunner;
  manager: SessionManager;
}

function makeWorld(
  store?: Store,
  opts: { costCap?: number; maxConcurrentTurns?: number; identityStrength?: "verified" | "weak" } = {},
): World {
  const s = store ?? new Store(":memory:");
  s.upsertRepo({
    name: "testrepo",
    path: repoPath,
    defaultBranch: "main",
    safeBashAllowlist: ["git status"],
    landCmd: "echo land-ran",
    deployCmd: "echo deploy-ran",
  });
  s.setRole("fake:U_ARCH", "architect"); // command authority (assign/stop/approve)
  const surface = new FakeSurface(opts.identityStrength ?? "verified");
  const harness = new FakeHarness();
  const runner = new FakeCommandRunner();
  const manager = new SessionManager(s, harness, new WorktreeManager(worktreesRoot), () => {}, {
    defaultCostCapUsd: opts.costCap ?? 10,
    maxConcurrentTurns: opts.maxConcurrentTurns,
    commandRunner: runner,
  });
  manager.registerSurface(surface);
  return { store: s, surface, harness, runner, manager };
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
    const intro = w.surface.posts.at(-1)!.text;
    expect(intro).toContain("I'm on it");
    // The intro advertises the thread commands (discoverable in-thread, not just docs).
    expect(intro).toContain("@Conduit land");
    expect(intro).toContain("@Conduit budget");
    expect(intro).toContain("@Conduit stop");
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

  test("resume re-supplies the CURRENT system prompt, not the one frozen in the handle", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "conduit-db-")), "test.sqlite");
    const w1 = makeWorld(new Store(dbPath));
    await assignAndMessage(w1, "410.000001", "hello");
    const row = w1.store.getSessionByConversation("fake", "410.000001")!;
    // Simulate a session created under the old M1 posture: overwrite its stored
    // handle with a stale read-only prompt.
    w1.store.updateSessionHandle(row.id, { fake: true, sessionId: "fake-session-1", system: "OLD — you are READ-ONLY" });
    w1.store.close();

    const w2 = makeWorld(new Store(dbPath));
    await w2.manager.handleEvent({
      kind: "message",
      conv: conv("410.000001"),
      author: architect,
      text: "can you change things now?",
      attachments: [],
    });
    // The core supplied the current (M2) prompt on resume — the stale one is gone.
    expect(w2.harness.resumed[0]!.system).not.toContain("READ-ONLY");
    expect(w2.harness.resumed[0]!.system).toContain("approval");
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

describe("guided onboarding (M3.1)", () => {
  test("@Conduit in an unassigned thread offers a repo picker (anyone can ask)", async () => {
    const w = makeWorld();
    await w.manager.handleEvent({ kind: "command", conv: conv("h00.000001"), author: member, name: "help", args: "" });
    const choice = w.surface.lastChoice();
    expect(choice?.choiceId).toBe("assign_repo");
    expect(choice?.options.map((o) => o.value)).toContain("testrepo");
    expect(choice?.architectOnly).toBe(true);
    expect(w.store.getSessionByConversation("fake", "h00.000001")).toBeNull(); // nothing assigned yet
  });

  test("picking a repo (architect) assigns the session", async () => {
    const w = makeWorld();
    await w.manager.handleEvent({ kind: "command", conv: conv("h10.000001"), author: member, name: "help", args: "" });
    await w.manager.handleEvent({ kind: "choice", conv: conv("h10.000001"), author: architect, choiceId: "assign_repo", value: "testrepo" });
    const row = w.store.getSessionByConversation("fake", "h10.000001");
    expect(row).not.toBeNull();
    expect(row!.repo_id).toBe("testrepo");
    expect(w.surface.posts.at(-1)?.text).toContain("I'm on it");
  });

  test("a member picking a repo is refused (assignment is architect-only)", async () => {
    const w = makeWorld();
    await w.manager.handleEvent({ kind: "choice", conv: conv("h20.000001"), author: member, choiceId: "assign_repo", value: "testrepo" });
    expect(w.store.getSessionByConversation("fake", "h20.000001")).toBeNull();
    expect(w.surface.posts.at(-1)?.text).toContain("Only architects can assign");
  });

  test("@Conduit in an assigned thread shows the command summary, not a picker", async () => {
    const w = makeWorld();
    await w.manager.handleEvent({ kind: "command", conv: conv("h30.000001"), author: architect, name: "assign", args: "" });
    const choicesBefore = w.surface.choiceRequests.length;
    await w.manager.handleEvent({ kind: "command", conv: conv("h30.000001"), author: member, name: "help", args: "" });
    expect(w.surface.choiceRequests.length).toBe(choicesBefore); // no picker on an assigned thread
    expect(w.surface.posts.at(-1)?.text).toContain("working in this thread");
    expect(w.surface.posts.at(-1)?.text).toContain("@Conduit stop");
  });

  test("a mention in an unassigned thread guides; a plain message stays silent", async () => {
    const w = makeWorld();
    // Plain message (no mention) in an unassigned thread → ignored (not a chatbot).
    await w.manager.handleEvent({ kind: "message", conv: conv("h40.000001"), author: member, text: "anyone home?", attachments: [] });
    expect(w.surface.choiceRequests.length).toBe(0);
    expect(w.surface.posts.length).toBe(0);
    // A mention → guided.
    await w.manager.handleEvent({ kind: "message", conv: conv("h40.000001"), author: member, text: "hey @conduit", attachments: [], mentioned: true });
    expect(w.surface.lastChoice()?.choiceId).toBe("assign_repo");
  });

  test("with more repos than fit as buttons, guidance falls back to a text list", async () => {
    const w = makeWorld();
    for (let i = 0; i < 6; i++) w.store.upsertRepo({ name: `repo${i}`, path: repoPath, defaultBranch: "main" });
    await w.manager.handleEvent({ kind: "command", conv: conv("h50.000001"), author: member, name: "help", args: "" });
    expect(w.surface.choiceRequests.length).toBe(0); // too many for buttons
    expect(w.surface.posts.at(-1)?.text).toContain("Available repos:");
    expect(w.surface.posts.at(-1)?.text).toContain("@Conduit assign");
  });

  test("an unknown choiceId is ignored (no crash)", async () => {
    const w = makeWorld();
    await w.manager.handleEvent({ kind: "choice", conv: conv("h60.000001"), author: architect, choiceId: "not_a_thing", value: "x" });
    expect(w.store.getSessionByConversation("fake", "h60.000001")).toBeNull();
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

  test("a production-data bash call gates and surfaces the aggregates-only concern (M3)", async () => {
    const w = makeWorld();
    await assignWithScript(w, "b75.000001", [
      { id: "tu-psql", name: "Bash", input: { command: "psql -c 'select count(*) from users'" } },
    ]);
    const session = w.store.getSessionByConversation("fake", "b75.000001")!;
    expect(w.surface.approvalRequests.length).toBe(1);
    const req = w.surface.approvalRequests[0]!.req;
    expect(req.concern).toContain("aggregates only");
    expect(w.harness.executed.length).toBe(0);
    // The gate audited the production-data concern.
    const gated = w.store.listAudit(session.id).find((a) => a.event === "tool_call");
    expect((gated!.detail as any).concern).toBe("production-data");
    // ...and the approval_request records it too.
    const reqAudit = w.store.listAudit(session.id).find((a) => a.event === "approval_request");
    expect((reqAudit!.detail as any).concern).toBe("production-data");
  });

  test("the repo's test command auto-runs without approval (M3)", async () => {
    const w = makeWorld();
    // makeWorld's testrepo has allowlist ["git status"]; give it a test command.
    w.store.upsertRepo({ name: "testrepo", path: repoPath, defaultBranch: "main", safeBashAllowlist: ["git status"], testCmd: "bun test" });
    await assignWithScript(w, "b76.000001", [{ id: "tu-test", name: "Bash", input: { command: "bun test tests/foo.test.ts" } }]);
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

describe("land / deploy (M3, DESIGN §2 journey 4)", () => {
  async function assign(w: World, id: string): Promise<string> {
    await w.manager.handleEvent({ kind: "command", conv: conv(id), author: architect, name: "assign", args: "" });
    return w.store.getSessionByConversation("fake", id)!.id;
  }

  test("an architect ordering land posts an approval; approval runs the exact repo command and audits a deploy", async () => {
    const w = makeWorld();
    await assign(w, "d00.000001");
    await w.manager.handleEvent({ kind: "command", conv: conv("d00.000001"), author: architect, name: "land", args: "" });

    // A conduit:land approval was posted — not run yet (gated, §4).
    expect(w.surface.approvalRequests.length).toBe(1);
    expect(w.surface.approvalRequests[0]!.req.toolName).toBe("conduit:land");
    expect(w.runner.calls.length).toBe(0);

    const requestId = w.surface.lastApprovalRequestId()!;
    await w.manager.handleEvent({ kind: "approval_decision", requestId, decider: architect, decision: "approved" });

    // The daemon ran EXACTLY the repo's configured command in the worktree.
    expect(w.runner.calls.length).toBe(1);
    expect(w.runner.calls[0]!.command).toBe("echo land-ran");
    const session = w.store.getSessionByConversation("fake", "d00.000001")!;
    expect(w.runner.calls[0]!.cwd).toBe(session.worktree_path);
    expect(w.store.listAudit(session.id).some((a) => a.event === "deploy")).toBe(true);
    expect(w.surface.transcript().some((t) => t.includes("succeeded"))).toBe(true);
  });

  test("denying a land runs nothing", async () => {
    const w = makeWorld();
    await assign(w, "d10.000001");
    await w.manager.handleEvent({ kind: "command", conv: conv("d10.000001"), author: architect, name: "deploy", args: "" });
    const requestId = w.surface.lastApprovalRequestId()!;
    await w.manager.handleEvent({ kind: "approval_decision", requestId, decider: architect, decision: "denied" });
    expect(w.runner.calls.length).toBe(0);
    expect(w.surface.transcript().some((t) => t.includes("cancelled"))).toBe(true);
  });

  test("a member cannot order a deploy", async () => {
    const w = makeWorld();
    await assign(w, "d20.000001");
    await w.manager.handleEvent({ kind: "command", conv: conv("d20.000001"), author: member, name: "deploy", args: "" });
    expect(w.surface.approvalRequests.length).toBe(0);
    expect(w.surface.posts.at(-1)?.text).toContain("Only architects can deploy");
  });

  test("land is refused when the repo has no land command", async () => {
    const w = makeWorld();
    w.store.upsertRepo({ name: "testrepo", path: repoPath, defaultBranch: "main", safeBashAllowlist: ["git status"] }); // clears land/deploy
    await assign(w, "d30.000001");
    await w.manager.handleEvent({ kind: "command", conv: conv("d30.000001"), author: architect, name: "land", args: "" });
    expect(w.surface.approvalRequests.length).toBe(0);
    expect(w.surface.posts.at(-1)?.text).toContain("No land command is configured");
  });

  test("a nonzero exit is reported as a failure", async () => {
    const w = makeWorld();
    w.runner.result = { code: 2, output: "boom", timedOut: false };
    await assign(w, "d40.000001");
    await w.manager.handleEvent({ kind: "command", conv: conv("d40.000001"), author: architect, name: "land", args: "" });
    const requestId = w.surface.lastApprovalRequestId()!;
    await w.manager.handleEvent({ kind: "approval_decision", requestId, decider: architect, decision: "approved" });
    expect(w.surface.transcript().some((t) => t.includes("exited 2"))).toBe(true);
  });
});

describe("cost budgets & runaway cap (M3, DESIGN §4)", () => {
  async function assignAndSpend(w: World, id: string, spent: number): Promise<string> {
    await w.manager.handleEvent({ kind: "command", conv: conv(id), author: architect, name: "assign", args: "" });
    const sid = w.store.getSessionByConversation("fake", id)!.id;
    w.store.insertTurn({ sessionId: sid, direction: "out", text: "prior", costUsd: spent });
    return sid;
  }

  test("a new turn passes the remaining budget to the harness as a per-turn cap", async () => {
    const w = makeWorld(undefined, { costCap: 5 });
    await w.manager.handleEvent({ kind: "command", conv: conv("e00.000001"), author: architect, name: "assign", args: "" });
    await w.manager.handleEvent({ kind: "message", conv: conv("e00.000001"), author: member, text: "hi", attachments: [] });
    expect(w.harness.allTurns.at(-1)!.budgetUsd).toBe(5); // full headroom on the first turn
  });

  test("an approval-resume turn runs uncapped so a near-budget approved action isn't stranded", async () => {
    const w = makeWorld(undefined, { costCap: 5 });
    await w.manager.handleEvent({ kind: "command", conv: conv("e05.000001"), author: architect, name: "assign", args: "" });
    const sid = w.store.getSessionByConversation("fake", "e05.000001")!.id;
    w.store.insertTurn({ sessionId: sid, direction: "out", text: "prior", costUsd: 4.9 }); // near the $5 cap
    w.harness.scriptTurn([{ id: "tu-w", name: "Write", input: { file_path: "x.txt", content: "hi" } }]);
    await w.manager.handleEvent({ kind: "message", conv: conv("e05.000001"), author: member, text: "add x", attachments: [] });
    const requestId = w.surface.lastApprovalRequestId()!;
    await w.manager.handleEvent({ kind: "approval_decision", requestId, decider: architect, decision: "approved" });

    // The approved Write ran despite being near the cap.
    expect(w.harness.executed.map((c) => c.name)).toContain("Write");
    // The resume turn (last) carried NO per-turn budget cap.
    expect(w.harness.allTurns.at(-1)!.budgetUsd).toBeUndefined();
  });

  test("a session over its cap pauses new turns and pings for a budget raise", async () => {
    const w = makeWorld(undefined, { costCap: 5 });
    const sid = await assignAndSpend(w, "e10.000001", 6); // already over the $5 cap
    const before = w.harness.allTurns.length;
    await w.manager.handleEvent({ kind: "message", conv: conv("e10.000001"), author: member, text: "do more", attachments: [] });
    expect(w.harness.allTurns.length).toBe(before); // no turn ran
    expect(w.surface.posts.at(-1)?.text).toContain("cost budget");
    expect(w.store.listAudit(sid).some((a) => a.event === "budget_exceeded")).toBe(true);
  });

  test("an architect raising the budget unblocks the session", async () => {
    const w = makeWorld(undefined, { costCap: 5 });
    await assignAndSpend(w, "e20.000001", 6);
    await w.manager.handleEvent({ kind: "command", conv: conv("e20.000001"), author: architect, name: "budget", args: "20" });
    expect(w.surface.posts.at(-1)?.text).toContain("Cost budget set to $20.00");

    const before = w.harness.allTurns.length;
    await w.manager.handleEvent({ kind: "message", conv: conv("e20.000001"), author: member, text: "now continue", attachments: [] });
    expect(w.harness.allTurns.length).toBe(before + 1); // runs again
  });

  test("a turn that ends in an error still records its cost (budget can't be evaded)", async () => {
    const w = makeWorld(undefined, { costCap: 5 });
    await w.manager.handleEvent({ kind: "command", conv: conv("e40.000001"), author: architect, name: "assign", args: "" });
    const sid = w.store.getSessionByConversation("fake", "e40.000001")!.id;
    w.harness.nextError = { message: "I hit this turn's cost budget ($6.00) and stopped.", costUsd: 6 };
    await w.manager.handleEvent({ kind: "message", conv: conv("e40.000001"), author: architect, text: "spendy", attachments: [] });
    // The error's cost was recorded — cumulative spend now reflects it.
    expect(w.store.sessionCostUsd(sid)).toBe(6);
    // ...so the very next turn is paused by the runaway cap.
    const before = w.harness.allTurns.length;
    await w.manager.handleEvent({ kind: "message", conv: conv("e40.000001"), author: architect, text: "again", attachments: [] });
    expect(w.harness.allTurns.length).toBe(before);
    expect(w.surface.posts.at(-1)?.text).toContain("cost budget");
  });

  test("a member cannot change the budget", async () => {
    const w = makeWorld(undefined, { costCap: 5 });
    await assignAndSpend(w, "e30.000001", 1);
    await w.manager.handleEvent({ kind: "command", conv: conv("e30.000001"), author: member, name: "budget", args: "99" });
    expect(w.surface.posts.at(-1)?.text).toContain("Only architects can change the cost budget");
    expect(w.store.getSessionByConversation("fake", "e30.000001")!.budget_limit_usd).toBe(5);
  });
});

describe("streaming progress (M3)", () => {
  test("a burst of progress events is coalesced into the one status message and never clobbers the reply", async () => {
    const w = makeWorld();
    w.harness.progressBurst = 5; // emits 5 extra progress events before the reply
    await w.manager.handleEvent({ kind: "command", conv: conv("g00.000001"), author: architect, name: "assign", args: "" });
    await w.manager.handleEvent({ kind: "message", conv: conv("g00.000001"), author: architect, text: "go", attachments: [] });

    // Throttled: 6 progress events did NOT produce 6 edits.
    expect(w.surface.updates.length).toBeLessThan(4);
    // The reply is the last thing shown, not a stranded progress line.
    expect(w.surface.updates.at(-1)?.text).toContain("echo(");

    // A late trailing flush must not fire after the reply and clobber it.
    const finalText = w.surface.updates.at(-1)?.text;
    await Bun.sleep(3000);
    expect(w.surface.updates.at(-1)?.text).toBe(finalText);
  });
});

describe("concurrency (M3, DESIGN §7)", () => {
  test("turns across different sessions run concurrently but never exceed the cap", async () => {
    const w = makeWorld(undefined, { maxConcurrentTurns: 2 });
    const ids = ["f00.000001", "f01.000001", "f02.000001", "f03.000001"];
    for (const id of ids) {
      await w.manager.handleEvent({ kind: "command", conv: conv(id), author: architect, name: "assign", args: "" });
    }

    // Every turn blocks at its start until we open the shared gate, so the
    // number "held" at once is exactly the number of admitted concurrency slots.
    let active = 0;
    let peak = 0;
    let openGate!: () => void;
    const gate = new Promise<void>((r) => (openGate = r));
    w.harness.beforeReply = async () => {
      active++;
      peak = Math.max(peak, active);
      await gate;
      active--;
    };

    const turns = ids.map((id) =>
      w.manager.handleEvent({ kind: "message", conv: conv(id), author: architect, text: "go", attachments: [] }),
    );
    // Wait for the semaphore to admit its maximum, then confirm it caps there.
    for (let i = 0; i < 40 && active < 2; i++) await Bun.sleep(5);
    await Bun.sleep(20);
    expect(active).toBe(2); // capped — the other two are queued
    expect(peak).toBe(2);

    openGate();
    await Promise.all(turns);
    expect(peak).toBe(2); // never exceeded the cap across the whole run
    expect(w.harness.allTurns.length).toBe(4); // all four eventually ran
  });

  test("a stop landing while a turn waits for a concurrency slot aborts that turn (review)", async () => {
    const w = makeWorld(undefined, { maxConcurrentTurns: 1 });
    for (const id of ["f10.000001", "f11.000001"]) {
      await w.manager.handleEvent({ kind: "command", conv: conv(id), author: architect, name: "assign", args: "" });
    }
    // Session A holds the single slot open; B's turn will block on acquire.
    let releaseA!: () => void;
    const heldA = new Promise<void>((r) => (releaseA = r));
    let first = true;
    w.harness.beforeReply = () => (first ? ((first = false), heldA) : Promise.resolve());

    const aTurn = w.manager.handleEvent({ kind: "message", conv: conv("f10.000001"), author: architect, text: "aaa", attachments: [] });
    await Bun.sleep(20); // A acquires the slot and holds it
    const bTurn = w.manager.handleEvent({ kind: "message", conv: conv("f11.000001"), author: architect, text: "bbb", attachments: [] });
    await Bun.sleep(20); // B is now blocked waiting for the slot
    await w.manager.handleEvent({ kind: "command", conv: conv("f11.000001"), author: architect, name: "stop", args: "" });
    releaseA(); // A finishes, frees the slot; B resumes past acquire
    await Promise.all([aTurn, bTurn]);

    // B's turn never ran on the stopped session.
    expect(w.harness.allTurns.some((t) => t.text.includes("bbb"))).toBe(false);
    expect(w.harness.allTurns.some((t) => t.text.includes("aaa"))).toBe(true);
    expect(w.store.getSessionByConversation("fake", "f11.000001")!.status).toBe("stopped");
  });
});

describe("harness capabilities — model & effort (M3.5 Tier A)", () => {
  async function assign(w: World, id: string): Promise<void> {
    await w.manager.handleEvent({ kind: "command", conv: conv(id), author: architect, name: "assign", args: "" });
  }

  test("assign advertises the default model & effort (Opus + high)", async () => {
    const w = makeWorld();
    await assign(w, "cap1.000001");
    const intro = w.surface.posts.at(-1)!.text;
    expect(intro).toContain("model `opus`");
    expect(intro).toContain("effort `high`");
  });

  test("architect sets the model; it persists and reaches the next turn", async () => {
    const w = makeWorld();
    const c = conv("cap2.000001");
    await assign(w, "cap2.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "model", args: "sonnet" });
    expect(w.store.getSessionByConversation("fake", "cap2.000001")!.model).toBe("sonnet");
    expect(w.surface.posts.at(-1)!.text).toContain("Model set to `sonnet`");

    await w.manager.handleEvent({ kind: "message", conv: c, author: architect, text: "hi", attachments: [] });
    const last = w.harness.allTurns.at(-1)!;
    expect(last.harness?.model).toBe("sonnet");
    expect(last.harness?.effort).toBe("high"); // unchanged default
    expect(last.harness?.subagents).toBe(false); // Tier B off by default
    expect(last.harness?.workflows).toBe(false);
  });

  test("architect sets the effort; it persists and reaches the next turn", async () => {
    const w = makeWorld();
    const c = conv("cap3.000001");
    await assign(w, "cap3.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "effort", args: "xhigh" });
    expect(w.store.getSessionByConversation("fake", "cap3.000001")!.effort).toBe("xhigh");
    await w.manager.handleEvent({ kind: "message", conv: c, author: architect, text: "hi", attachments: [] });
    expect(w.harness.allTurns.at(-1)!.harness?.effort).toBe("xhigh");
  });

  test("a member cannot change model or effort", async () => {
    const w = makeWorld();
    const c = conv("cap4.000001");
    await assign(w, "cap4.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: member, name: "model", args: "sonnet" });
    expect(w.surface.posts.at(-1)!.text).toContain("Only architects");
    expect(w.store.getSessionByConversation("fake", "cap4.000001")!.model).toBeNull();
    await w.manager.handleEvent({ kind: "command", conv: c, author: member, name: "effort", args: "max" });
    expect(w.surface.posts.at(-1)!.text).toContain("Only architects");
    expect(w.store.getSessionByConversation("fake", "cap4.000001")!.effort).toBeNull();
  });

  test("an unsupported model/effort is rejected with usage, leaving the session unchanged", async () => {
    const w = makeWorld();
    const c = conv("cap5.000001");
    await assign(w, "cap5.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "model", args: "gpt-9" });
    const msg = w.surface.posts.at(-1)!.text;
    expect(msg).toContain("Usage");
    expect(msg).toContain("opus"); // lists the supported set
    expect(w.store.getSessionByConversation("fake", "cap5.000001")!.model).toBeNull();
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "effort", args: "ludicrous" });
    expect(w.surface.posts.at(-1)!.text).toContain("Usage");
    expect(w.store.getSessionByConversation("fake", "cap5.000001")!.effort).toBeNull();
  });

  test("a repo default_model/effort seeds the session at assign", async () => {
    const w = makeWorld();
    w.store.upsertRepo({
      name: "testrepo",
      path: repoPath,
      defaultBranch: "main",
      safeBashAllowlist: ["git status"],
      landCmd: "echo land-ran",
      deployCmd: "echo deploy-ran",
      defaultModel: "fable",
      defaultEffort: "xhigh",
    });
    await assign(w, "cap6.000001");
    const s = w.store.getSessionByConversation("fake", "cap6.000001")!;
    expect(s.model).toBe("fable");
    expect(s.effort).toBe("xhigh");
    expect(w.surface.posts.at(-1)!.text).toContain("model `fable`");
  });

  test("an unsupported repo default falls back to the daemon default (Opus)", async () => {
    const w = makeWorld();
    w.store.upsertRepo({
      name: "testrepo",
      path: repoPath,
      defaultBranch: "main",
      safeBashAllowlist: ["git status"],
      landCmd: "echo land-ran",
      deployCmd: "echo deploy-ran",
      defaultModel: "bogus-model",
    });
    await assign(w, "cap7.000001");
    const s = w.store.getSessionByConversation("fake", "cap7.000001")!;
    expect(s.model).toBeNull(); // not applied
    expect(w.surface.posts.at(-1)!.text).toContain("model `opus`"); // effective default
  });

  test("a default session forwards Opus + high to the harness on a normal turn", async () => {
    const w = makeWorld();
    const c = conv("cap8.000001");
    await assign(w, "cap8.000001");
    await w.manager.handleEvent({ kind: "message", conv: c, author: architect, text: "hello", attachments: [] });
    const last = w.harness.allTurns.at(-1)!;
    expect(last.harness?.model).toBe("opus");
    expect(last.harness?.effort).toBe("high");
    expect(last.harness?.projectConfig).toBe(false); // testrepo untrusted
  });
});

describe("harness capabilities — subagents & ultra (M3.5 Tier B)", () => {
  async function assign(w: World, id: string): Promise<void> {
    await w.manager.handleEvent({ kind: "command", conv: conv(id), author: architect, name: "assign", args: "" });
  }

  test("subagents default off, and the intro doesn't claim them", async () => {
    const w = makeWorld();
    await assign(w, "sb1.000001");
    expect(w.store.getSessionByConversation("fake", "sb1.000001")!.subagents).toBe(0);
    // The capability summary (not the command list) must not claim subagents are on.
    expect(w.surface.posts.at(-1)!.text).not.toContain("*subagents on*");
    expect(w.surface.posts.at(-1)!.text).not.toContain("*ultra on*");
  });

  test("the join announcement lists EVERY setting, including subagents/ultra when off", async () => {
    const w = makeWorld();
    await assign(w, "set1.000001");
    const intro = w.surface.posts.at(-1)!.text;
    expect(intro).toContain("Session settings");
    expect(intro).toContain("model `opus`");
    expect(intro).toContain("effort `high`");
    expect(intro).toContain("subagents off"); // announced even though off
    expect(intro).toContain("ultra off");
    expect(intro).toContain("cost budget");
  });

  test("the join announcement reflects enabled subagents/ultra when Conduit re-announces", async () => {
    const w = makeWorld();
    const c = conv("set2.000001");
    await assign(w, "set2.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "ultra", args: "on" });
    // A bare @Conduit (help) re-announces the current settings in an assigned thread.
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "help", args: "" });
    const msg = w.surface.posts.at(-1)!.text;
    expect(msg).toContain("Session settings");
    expect(msg).toContain("subagents *on*");
    expect(msg).toContain("ultra *on*");
  });

  test("architect turns subagents on; it persists, reaches the turn, and enters the prompt", async () => {
    const w = makeWorld();
    const c = conv("sb2.000001");
    await assign(w, "sb2.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "subagents", args: "on" });
    expect(w.store.getSessionByConversation("fake", "sb2.000001")!.subagents).toBe(1);
    expect(w.surface.posts.at(-1)!.text).toContain("Subagents on");

    await w.manager.handleEvent({ kind: "message", conv: c, author: architect, text: "hi", attachments: [] });
    expect(w.harness.allTurns.at(-1)!.harness?.subagents).toBe(true);
    // System prompt on attach carries the delegation guidance.
    expect(w.harness.created.at(-1)!.system).toMatch(/subagent/i);
  });

  test("a member cannot toggle subagents; a bad arg shows usage", async () => {
    const w = makeWorld();
    const c = conv("sb3.000001");
    await assign(w, "sb3.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: member, name: "subagents", args: "on" });
    expect(w.surface.posts.at(-1)!.text).toContain("Only architects");
    expect(w.store.getSessionByConversation("fake", "sb3.000001")!.subagents).toBe(0);
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "subagents", args: "maybe" });
    expect(w.surface.posts.at(-1)!.text).toContain("Usage");
    expect(w.store.getSessionByConversation("fake", "sb3.000001")!.subagents).toBe(0);
  });

  test("ultra on sets xhigh + subagents (the preset); off restores the defaults", async () => {
    const w = makeWorld();
    const c = conv("sb4.000001");
    await assign(w, "sb4.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "ultra", args: "on" });
    let s = w.store.getSessionByConversation("fake", "sb4.000001")!;
    expect(s.subagents).toBe(1);
    expect(s.effort).toBe("xhigh");
    expect(w.surface.posts.at(-1)!.text).toContain("Ultra on");

    await w.manager.handleEvent({ kind: "message", conv: c, author: architect, text: "go", attachments: [] });
    const t = w.harness.allTurns.at(-1)!;
    expect(t.harness?.subagents).toBe(true);
    expect(t.harness?.effort).toBe("xhigh");

    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "ultra", args: "off" });
    s = w.store.getSessionByConversation("fake", "sb4.000001")!;
    expect(s.subagents).toBe(0);
    expect(s.effort).toBeNull(); // back to the daemon default (high)
  });

  test("dropping to a lower effort takes a session out of ultra (derived state)", async () => {
    const w = makeWorld();
    const c = conv("sb5.000001");
    await assign(w, "sb5.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "ultra", args: "on" });
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "status", args: "" });
    expect(w.surface.posts.at(-1)!.text).toContain("ultra on");
    // Lowering effort below xhigh means it's no longer the ultra preset (subagents stay on).
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "effort", args: "high" });
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "status", args: "" });
    const msg = w.surface.posts.at(-1)!.text;
    expect(msg).not.toContain("ultra on");
    expect(msg).toContain("subagents on");
  });

  test("a subagent-initiated write is denied end-to-end — the main agent must do it", async () => {
    const w = makeWorld();
    const c = conv("sb6.000001");
    await assign(w, "sb6.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "subagents", args: "on" });
    // The next turn attempts a Write from a SUBAGENT (agentId set).
    w.harness.scriptTurn([{ id: "sw1", name: "Write", input: { file_path: "x.ts" }, agentId: "sub-xyz" }]);
    await w.manager.handleEvent({ kind: "message", conv: c, author: architect, text: "go", attachments: [] });
    // Denied, not executed, and no approval was ever posted (subagents can't gate).
    expect(w.harness.executed.find((cl) => cl.id === "sw1")).toBeUndefined();
    expect(w.surface.approvalRequests.length).toBe(0);
    expect(w.surface.transcript().join("\n")).toMatch(/denied|Subagents can't/i);
  });

  test("subagents/ultra state shows in the status listing", async () => {
    const w = makeWorld();
    const c = conv("sb7.000001");
    await assign(w, "sb7.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "ultra", args: "on" });
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "status", args: "" });
    expect(w.surface.posts.at(-1)!.text).toContain("ultra on");
  });

  test("toggling subagents rebuilds the system prompt on the next turn (review fix)", async () => {
    const w = makeWorld();
    const c = conv("sb8.000001");
    await assign(w, "sb8.000001");
    // Turn 1 (subagents off): the created harness prompt has no delegation guidance.
    await w.manager.handleEvent({ kind: "message", conv: c, author: architect, text: "one", attachments: [] });
    expect(w.harness.created.at(-1)!.system).not.toMatch(/delegate READ-ONLY/i);
    // Toggle on, then turn 2: the harness is re-attached with a fresh prompt that
    // DOES include the delegation guidance (promptKey mismatch forces a rebuild).
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "subagents", args: "on" });
    await w.manager.handleEvent({ kind: "message", conv: c, author: architect, text: "two", attachments: [] });
    expect(w.harness.resumed.at(-1)!.system).toMatch(/delegate READ-ONLY/i);
  });
});

describe("harness capabilities — workflows (M3.6)", () => {
  async function assign(w: World, id: string): Promise<void> {
    await w.manager.handleEvent({ kind: "command", conv: conv(id), author: architect, name: "assign", args: "" });
  }

  test("workflows default off, and the join announcement lists it", async () => {
    const w = makeWorld();
    await assign(w, "wf1.000001");
    expect(w.store.getSessionByConversation("fake", "wf1.000001")!.workflows).toBe(0);
    const intro = w.surface.posts.at(-1)!.text;
    expect(intro).toContain("workflows off");
    expect(intro).not.toContain("*workflows on*");
  });

  test("architect turns workflows on; it persists, implies subagents, reaches the turn + prompt", async () => {
    const w = makeWorld();
    const c = conv("wf2.000001");
    await assign(w, "wf2.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "workflows", args: "on" });
    const s = w.store.getSessionByConversation("fake", "wf2.000001")!;
    expect(s.workflows).toBe(1);
    expect(s.subagents).toBe(1); // a workflow orchestrates subagents
    expect(w.surface.posts.at(-1)!.text).toContain("Workflows on");

    await w.manager.handleEvent({ kind: "message", conv: c, author: architect, text: "audit auth", attachments: [] });
    expect(w.harness.allTurns.at(-1)!.harness?.workflows).toBe(true);
    // System prompt on attach carries the workflow guidance.
    expect(w.harness.created.at(-1)!.system).toMatch(/workflow/i);
  });

  test("a member cannot toggle workflows; a bad arg shows usage", async () => {
    const w = makeWorld();
    const c = conv("wf3.000001");
    await assign(w, "wf3.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: member, name: "workflows", args: "on" });
    expect(w.surface.posts.at(-1)!.text).toContain("Only architects");
    expect(w.store.getSessionByConversation("fake", "wf3.000001")!.workflows).toBe(0);
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "workflows", args: "huh" });
    expect(w.surface.posts.at(-1)!.text).toContain("Usage");
    expect(w.store.getSessionByConversation("fake", "wf3.000001")!.workflows).toBe(0);
  });

  test("turning subagents off also turns workflows off (workflows need the base capability)", async () => {
    const w = makeWorld();
    const c = conv("wf4.000001");
    await assign(w, "wf4.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "workflows", args: "on" });
    expect(w.store.getSessionByConversation("fake", "wf4.000001")!.workflows).toBe(1);
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "subagents", args: "off" });
    const s = w.store.getSessionByConversation("fake", "wf4.000001")!;
    expect(s.subagents).toBe(0);
    expect(s.workflows).toBe(0);
  });

  test("ultra on now enables workflows too (re-folded into the preset)", async () => {
    const w = makeWorld();
    const c = conv("wf5.000001");
    await assign(w, "wf5.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "ultra", args: "on" });
    const s = w.store.getSessionByConversation("fake", "wf5.000001")!;
    expect(s.workflows).toBe(1);
    expect(s.subagents).toBe(1);
    expect(s.effort).toBe("xhigh");
    await w.manager.handleEvent({ kind: "message", conv: c, author: architect, text: "go", attachments: [] });
    expect(w.harness.allTurns.at(-1)!.harness?.workflows).toBe(true);
    // ultra off clears workflows again.
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "ultra", args: "off" });
    expect(w.store.getSessionByConversation("fake", "wf5.000001")!.workflows).toBe(0);
  });

  test("workflows on shows in the status listing and re-announcement", async () => {
    const w = makeWorld();
    const c = conv("wf6.000001");
    await assign(w, "wf6.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "workflows", args: "on" });
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "status", args: "" });
    expect(w.surface.posts.at(-1)!.text).toContain("workflows on");
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "help", args: "" });
    expect(w.surface.posts.at(-1)!.text).toContain("workflows *on*");
  });

  test("a workflow LAUNCH gates → architect approves → the workflow runs (Tier 2)", async () => {
    const w = makeWorld();
    const c = conv("wf7.000001");
    await assign(w, "wf7.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "workflows", args: "on" });
    // A member asks; the agent proposes a workflow. The LAUNCH is a gated action.
    const script = "export const meta = { name: 'auth-audit', description: 'Audit auth across the code' }";
    w.harness.scriptTurn([{ id: "wf-1", name: "Workflow", input: { script } }]);
    await w.manager.handleEvent({ kind: "message", conv: c, author: member, text: "audit our auth", attachments: [] });

    // Launch gated: approval posted with the workflow name + the fan-out concern; nothing ran.
    expect(w.surface.approvalRequests.length).toBe(1);
    const req = w.surface.approvalRequests[0]!.req;
    expect(req.toolName).toBe("Workflow");
    expect(req.summary).toContain("auth-audit");
    expect(req.concern).toContain("multi-agent workflow");
    expect(w.harness.executed.length).toBe(0);

    // Architect approves → the workflow runs (re-driven and executed).
    const requestId = w.surface.lastApprovalRequestId()!;
    await w.manager.handleEvent({ kind: "approval_decision", requestId, decider: architect, decision: "approved" });
    expect(w.harness.executed.map((cl) => cl.name)).toContain("Workflow");
    // The workflow-turn reply carries the summary cost footer.
    expect(w.surface.transcript().some((t) => /multi-agent workflow · \$/.test(t))).toBe(true);
  });

  test("a workflow launch DENY runs nothing (Tier 2)", async () => {
    const w = makeWorld();
    const c = conv("wf8.000001");
    await assign(w, "wf8.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "workflows", args: "on" });
    const script = "export const meta = { name: 'auth-audit', description: 'x' }";
    w.harness.scriptTurn([{ id: "wf-d", name: "Workflow", input: { script } }]);
    await w.manager.handleEvent({ kind: "message", conv: c, author: member, text: "audit our auth", attachments: [] });
    const requestId = w.surface.lastApprovalRequestId()!;
    await w.manager.handleEvent({ kind: "approval_decision", requestId, decider: architect, decision: "denied" });
    expect(w.harness.executed.length).toBe(0);
    expect(w.store.getApproval(requestId)!.decision).toBe("denied");
  });
});

describe("informed worktree-write opt-in (M3.6 Tier 3)", () => {
  async function assign(w: World, id: string): Promise<void> {
    await w.manager.handleEvent({ kind: "command", conv: conv(id), author: architect, name: "assign", args: "" });
  }

  test("a workflow/subagent write is denied read-only, then ALLOWED after `workflows write on`", async () => {
    const w = makeWorld();
    const c = conv("ww1.000001");
    await assign(w, "ww1.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "workflows", args: "on" });

    // Read-only default: a subagent-origin write is denied, nothing runs, no approval.
    w.harness.scriptTurn([{ id: "ww-a", name: "Write", input: { file_path: "x.ts", content: "x" }, agentId: "sub-1" }]);
    await w.manager.handleEvent({ kind: "message", conv: c, author: architect, text: "go", attachments: [] });
    expect(w.harness.executed.find((cl) => cl.id === "ww-a")).toBeUndefined();
    expect(w.surface.approvalRequests.length).toBe(0);

    // Turn on worktree-write — the mandatory warning posts and the flags flip.
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "workflows", args: "write on" });
    const s = w.store.getSessionByConversation("fake", "ww1.000001")!;
    expect(s.workflow_write).toBe(1);
    expect(s.workflows).toBe(1);
    expect(s.subagents).toBe(1);
    expect(w.surface.posts.at(-1)!.text).toMatch(/worktree-write is now ON/i);
    expect(w.surface.posts.at(-1)!.text).toMatch(/WITHOUT per-write approval/i);
    expect(w.surface.posts.at(-1)!.text).toMatch(/hard-denied/i);

    // Now a confined subagent write is allowed and runs — no per-write approval.
    w.harness.scriptTurn([{ id: "ww-b", name: "Write", input: { file_path: "y.ts", content: "y" }, agentId: "sub-2" }]);
    await w.manager.handleEvent({ kind: "message", conv: c, author: architect, text: "go again", attachments: [] });
    expect(w.harness.executed.map((cl) => cl.id)).toContain("ww-b");
    expect(w.surface.approvalRequests.length).toBe(0);
  });

  test("worktree-write still HARD-DENIES an out-of-worktree subagent write", async () => {
    const w = makeWorld();
    const c = conv("ww2.000001");
    await assign(w, "ww2.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "workflows", args: "write on" });
    w.harness.scriptTurn([{ id: "ww-esc", name: "Write", input: { file_path: "/etc/evil", content: "x" }, agentId: "sub-3" }]);
    await w.manager.handleEvent({ kind: "message", conv: c, author: architect, text: "go", attachments: [] });
    expect(w.harness.executed.length).toBe(0);
    expect(w.surface.approvalRequests.length).toBe(0);
  });

  test("`workflows off` clears the worktree-write opt-in (invariant: write ⟹ workflows)", async () => {
    const w = makeWorld();
    const c = conv("ww3.000001");
    await assign(w, "ww3.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "workflows", args: "write on" });
    expect(w.store.getSessionByConversation("fake", "ww3.000001")!.workflow_write).toBe(1);
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "workflows", args: "off" });
    const s = w.store.getSessionByConversation("fake", "ww3.000001")!;
    expect(s.workflows).toBe(0);
    expect(s.workflow_write).toBe(0);
  });

  test("`workflows on` and `ultra on` reset write mode to read-only (truthful messaging) — review fix", async () => {
    for (const [id, cmd, arg] of [
      ["wwa.000001", "workflows", "on"],
      ["wwb.000001", "ultra", "on"],
    ] as const) {
      const w = makeWorld();
      const c = conv(id);
      await assign(w, id);
      await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "workflows", args: "write on" });
      expect(w.store.getSessionByConversation("fake", id)!.workflow_write).toBe(1);
      // Re-issuing plain workflows-on / ultra-on returns to the read-only posture.
      await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: cmd, args: arg });
      const s = w.store.getSessionByConversation("fake", id)!;
      expect(s.workflow_write).toBe(0);
      expect(s.workflows).toBe(1); // still on, just read-only again
      // The reply's "read-only" claim is now truthful (no worktree-write live).
      expect(w.surface.posts.at(-1)!.text).not.toContain("worktree-write");
    }
  });

  test("`subagents off` clears the worktree-write opt-in end-to-end (invariant)", async () => {
    const w = makeWorld();
    const c = conv("wwc.000001");
    await assign(w, "wwc.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "workflows", args: "write on" });
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "subagents", args: "off" });
    const s = w.store.getSessionByConversation("fake", "wwc.000001")!;
    expect(s.subagents).toBe(0);
    expect(s.workflows).toBe(0);
    expect(s.workflow_write).toBe(0);
  });

  test("a member cannot enable worktree-write", async () => {
    const w = makeWorld();
    const c = conv("ww4.000001");
    await assign(w, "ww4.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: member, name: "workflows", args: "write on" });
    expect(w.surface.posts.at(-1)!.text).toContain("Only architects");
    expect(w.store.getSessionByConversation("fake", "ww4.000001")!.workflow_write).toBe(0);
  });

  test("the settings announcement warns prominently when worktree-write is on", async () => {
    const w = makeWorld();
    const c = conv("ww5.000001");
    await assign(w, "ww5.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "workflows", args: "write on" });
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "help", args: "" });
    expect(w.surface.posts.at(-1)!.text).toMatch(/worktree-write ON/i);
  });

  test("worktree-write reaches the turn's system prompt", async () => {
    const w = makeWorld();
    const c = conv("ww6.000001");
    await assign(w, "ww6.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "workflows", args: "write on" });
    await w.manager.handleEvent({ kind: "message", conv: c, author: architect, text: "refactor in parallel", attachments: [] });
    expect(w.harness.created.at(-1)!.system).toMatch(/WORKTREE-WRITE/i);
  });
});

describe("trust-scoped project config (M3.5 Tier C)", () => {
  async function assign(w: World, id: string): Promise<void> {
    await w.manager.handleEvent({ kind: "command", conv: conv(id), author: architect, name: "assign", args: "" });
  }
  function trust(w: World, trusted: boolean): void {
    w.store.upsertRepo({
      name: "testrepo",
      path: repoPath,
      defaultBranch: "main",
      safeBashAllowlist: ["git status"],
      landCmd: "echo land-ran",
      deployCmd: "echo deploy-ran",
      trusted,
    });
  }

  test("a trusted repo loads project config for its turns and says so in the intro", async () => {
    const w = makeWorld();
    trust(w, true);
    const c = conv("tc1.000001");
    await assign(w, "tc1.000001");
    expect(w.surface.posts.at(-1)!.text).toMatch(/trusted repo/i);
    await w.manager.handleEvent({ kind: "message", conv: c, author: architect, text: "hi", attachments: [] });
    expect(w.harness.allTurns.at(-1)!.harness?.projectConfig).toBe(true);
  });

  test("an untrusted repo (default) keeps project config off and stays isolated", async () => {
    const w = makeWorld(); // testrepo untrusted by default
    const c = conv("tc2.000001");
    await assign(w, "tc2.000001");
    expect(w.surface.posts.at(-1)!.text).not.toMatch(/trusted repo/i);
    await w.manager.handleEvent({ kind: "message", conv: c, author: architect, text: "hi", attachments: [] });
    expect(w.harness.allTurns.at(-1)!.harness?.projectConfig).toBe(false);
  });

  test("flipping a repo to untrusted takes project config off on the next turn", async () => {
    const w = makeWorld();
    trust(w, true);
    const c = conv("tc3.000001");
    await assign(w, "tc3.000001");
    await w.manager.handleEvent({ kind: "message", conv: c, author: architect, text: "one", attachments: [] });
    expect(w.harness.allTurns.at(-1)!.harness?.projectConfig).toBe(true);
    trust(w, false); // admin revokes trust; the very next turn is isolated again
    await w.manager.handleEvent({ kind: "message", conv: c, author: architect, text: "two", attachments: [] });
    expect(w.harness.allTurns.at(-1)!.harness?.projectConfig).toBe(false);
  });
});

describe("architect auto-approve (M3.8)", () => {
  const writeCall = { id: "tu-w", name: "Write", input: { file_path: "hello.txt", content: "hi" } };

  async function assignAndScript(w: World, id: string, author: Principal, calls: any[]): Promise<void> {
    await w.manager.handleEvent({ kind: "command", conv: conv(id), author: architect, name: "assign", args: "" });
    w.harness.scriptTurn(calls);
    await w.manager.handleEvent({ kind: "message", conv: conv(id), author, text: "do the thing", attachments: [] });
  }

  test("an architect's own gated write auto-approves — no Approve click (default on)", async () => {
    const w = makeWorld();
    await assignAndScript(w, "aa00.000001", architect, [writeCall]);
    const session = w.store.getSessionByConversation("fake", "aa00.000001")!;
    expect(w.surface.approvalRequests.length).toBe(0);
    expect(w.harness.executed.map((c) => c.name)).toEqual(["Write"]);
    expect(w.store.hasPendingApproval(session.id)).toBe(false);
    const audit = w.store.listAudit(session.id);
    const auto = audit.find((a) => a.event === "auto_approved");
    expect(auto?.actor).toBe("fake:U_ARCH"); // attributed to the architect, not "agent"
    expect(audit.some((a) => a.event === "tool_call" && (a.detail as any).decision === "allow(auto-approved)")).toBe(true);
    // Ledger completeness: an already-approved approvals row exists, no pending window.
    expect(w.store.getApprovalByToolUse(session.id, "tu-w")?.decision).toBe("approved");
  });

  test("a member's gated write still defers even with auto-approve on (anti-laundering)", async () => {
    const w = makeWorld();
    await assignAndScript(w, "aa10.000001", member, [writeCall]);
    const session = w.store.getSessionByConversation("fake", "aa10.000001")!;
    expect(w.surface.approvalRequests.length).toBe(1);
    expect(w.harness.executed.length).toBe(0);
    expect(w.store.hasPendingApproval(session.id)).toBe(true);
  });

  test("auto-approve off → the architect's own write defers again", async () => {
    const w = makeWorld();
    const c = conv("aa20.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "assign", args: "" });
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "auto-approve", args: "off" });
    w.harness.scriptTurn([writeCall]);
    await w.manager.handleEvent({ kind: "message", conv: c, author: architect, text: "go", attachments: [] });
    expect(w.surface.approvalRequests.length).toBe(1);
    expect(w.harness.executed.length).toBe(0);
  });

  test("hard-deny still refuses under auto-approve (out-of-worktree write)", async () => {
    const w = makeWorld();
    await assignAndScript(w, "aa30.000001", architect, [{ id: "tu-esc", name: "Write", input: { file_path: "/etc/evil", content: "x" } }]);
    expect(w.surface.approvalRequests.length).toBe(0); // not gated...
    expect(w.harness.executed.length).toBe(0); // ...and not executed — denied by the floor
    expect(w.surface.transcript().some((t) => t.includes("outside your worktree"))).toBe(true);
  });

  test("bash and production-data auto-approve for an architect (the user's 'everything')", async () => {
    const w = makeWorld();
    await assignAndScript(w, "aa40.000001", architect, [
      { id: "tu-bash", name: "Bash", input: { command: "rm build" } }, // non-allowlisted, not hard-deny
      { id: "tu-psql", name: "Bash", input: { command: "psql -c 'select count(*) from users'" } }, // production-data
    ]);
    expect(w.surface.approvalRequests.length).toBe(0);
    expect(w.harness.executed.map((c) => c.id)).toEqual(["tu-bash", "tu-psql"]);
  });

  test("a weak-identity surface never auto-approves, even for an architect (§4)", async () => {
    const w = makeWorld(undefined, { identityStrength: "weak" });
    await assignAndScript(w, "aa45.000001", architect, [writeCall]);
    expect(w.surface.approvalRequests.length).toBe(1); // authority only from verified surfaces
    expect(w.harness.executed.length).toBe(0);
  });

  test("an approved member turn's follow-on call still gates — the decider isn't laundered", async () => {
    const w = makeWorld();
    await assignAndScript(w, "aa50.000001", member, [writeCall]);
    const requestId = w.surface.lastApprovalRequestId()!;
    // The agent emits a NEW gated call during the resumed (empty-prompt) turn.
    w.harness.scriptResume([{ id: "tu-w2", name: "Write", input: { file_path: "again.txt", content: "y" } }]);
    const before = w.surface.approvalRequests.length;
    await w.manager.handleEvent({ kind: "approval_decision", requestId, decider: architect, decision: "approved" });
    // The approved call ran; the follow-on must NOT auto-approve (initiator carried is
    // the MEMBER, not the approving architect) — it defers into a fresh approval.
    expect(w.harness.executed.map((c) => c.id)).toContain("tu-w");
    expect(w.harness.executed.map((c) => c.id)).not.toContain("tu-w2");
    expect(w.surface.approvalRequests.length).toBe(before + 1);
  });

  test("auto-approve toggle: an architect sets it; a member is refused", async () => {
    const w = makeWorld();
    const c = conv("aa60.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "assign", args: "" });
    expect(w.store.getSessionByConversation("fake", "aa60.000001")!.auto_approve).toBe(1); // default on
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "auto-approve", args: "off" });
    const session = w.store.getSessionByConversation("fake", "aa60.000001")!;
    expect(session.auto_approve).toBe(0);
    expect(w.store.listAudit(session.id).some((a) => a.event === "auto_approve_set")).toBe(true);
    // A member cannot toggle it.
    await w.manager.handleEvent({ kind: "command", conv: c, author: member, name: "auto-approve", args: "on" });
    expect(w.store.getSessionByConversation("fake", "aa60.000001")!.auto_approve).toBe(0);
    expect(w.surface.posts.at(-1)!.text).toContain("Only architects");
    expect(w.store.listAudit(session.id).some((a) => a.event === "authz_denied")).toBe(true);
  });
});

describe("role delegation — grant/revoke (M3.8)", () => {
  const abby = "fake:U_ABBY";
  const abbyP: Principal = { surface: "fake", externalId: "U_ABBY" };

  test("an architect grants architect in this channel only; the grantee gains authority", async () => {
    const w = makeWorld();
    await w.manager.handleEvent({ kind: "command", conv: conv("g00.000001"), author: architect, name: "grant", args: `${abby} architect` });
    expect(w.store.isArchitect(abby, "C1")).toBe(true); // this channel
    expect(w.store.isArchitect(abby, "C_OTHER")).toBe(false); // not global
    expect(w.surface.posts.at(-1)!.text).toContain("Granted");
  });

  test("grant everywhere → architect across channels", async () => {
    const w = makeWorld();
    await w.manager.handleEvent({ kind: "command", conv: conv("g10.000001"), author: architect, name: "grant", args: `${abby} architect everywhere` });
    expect(w.store.isArchitect(abby, "C1")).toBe(true);
    expect(w.store.isArchitect(abby, "C_ANY")).toBe(true);
  });

  test("a member cannot grant", async () => {
    const w = makeWorld();
    await w.manager.handleEvent({ kind: "command", conv: conv("g20.000001"), author: member, name: "grant", args: `${abby} architect` });
    expect(w.store.isArchitect(abby, "C1")).toBe(false);
    expect(w.surface.posts.at(-1)!.text).toContain("Only architects");
  });

  test("an unresolved target (sentinel ?) posts a friendly error and writes nothing", async () => {
    const w = makeWorld();
    await w.manager.handleEvent({ kind: "command", conv: conv("g30.000001"), author: architect, name: "grant", args: "? architect" });
    expect(w.surface.posts.at(-1)!.text.toLowerCase()).toContain("couldn't find");
    expect(w.store.roleOf("?", "C1")).toBe("member");
  });

  test("a bad role token shows usage and writes nothing", async () => {
    const w = makeWorld();
    await w.manager.handleEvent({ kind: "command", conv: conv("g40.000001"), author: architect, name: "grant", args: `${abby} wizard` });
    expect(w.surface.posts.at(-1)!.text).toContain("Usage");
    expect(w.store.isArchitect(abby, "C1")).toBe(false);
  });

  test("revoke removes a grant; a config architect cannot be revoked at runtime", async () => {
    const w = makeWorld();
    const c = conv("g50.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "grant", args: `${abby} architect` });
    expect(w.store.isArchitect(abby, "C1")).toBe(true);
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "revoke", args: abby });
    expect(w.store.isArchitect(abby, "C1")).toBe(false);
    // U_ARCH's authority is config-sourced — a runtime revoke can't remove it.
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "revoke", args: "fake:U_ARCH" });
    expect(w.surface.posts.at(-1)!.text).toContain("comes from config");
    expect(w.store.isArchitect("fake:U_ARCH", "C1")).toBe(true);
  });

  test("grant cannot shadow-demote a config architect", async () => {
    const w = makeWorld();
    await w.manager.handleEvent({ kind: "command", conv: conv("g60.000001"), author: architect, name: "grant", args: "fake:U_ARCH member" });
    expect(w.surface.posts.at(-1)!.text).toContain("set by config");
    expect(w.store.isArchitect("fake:U_ARCH", "C1")).toBe(true); // still architect
  });

  test("a granted architect can approve a member's gated action", async () => {
    const w = makeWorld();
    const c = conv("g70.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "assign", args: "" });
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "grant", args: `${abby} architect` });
    w.harness.scriptTurn([{ id: "tu-mw", name: "Write", input: { file_path: "m.txt", content: "x" } }]);
    await w.manager.handleEvent({ kind: "message", conv: c, author: member, text: "add file", attachments: [] });
    const requestId = w.surface.lastApprovalRequestId()!;
    await w.manager.handleEvent({ kind: "approval_decision", requestId, decider: abbyP, decision: "approved" });
    expect(w.harness.executed.map((x) => x.name)).toContain("Write");
  });

  test("a runtime grant cannot flip/overwrite a config architect's row — no lockout (review 2026-07-19)", async () => {
    const w = makeWorld(); // U_ARCH is a config architect at '*'
    const c = conv("g80.000001");
    // Attempt the exploit: grant architect OVER the config architect (skips the old
    // demote-only guard) then revoke to delete the flipped row.
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "grant", args: "fake:U_ARCH architect everywhere" });
    expect(w.surface.posts.at(-1)!.text).toContain("set by config");
    // The row must remain source='config' (not flipped to 'grant').
    expect(w.store.getRoleRow("fake:U_ARCH", "*")).toEqual({ role: "architect", source: "config" });
    // And a follow-up revoke cannot remove the (still config) architect.
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "revoke", args: "fake:U_ARCH everywhere" });
    expect(w.store.isArchitect("fake:U_ARCH", "C1")).toBe(true);
    expect(w.store.getRoleRow("fake:U_ARCH", "*")).toEqual({ role: "architect", source: "config" });
  });

  test("granting a config-member architect in one channel is still allowed (additive, not an overwrite)", async () => {
    const w = makeWorld();
    // Seed abby as a config MEMBER globally, then elevate to architect in C1 only.
    w.store.setRole(abby, "member"); // config-sourced '*' member
    await w.manager.handleEvent({ kind: "command", conv: conv("g85.000001"), author: architect, name: "grant", args: `${abby} architect` });
    expect(w.store.isArchitect(abby, "C1")).toBe(true); // elevated in this channel
    expect(w.store.isArchitect(abby, "C2")).toBe(false); // still member elsewhere
    expect(w.store.getRoleRow(abby, "*")).toEqual({ role: "member", source: "config" }); // config row untouched
  });

  test("revoke at the wrong scope hints at scope, not config (review 2026-07-19)", async () => {
    const w = makeWorld();
    const c = conv("g90.000001");
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "grant", args: `${abby} architect everywhere` });
    // Revoke WITHOUT `everywhere` — scope is the channel, where no grant row lives.
    await w.manager.handleEvent({ kind: "command", conv: c, author: architect, name: "revoke", args: abby });
    const msg = w.surface.posts.at(-1)!.text;
    expect(msg).not.toContain("comes from config"); // must not misdirect to config
    expect(msg).toContain("everywhere"); // hints at the correct scope
    expect(w.store.isArchitect(abby, "C1")).toBe(true); // the grant is intact
  });
});

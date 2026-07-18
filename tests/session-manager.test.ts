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
  s.upsertRepo({ name: "testrepo", path: repoPath, defaultBranch: "main" });
  const surface = new FakeSurface();
  const harness = new FakeHarness();
  const manager = new SessionManager(s, harness, new WorktreeManager(worktreesRoot), () => {});
  manager.registerSurface(surface);
  return { store: s, surface, harness, manager };
}

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
    // Gate ran and allowed the read-only tool.
    expect(w.surface.updates.at(-1)?.text).toContain("gate=allow");
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
    expect(second.status).toBe("active");
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

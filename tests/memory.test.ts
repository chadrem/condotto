import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { mkdirSync, rmSync, existsSync, symlinkSync, writeFileSync, linkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryManager, verifyMemoryTarget } from "../src/core/memory";

const ROOT = join(tmpdir(), `condotto-memory-test-${process.pid}`);
const memRoot = join(ROOT, "memory");

const repo = { name: "acme", path: join(ROOT, "repos", "acme") };
const OTHER = { name: "acme", path: join(ROOT, "repos", "acme-two") };

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(repo.path, { recursive: true });
  mkdirSync(OTHER.path, { recursive: true });
});

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("MemoryManager.pathFor", () => {
  test("is stable, absolute, and inside the memory root", () => {
    const m = new MemoryManager(memRoot);
    const a = m.pathFor(repo, "C123");
    expect(a).toBe(m.pathFor(repo, "C123"));
    expect(a.startsWith(memRoot + "/")).toBe(true);
  });

  test("scopes by CHANNEL — roles are channel-scoped, so memory must be too", () => {
    const m = new MemoryManager(memRoot);
    expect(m.pathFor(repo, "C123")).not.toBe(m.pathFor(repo, "C999"));
  });

  test("two repos with the same name but different paths never share a directory", () => {
    // The collision that a name-derived directory would cause: config allows mixed
    // case and macOS is case-insensitive, so keying on the name would silently
    // merge distinct repos' memories.
    const m = new MemoryManager(memRoot);
    expect(m.pathFor(repo, "C1")).not.toBe(m.pathFor(OTHER, "C1"));
  });

  test("a name differing only in case does not collide on a case-insensitive filesystem", () => {
    const m = new MemoryManager(memRoot);
    const lower = m.pathFor({ name: "acme", path: repo.path }, "C1");
    const upper = m.pathFor({ name: "ACME", path: OTHER.path }, "C1");
    expect(lower.toLowerCase()).not.toBe(upper.toLowerCase());
  });
});

describe("MemoryManager.prepare", () => {
  test("creates the directory and reports a clean sweep", async () => {
    const m = new MemoryManager(memRoot);
    const r = await m.prepare(repo, "C1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(existsSync(r.path)).toBe(true);
    expect(r.swept).toEqual([]);
  });

  test("is idempotent and preserves existing memories", async () => {
    const m = new MemoryManager(memRoot);
    const first = await m.prepare(repo, "C1");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    writeFileSync(join(first.path, "MEMORY.md"), "- [a fact](a.md) — hook\n");
    const second = await m.prepare(repo, "C1");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.path).toBe(first.path);
    expect(existsSync(join(second.path, "MEMORY.md"))).toBe(true);
  });

  test("SWEEPS a symlink planted in the memory root — the exploit the design turns on", async () => {
    // Containment is lexical, so `<memory>/r -> /` would make an auto-allowed
    // `Read <memory>/r/etc/passwd` lexically legal for every later thread in the
    // channel, forever. The link must not survive session start.
    const m = new MemoryManager(memRoot);
    const first = await m.prepare(repo, "C1");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    symlinkSync("/", join(first.path, "r"));
    expect(existsSync(join(first.path, "r", "etc"))).toBe(true); // the hole is real

    const again = await m.prepare(repo, "C1");
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.swept).toContain("r");
    expect(existsSync(join(again.path, "r"))).toBe(false);
  });

  test("sweeps a symlink nested below the root without following it", async () => {
    const m = new MemoryManager(memRoot);
    const first = await m.prepare(repo, "C1");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    mkdirSync(join(first.path, "notes"), { recursive: true });
    symlinkSync("/etc", join(first.path, "notes", "escape"));

    const again = await m.prepare(repo, "C1");
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.swept).toContain(join("notes", "escape"));
    expect(existsSync(join(first.path, "notes", "escape"))).toBe(false);
    // The real directory around it survives — a sweep is surgical, not a wipe.
    expect(existsSync(join(first.path, "notes"))).toBe(true);
  });

  test("leaves ordinary memory files completely alone", async () => {
    const m = new MemoryManager(memRoot);
    const first = await m.prepare(repo, "C1");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    mkdirSync(join(first.path, "sub"), { recursive: true });
    writeFileSync(join(first.path, "a-fact.md"), "body");
    writeFileSync(join(first.path, "sub", "b-fact.md"), "body");

    const again = await m.prepare(repo, "C1");
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.swept).toEqual([]);
    expect(existsSync(join(first.path, "a-fact.md"))).toBe(true);
    expect(existsSync(join(first.path, "sub", "b-fact.md"))).toBe(true);
  });
});

describe("MemoryManager.remove", () => {
  test("deletes one (repo, channel) directory and leaves its siblings", async () => {
    const m = new MemoryManager(memRoot);
    const a = await m.prepare(repo, "C1");
    const b = await m.prepare(repo, "C2");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    expect(await m.remove(repo, "C1")).toBe(true);
    expect(existsSync(a.path)).toBe(false);
    expect(existsSync(b.path)).toBe(true);
  });

  test("removing a directory that was never created is a no-op, not an error", async () => {
    const m = new MemoryManager(memRoot);
    expect(await m.remove(repo, "never")).toBe(true);
  });
});

describe("verifyMemoryTarget — the per-call proof that actually holds", () => {
  // The sweep is a start-of-turn snapshot; the agent keeps making calls after it,
  // and its shell can plant a link mid-turn with any program (the `ln` floor
  // catches `ln`, not `python3 -c 'os.symlink(...)'`). So the real control asks
  // per call, against the filesystem. These are the attacks it has to stop.
  async function prepared() {
    const m = new MemoryManager(memRoot);
    const r = await m.prepare(repo, "C1");
    if (!r.ok) throw new Error(r.reason);
    return r.path;
  }

  test("an ordinary memory file passes, and a not-yet-created one does too", async () => {
    const dir = await prepared();
    writeFileSync(join(dir, "a-fact.md"), "body");
    expect((await verifyMemoryTarget(dir, join(dir, "a-fact.md"))).ok).toBe(true);
    expect((await verifyMemoryTarget(dir, join(dir, "brand-new.md"))).ok).toBe(true);
  });

  test("a SYMLINK planted mid-turn is refused even though its path looks legal", async () => {
    const dir = await prepared();
    symlinkSync("/etc/passwd", join(dir, "leak.md"));
    const r = await verifyMemoryTarget(dir, join(dir, "leak.md"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("symlink");
  });

  test("a HARD LINK is refused — realpath cannot see it, only the link count can", async () => {
    const dir = await prepared();
    const victim = join(ROOT, "victim.txt");
    writeFileSync(victim, "secret");
    linkSync(victim, join(dir, "notes.md"));
    const r = await verifyMemoryTarget(dir, join(dir, "notes.md"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("hard link");
  });

  test("anything not directly inside the root is refused", async () => {
    const dir = await prepared();
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "sub", "a.md"), "x");
    expect((await verifyMemoryTarget(dir, join(dir, "sub", "a.md"))).ok).toBe(false);
    expect((await verifyMemoryTarget(dir, "/etc/passwd")).ok).toBe(false);
  });

  test("a directory is not a memory file", async () => {
    const dir = await prepared();
    mkdirSync(join(dir, "weird.md"), { recursive: true });
    expect((await verifyMemoryTarget(dir, join(dir, "weird.md"))).ok).toBe(false);
  });
});

describe("MemoryManager.prepare — sweep hardening", () => {
  test("a hard link is swept, not just symlinks", async () => {
    const m = new MemoryManager(memRoot);
    const first = await m.prepare(repo, "C1");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const victim = join(ROOT, "victim2.txt");
    writeFileSync(victim, "secret");
    linkSync(victim, join(first.path, "notes.md"));

    const again = await m.prepare(repo, "C1");
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.swept).toContain("notes.md");
    expect(existsSync(join(first.path, "notes.md"))).toBe(false);
  });

  test("an UNREADABLE subdirectory fails closed — it is removed, not skipped", async () => {
    // Skipping it was a hole: `chmod 000` on a subdirectory hid a symlink from
    // every future sweep. Nothing legitimate here is unreadable; Condotto owns it.
    const m = new MemoryManager(memRoot);
    const first = await m.prepare(repo, "C1");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    mkdirSync(join(first.path, "d"), { recursive: true });
    symlinkSync("/", join(first.path, "d", "r"));
    chmodSync(join(first.path, "d"), 0o000);

    const again = await m.prepare(repo, "C1");
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    // The whole unreadable directory is gone, link and all.
    expect(existsSync(join(first.path, "d"))).toBe(false);
    expect(again.swept).toContain("d");
  });
});

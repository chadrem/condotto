import { createHash } from "node:crypto";
import { chmod, mkdir, lstat, readdir, realpath, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

// Memory manager: one Condotto-owned memory directory per (repo, channel).
//
// This is the ONE place the agent may write outside its worktree, so it is also
// the one place that has to earn it.
//
// WHY IT EXISTS. The SDK's auto-memory feature loads `MEMORY.md` into the system
// prompt at session start and the agent maintains it with ordinary Write/Edit.
// Its default location is keyed on the SANITIZED CWD (`sdk.d.ts:6378`) — and every
// Condotto session has its own worktree cwd that is destroyed at teardown, so the
// default would silently discard every memory. Pointing `autoMemoryDirectory` at a
// stable, Condotto-owned path is what makes memory persist at all.
//
// WHY (repo, channel) AND NOT (repo). `roles.scope` is `channel_id | '*'`, so a
// per-repo store would let content written under one channel's authority load into
// another channel's sessions, crossing the boundary authority itself is scoped to.
// A channel is the natural working context, so this keeps the value and respects
// the existing scoping.
//
// HOW THE LEXICAL GAP IS CLOSED — three layers, in order of how much they carry.
// `offendingPath` in the policy engine is purely LEXICAL (never realpath), a
// deliberate documented trade that only holds while nothing inside a containment
// root can point outside it. The worktree earns that: `verifyWorkdir` proves it and
// the tree dies at teardown. A memory root earns it neither way — it is
// agent-writable and it is meant to OUTLIVE every worktree.
//
//  1. SHAPE (`isMemoryFile`, policy.ts). A memory path must be a `.md` file
//     DIRECTLY in the root. No path can traverse THROUGH anything planted there,
//     which is what turned `<memory>/r -> /` into a general host-read channel.
//  2. PER-CALL PROOF (`verifyMemoryTarget`, below, called from the session
//     manager's gate). Resolves the actual file at the moment of use and refuses
//     symlinks, hard links, and anything not really inside the root.
//  3. SWEEP (`prepare`, below). Hygiene: clears planted links between turns and
//     surfaces them in the audit.
//
// Layer 2 is the one that holds. The original design leaned on layer 3 alone and
// that was wrong (review 2026-07-20): a sweep is a start-of-turn SNAPSHOT, while
// the agent goes on making tool calls after it, its shell can plant a link with any
// program at all (the `ln` floor catches `ln`, not `python3 -c 'os.symlink(...)'`),
// hard links were never swept, and a session whose own repo has memory OFF carries
// no memory floor and can plant one from outside. None of that is reachable when
// the question is asked per call, against the filesystem.
//
// Bash is also floored against this path in the policy engine (the agent does reach
// for `cat MEMORY.md` unprompted — observed in the spike), but that floor is a
// literal substring match and therefore best-effort: `~/…` and relative spellings
// slip past it. It is a convenience rail, NOT a boundary — layer 2 is the boundary.

/** A memory root that has been proven safe to hand to the policy engine. */
export type MemoryCheck =
  | { ok: true; path: string; swept: string[] }
  | { ok: false; reason: string };

export class MemoryManager {
  constructor(private root: string) {}

  /**
   * Stable absolute memory directory for one (repo, channel) pair.
   *
   * Keyed on a hash of the repo's path plus the channel id, NOT on the repo NAME:
   * `config.ts` allows mixed case in a name and macOS is case-insensitive, so
   * `Acme` and `acme` — two genuinely distinct repos — would land on one directory
   * and silently share memories. The name is kept only as a lowercase prefix so an
   * operator inspecting the directory can tell what it belongs to; the hash carries
   * all of the uniqueness.
   */
  pathFor(repo: { name: string; path: string }, channelId: string): string {
    const digest = createHash("sha256")
      .update(resolve(repo.path))
      .update("\0")
      .update(channelId)
      .digest("hex")
      .slice(0, 12);
    return resolve(join(this.root, `${repo.name.toLowerCase()}-${digest}`));
  }

  /**
   * Create the memory directory if needed and prove it is safe to use as a
   * containment root: it must resolve inside our own root, and it must contain no
   * symlinks. Any symlink found is REMOVED rather than tolerated — a link is never
   * legitimate content here (memory is `.md` files) and leaving one would keep the
   * lexical-containment hole open. Removed paths are returned so the caller can
   * audit them; a sweep is a security event, not routine housekeeping.
   *
   * Returns `ok: false` rather than throwing, so a failure disables memory for the
   * session instead of failing the turn.
   */
  async prepare(repo: { name: string; path: string }, channelId: string): Promise<MemoryCheck> {
    const path = this.pathFor(repo, channelId);
    const root = resolve(this.root);
    // Defence in depth: the path is derived from a hash, so this cannot fire for a
    // real call — but it means no future caller can widen the boundary by accident.
    if (!path.startsWith(root + sep)) {
      return { ok: false, reason: `memory path is not under the memory root: ${path}` };
    }
    try {
      await mkdir(path, { recursive: true });
      // The directory itself must not BE (or sit behind) a link out of the root.
      const realRoot = await realpath(root);
      const realPath = await realpath(path);
      if (realPath !== realRoot && !realPath.startsWith(realRoot + sep)) {
        return { ok: false, reason: `memory directory resolves outside the memory root: ${realPath}` };
      }
      const swept = await sweepSymlinks(realPath, realPath);
      return { ok: true, path: realPath, swept };
    } catch (err) {
      return { ok: false, reason: `could not prepare the memory directory: ${err}` };
    }
  }

  /**
   * Delete one (repo, channel) memory directory. Best-effort and idempotent, and
   * confined the same way `WorktreeManager.remove` is: never touches anything that
   * is not strictly under our root. Memory deliberately OUTLIVES a session — this is
   * for an operator discarding a repo's memory, not for session teardown.
   */
  async remove(repo: { name: string; path: string }, channelId: string): Promise<boolean> {
    const path = this.pathFor(repo, channelId);
    const root = resolve(this.root);
    if (!path.startsWith(root + sep)) {
      throw new Error(`refusing to remove a memory path that is not strictly under the root: ${path}`);
    }
    await rm(path, { recursive: true, force: true }).catch(() => {});
    return !existsSync(path);
  }
}

/**
 * Verify ONE memory target immediately before the call that uses it runs.
 *
 * This is the control that actually holds, and `prepare`'s sweep is only hygiene
 * around it. A start-of-turn sweep is a snapshot: the agent makes many tool calls
 * after it, and its shell can plant a link mid-turn with any program at all (the
 * `ln` floor catches `ln`, not `python3 -c 'os.symlink(...)'`). A second session
 * whose repo has memory off carries no memory floor and can plant one from
 * outside. So the question has to be asked per call, against the filesystem, at
 * the moment of use (review 2026-07-20).
 *
 * Three things are checked, and each closes a demonstrated attack:
 *  - **symlink** (`lstat`, never followed) — `<mem>/leak.md -> /etc/passwd`.
 *  - **hard link** (`nlink > 1`) — a hardlink has no separate "real" path, so
 *    `realpath` cannot see it; only the link count can.
 *  - **realpath containment** — the file, and the directory it will be created in,
 *    must still resolve inside the root, which also covers a swapped root.
 *
 * A target that does not exist yet is fine (that is a new memory), but its PARENT
 * must be the memory root itself, resolved for real.
 */
export async function verifyMemoryTarget(
  memoryRoot: string,
  absTarget: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const root = resolve(memoryRoot);
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return { ok: false, reason: "the memory directory is not available" };
  }
  const target = resolve(absTarget);
  if (dirname(target) !== realRoot && dirname(target) !== root) {
    return { ok: false, reason: `"${absTarget}" is not directly inside the memory directory` };
  }
  const st = await lstat(target).catch(() => null);
  if (st === null) return { ok: true }; // a new memory file; parent already proven
  if (st.isSymbolicLink()) {
    return { ok: false, reason: `"${absTarget}" is a symlink, which is never a real memory file` };
  }
  if (!st.isFile()) {
    return { ok: false, reason: `"${absTarget}" is not a regular file` };
  }
  if (st.nlink > 1) {
    return { ok: false, reason: `"${absTarget}" is a hard link to another file, so it is not memory` };
  }
  const real = await realpath(target).catch(() => null);
  if (real === null || dirname(real) !== realRoot) {
    return { ok: false, reason: `"${absTarget}" does not really resolve inside the memory directory` };
  }
  return { ok: true };
}

/**
 * Remove every symlink and hard link at or below `dir`, returning what was removed.
 *
 * Hygiene, not the security control — `verifyMemoryTarget` is that, because a sweep
 * cannot see what happens after it returns. It still runs so a planted link does
 * not sit in the directory indefinitely, and so an operator sees it in the audit.
 *
 * Fails CLOSED: a directory it cannot read is REMOVED rather than skipped. Skipping
 * was a hole — `chmod 000` on a subdirectory hid a symlink from every future sweep.
 * Nothing legitimate here is unreadable; Condotto owns this tree.
 *
 * Recurses only into REAL directories (a symlink is deleted, never followed), and is
 * depth-capped so a deep tree cannot turn a per-turn sweep into unbounded work.
 */
async function sweepSymlinks(dir: string, base: string, depth = 0): Promise<string[]> {
  const removed: string[] = [];
  const rel = (p: string) => p.slice(base.length + 1);
  if (depth > 8) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return [rel(dir)];
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // Unreadable: cannot prove what is inside, so it does not get to stay.
    // `chmod` first — `rm -r` cannot delete through a directory it cannot traverse,
    // which is exactly the state an attacker would leave it in.
    if (depth > 0) {
      await chmod(dir, 0o700).catch(() => {});
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      return [rel(dir)];
    }
    return removed;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    // Trust lstat over the dirent: it is the check that cannot be fooled by the
    // entry type, and it never follows the link.
    const st = await lstat(full).catch(() => null);
    if (st === null) continue;
    if (st.isSymbolicLink() || (st.isFile() && st.nlink > 1)) {
      await rm(full, { force: true }).catch(() => {});
      removed.push(rel(full));
      continue;
    }
    if (st.isDirectory()) removed.push(...(await sweepSymlinks(full, base, depth + 1)));
  }
  return removed;
}

import { basename, extname, join } from "node:path";
import { DirectTreeIO, type TreeIO } from "./tree-io";

// Files moving in and out of a thread.
//
// Both directions go through the WORKTREE rather than through the model's
// context, and that is the whole design. An inbound file is written to
// `.condotto/attachments/` and the agent opens it with the ordinary Read tool;
// an outbound file is one the agent wrote to `.condotto/outbox/`. So the
// existing worktree confinement is the only boundary either direction needs —
// no second path around `policy.ts`, no base64 in the prompt, and it works the
// same for a screenshot, a CSV and a 40 MB heap dump.
//
// `.condotto/` is already in the repo's `info/exclude` (see `worktrees.ts`), so
// neither directory can ride a `git add -A` into a commit.
//
// Every access below goes through a `TreeIO`, never a bare fs call: both
// directories are the agent's to shape, and in sandbox mode the daemon touching
// them with its own privileges is how a planted symlink would become an upload of
// the daemon's own state. See `tree-io.ts`.

/** Inbound files land here, relative to the worktree root. */
export const ATTACHMENTS_REL = join(".condotto", "attachments");
/** Anything the agent leaves here is posted to the thread, then deleted. */
export const OUTBOX_REL = join(".condotto", "outbox");

// There is deliberately NO size or count limit in either direction. Whatever
// someone put in the thread is what the agent gets, and whatever the agent
// produced is what the thread gets. A cap here would drop a file the person
// meant to send, which is worse than a slow turn or a big worktree — and the
// worktree is disposable anyway.

/**
 * A filename safe to join onto a directory we own.
 *
 * The name comes from whoever uploaded the file, so it is attacker-controlled in
 * exactly the way a path must never be: `../../.ssh/authorized_keys` would escape
 * the worktree, and a newline or a bracket would let it forge a line in the
 * framed prompt where the paths are announced. Everything is stripped down to a
 * single conservative segment; an empty result gets a positional fallback rather
 * than being dropped, because the agent still needs something to open.
 */
export function safeAttachmentName(raw: string | undefined, index: number): string {
  const base = basename(raw ?? "").replace(/[^A-Za-z0-9._-]/g, "-");
  // A leading dot would hide the file; a run of dots is the traversal shape.
  const cleaned = base.replace(/^\.+/, "").replace(/\.{2,}/g, ".").slice(0, 96);
  if (cleaned === "" || cleaned === ".") {
    // Keep a real extension so the agent can still tell a png from a csv; a name
    // that was nothing but dots has none, and `.` alone is not one.
    const raw_ext = extname(basename(raw ?? "")).slice(0, 8);
    const ext = /^\.[A-Za-z0-9]+$/.test(raw_ext) ? raw_ext : "";
    return `attachment-${index + 1}${ext}`;
  }
  return cleaned;
}

/** A file that made it onto disk, ready to be named to the agent. */
export interface LandedAttachment {
  /** The sanitized filename, as it appears on disk. */
  name: string;
  /** Worktree-relative path, which is what the agent is told. */
  relPath: string;
}

/**
 * Write inbound files into the session's worktree, de-duplicating names so two
 * files called `screenshot.png` in one thread do not overwrite each other.
 *
 * Best-effort per file: one that fails to download must not lose the message it
 * arrived with, so the failure is reported and the rest still land.
 */
export async function landAttachments(
  worktree: string,
  files: { name?: string; bytes: Uint8Array | null }[],
  io: TreeIO = new DirectTreeIO(),
): Promise<{ landed: LandedAttachment[]; failed: string[] }> {
  const landed: LandedAttachment[] = [];
  const failed: string[] = [];
  if (files.length === 0) return { landed, failed };

  const dir = join(worktree, ATTACHMENTS_REL);
  try {
    await io.mkdirp(dir);
  } catch {
    return { landed, failed: files.map((f, i) => safeAttachmentName(f.name, i)) };
  }

  // Every entry claims its name, symlinks included, so a landing never writes
  // through a link the agent left here.
  const taken = new Set<string>((await io.listNames(dir)) ?? []);
  for (const [i, file] of files.entries()) {
    const wanted = safeAttachmentName(file.name, i);
    if (file.bytes === null) {
      failed.push(wanted);
      continue;
    }
    const name = uniqueName(wanted, taken);
    taken.add(name);
    try {
      await io.writeFile(join(dir, name), file.bytes);
      landed.push({ name, relPath: join(ATTACHMENTS_REL, name) });
    } catch {
      failed.push(name);
    }
  }
  return { landed, failed };
}

/** `report.csv` -> `report-2.csv` when the name is already on disk. */
function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

/** A file the agent left in the outbox, ready to post. */
export interface OutboxFile {
  name: string;
  absPath: string;
  sizeBytes: number;
}

/**
 * Everything the agent left in the outbox this turn, oldest first.
 *
 * Only regular files DIRECTLY in the directory qualify. A subdirectory or a
 * symlink is skipped rather than followed: the agent can create either one (both
 * are ordinary in-worktree writes), and following a link here would post a file
 * from outside the tree into the thread — the one exfiltration route this feature
 * could otherwise open.
 */
export async function readOutbox(worktree: string, io: TreeIO = new DirectTreeIO()): Promise<OutboxFile[]> {
  const dir = join(worktree, OUTBOX_REL);
  const entries = await io.listFiles(dir); // regular, non-symlink files only
  if (entries === null) return [];
  return (
    entries
      // A zero-byte upload is not a thing Slack accepts, so skipping it avoids a
      // guaranteed error post. Everything with content goes, however big.
      .filter((e) => e.sizeBytes > 0)
      .map((e) => ({ name: e.name, absPath: join(dir, e.name), sizeBytes: e.sizeBytes }))
      .sort((a, b) => a.name.localeCompare(b.name))
  );
}

/** Empty the outbox. Called after posting, so the next turn starts clean. */
export async function clearOutbox(worktree: string, io: TreeIO = new DirectTreeIO()): Promise<void> {
  await io.remove(join(worktree, OUTBOX_REL));
}

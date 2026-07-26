// Attachments smoke: files in and out, through the REAL adapter and the REAL
// policy engine.
//
// The unit tests cover the plumbing — sanitizing a name, landing bytes, refusing
// a symlink in the outbox. What they cannot answer is the only question that
// matters in production: does the model, told about these two directories in its
// system prompt, actually READ the file it was handed and WRITE the one it was
// asked for? That is prompt compliance, and it is only measurable live.
//
// Assertions are against the FILESYSTEM and the reply text, not the transcript.
//   Run: bun run smoke:attachments   (needs working Claude auth)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { smokeEnv } from "./smoke-fixture";
import { WorktreeManager } from "../src/core/worktrees";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code/adapter";
import { ATTACHMENTS_REL, OUTBOX_REL, landAttachments, readOutbox } from "../src/core/attachments";
import { evaluate } from "../src/core/policy";
import type { GateFn } from "../src/core/types";

const env = await smokeEnv();
const repo = env.repo;
const worktrees = new WorktreeManager(env.worktreesRoot);
const worktree = await worktrees.create({
  repoPath: repo.path,
  defaultBranch: repo.defaultBranch,
  sessionId: crypto.randomUUID(),
});
console.log(`[smoke] worktree: ${worktree.path}`);

// The real policy engine — an attachment read and an outbox write are ordinary
// in-worktree calls, so nothing here should need a carve-out. If either denies,
// the design is wrong and this catches it.
let denials: string[] = [];
const gate: GateFn = async (call) => {
  const d = evaluate(call, { worktree: worktree.path });
  const target = (call.input as Record<string, unknown> | null)?.file_path ?? "";
  console.log(`[gate] ${call.name} ${String(target).slice(0, 60)} -> ${d.action}`);
  if (d.action === "deny") denials.push(`${call.name} ${String(target).slice(0, 60)}`);
  return d.action === "allow" ? { decision: "allow" } : { decision: "deny", reason: d.reason };
};

// ------------------------------------------------------------ inbound: land it
const CSV = "region,errors\nemea,4\napac,117\namer,9\n";
const { landed, failed } = await landAttachments(worktree.path, [
  { name: "error-counts.csv", bytes: new TextEncoder().encode(CSV) },
]);
if (failed.length > 0 || landed.length !== 1) {
  console.error(`[smoke] FAIL: could not land the fixture attachment (${failed.join(", ")})`);
  process.exit(1);
}
console.log(`[smoke] planted ${landed[0]!.relPath}`);

const adapter = new ClaudeCodeAdapter();
const session = await adapter.create({
  cwd: worktree.path,
  system:
    "You are Condotto (attachments smoke). Be terse.\n" +
    `- Files people attach are saved under ${ATTACHMENTS_REL}/ and each message names the path.\n` +
    `- To send a file back, write it to ${OUTBOX_REL}/ and finish your turn.`,
});

let reply = "";
for await (const ev of session.turn(
  {
    text:
      `[condotto:event v=1 kind=message user=slack:U_SMOKE]\n` +
      `This person attached a file. Condotto has already saved it into your worktree at the\n` +
      `path below — open it with Read when the message calls for it:\n` +
      `  ${landed[0]!.relPath}\n\n` +
      `Which region has the most errors? Then write a one-line summary to ` +
      `${OUTBOX_REL}/summary.md and tell me you did.`,
    harness: { model: "fable", effort: "low", subagents: false, workflows: false },
  },
  gate,
)) {
  if (ev.kind === "reply") reply = ev.text;
  if (ev.kind === "error") console.log(`[error] ${ev.message}`);
}
console.log(`\n[reply] ${reply.slice(0, 300)}`);

// ----------------------------------------------------------------- assertions
const readIt = /apac/i.test(reply); // only knowable by opening the file
const outbox = await readOutbox(worktree.path);
const wroteIt = outbox.some((f) => f.name === "summary.md");
const summaryText = wroteIt ? await Bun.file(join(worktree.path, OUTBOX_REL, "summary.md")).text() : "";

console.log(`\n[smoke] the agent READ the attachment (named apac):   ${readIt}`);
console.log(`[smoke] the agent WROTE to the outbox:                ${wroteIt}`);
console.log(`[smoke] no policy denials on either path:             ${denials.length === 0}`);
if (denials.length > 0) console.log(`[smoke]   denied: ${denials.join(" | ")}`);
if (wroteIt) console.log(`[smoke] outbox content: ${JSON.stringify(summaryText.slice(0, 120))}`);

// The outbox must hold a real file, not a link out of the tree.
mkdirSync(join(worktree.path, OUTBOX_REL), { recursive: true });
writeFileSync(join(worktree.path, OUTBOX_REL, ".probe"), "x");
const probeSeen = (await readOutbox(worktree.path)).some((f) => f.name === ".probe");

if (!readIt || !wroteIt || denials.length > 0 || !probeSeen) {
  console.error("[smoke] FAIL — see the checks above");
  process.exit(1);
}
console.log("\n[smoke] PASS — a planted file was read, and a requested file reached the outbox");
process.exit(0);

// M3 smoke (DESIGN §7): prove multiple in-process query() sessions run
// concurrently under load on the REAL claude-code adapter + subscription auth.
// Spins up N sessions, each in its own worktree of the throwaway repo, and runs
// one turn per session concurrently; asserts all reply, with DISTINCT session
// ids (no cross-talk) and no interleaving of session state.
//
// Run: bun run smoke:concurrency   (optionally: N=6 bun run smoke:concurrency)
import { loadConfig } from "../src/core/config";
import { WorktreeManager } from "../src/core/worktrees";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code/adapter";
import type { GateFn, SessionHandle, TurnEvent } from "../src/core/types";

const N = Math.max(2, Number(process.env.N ?? 4));
const config = loadConfig();
const repo = config.repos.find((r) => r.name === "testrepo") ?? config.repos[0]!;
const worktrees = new WorktreeManager(config.worktreesRoot);
const adapter = new ClaudeCodeAdapter();

// Read-only turn: allow reads, gate everything else (nothing should gate here).
const gate: GateFn = async (call) =>
  ["Read", "Glob", "Grep", "TodoWrite"].includes(call.name)
    ? { decision: "allow" }
    : { decision: "gate" };

async function runOne(i: number): Promise<{ i: number; ok: boolean; sessionId: string | null; reply: string }> {
  const worktree = await worktrees.create({ repoPath: repo.path, defaultBranch: repo.defaultBranch, sessionId: crypto.randomUUID() });
  const session = await adapter.create({ cwd: worktree.path, system: "You are Conduit (concurrency smoke). Be terse." });
  let sessionId: string | null = null;
  let reply = "";
  for await (const ev of session.turn(
    { text: `Reply with exactly this token and nothing else: SESSION_OK_${i}` },
    gate,
  )) {
    const e = ev as TurnEvent & { handle?: SessionHandle };
    if (ev.kind === "handle_updated") sessionId = (ev.handle as { sessionId: string | null }).sessionId;
    if (ev.kind === "reply") reply = ev.text;
    if (ev.kind === "error") reply = `ERROR: ${ev.message}`;
  }
  return { i, ok: reply.includes(`SESSION_OK_${i}`), sessionId, reply: reply.slice(0, 80) };
}

console.log(`[smoke] launching ${N} concurrent real sessions on repo "${repo.name}"…`);
const started = performance.now();
const results = await Promise.all(Array.from({ length: N }, (_, i) => runOne(i)));
const elapsed = ((performance.now() - started) / 1000).toFixed(1);

for (const r of results) console.log(`  session ${r.i}: ok=${r.ok} id=${r.sessionId?.slice(0, 8)} reply=${JSON.stringify(r.reply)}`);

const ids = new Set(results.map((r) => r.sessionId));
const allOk = results.every((r) => r.ok);
const allDistinct = ids.size === N && !ids.has(null);
console.log(`[smoke] ${N} sessions in ${elapsed}s — all replied correctly: ${allOk}; distinct session ids: ${allDistinct}`);
if (!allOk || !allDistinct) {
  console.error("[smoke] FAIL: concurrency produced wrong replies or cross-talk");
  process.exit(1);
}
console.log("[smoke] PASS: in-process query() concurrency holds under load");
process.exit(0);

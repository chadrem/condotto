// M3.5 Tier A smoke: prove the REAL claude-code adapter applies `model` + `effort`
// via query() options on live subscription auth. Runs two trivial read-only turns
// on one session — Opus/high, then a mid-session switch to Fable/low — and confirms
// each completes with a reply and no error. This exercises the exact SDK model IDs
// the adapter maps to (claude-opus-4-8 / claude-fable-5) and the effort levels.
//   Run: bun run smoke:model   (needs ~/tmp/conduit-testrepo + subscription auth)
import { loadConfig } from "../src/core/config";
import { WorktreeManager } from "../src/core/worktrees";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code/adapter";
import type { GateFn } from "../src/core/types";

const config = loadConfig();
const repo = config.repos.find((r) => r.name === "testrepo") ?? config.repos[0]!;
const worktrees = new WorktreeManager(config.worktreesRoot);
const worktree = await worktrees.create({
  repoPath: repo.path,
  defaultBranch: repo.defaultBranch,
  sessionId: crypto.randomUUID(),
});
console.log(`[smoke] worktree: ${worktree.path} (${worktree.branch})`);

// Read-only conversational turns — nothing should gate; allow anything defensively.
const gate: GateFn = async () => ({ decision: "allow" });

const adapter = new ClaudeCodeAdapter();
console.log(`[smoke] adapter supportedModels=${adapter.capabilities.supportedModels.join(",")} supportedEfforts=${adapter.capabilities.supportedEfforts.join(",")}`);
const session = await adapter.create({
  cwd: worktree.path,
  system: "You are Conduit (M3.5 smoke). Answer in one short sentence, no tools.",
});

const cases: { model: string; effort: string }[] = [
  { model: "opus", effort: "high" },
  { model: "fable", effort: "low" },
];

for (const { model, effort } of cases) {
  let reply = "";
  let err = "";
  for await (const ev of session.turn(
    { text: `Reply with exactly the token: model-check-ok`, harness: { model, effort } },
    gate,
  )) {
    if (ev.kind === "reply") reply = ev.text;
    if (ev.kind === "error") err = ev.message;
  }
  console.log(`[smoke] ${model}/${effort} -> reply=${JSON.stringify(reply.slice(0, 80))} err=${JSON.stringify(err)}`);
  if (err || !reply) {
    console.error(`[smoke] FAIL for ${model}/${effort}`);
    process.exit(1);
  }
}
console.log("[smoke] PASS — model + effort applied cleanly through the real adapter");
process.exit(0);

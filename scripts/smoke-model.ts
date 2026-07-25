// model/effort smoke: prove the REAL claude-code adapter applies `model` + `effort`
// via query() options on live auth. Runs two trivial read-only turns on one session
// — the shipped default (Opus 5 / xhigh), then a mid-session switch to Fable/low —
// and confirms each completes with a reply and no error. This exercises the exact
// SDK model IDs the adapter maps to (claude-opus-5 / claude-fable-5) and the effort
// levels, so it is also the check that the sidecar KNOWS `claude-opus-5`: an
// agent-sdk older than 0.3.220 does not, and this turn is where that surfaces.
//   Run: bun run smoke:model   (needs CONDOTTO_SMOKE_REPO + subscription auth)
import { smokeEnv } from "./smoke-fixture";
import { WorktreeManager } from "../src/core/worktrees";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code/adapter";
import type { GateFn } from "../src/core/types";

const env = await smokeEnv();
const repo = env.repo;
const worktrees = new WorktreeManager(env.worktreesRoot);
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
  system: "You are Condotto (smoke). Answer in one short sentence, no tools.",
});

const cases: { model: string; effort: string }[] = [
  { model: "opus", effort: "xhigh" }, // the shipped default posture
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

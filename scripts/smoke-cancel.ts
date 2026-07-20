// smoke: drive BOTH riders through the REAL claude-code adapter (not the
// injectable-query test seam) on subscription auth against the repo named by CONDOTTO_SMOKE_REPO.
//
//   Part A — env-scrub: a real turn runs Bash; the daemon's planted SLACK_*/CONDOTTO_*
//     secrets are absent from the agent shell, while PATH/HOME/toolchain survive.
//   Part B — workflow cancel + cost drain: a real multi-agent workflow launches, we
//     call session.interrupt() mid-run (as `@Condotto cancel` does), and the turn ends
//     with a cancellation notice carrying the DRAINED spend — proving the detached
//     workflow is halted and its cost folded into the ledger.
//
//   Run: bun run smoke:cancel   (needs CONDOTTO_SMOKE_REPO + subscription auth; ~1-2 min)
import { WorktreeManager } from "../src/core/worktrees";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code/adapter";
import { smokeEnv } from "./smoke-fixture";
import type { GateFn } from "../src/core/types";

const env = await smokeEnv();
const repo = env.repo;
const worktrees = new WorktreeManager(env.worktreesRoot);
const adapter = new ClaudeCodeAdapter();

// A gate that allows reads + Bash + the main Workflow launch, denies real writes,
// and confines workflow-agent (agent_id) calls read-only — the shape the daemon runs.
const READ = new Set(["Read", "Glob", "Grep", "TodoWrite"]);
const gate: GateFn = async (call) => {
  if (call.name === "Bash" && !call.agentId) return { decision: "allow" };
  if (call.name === "Workflow" && !call.agentId && !call.escaped) return { decision: "allow" };
  if (READ.has(call.name)) return { decision: "allow" };
  return { decision: "deny", reason: "smoke: read-only" };
};

let failures = 0;

// ---------------- Part A: env-scrub through the real adapter ----------------
console.log("=== Part A — env-scrub the agent shell (real adapter) ===");
process.env.SLACK_BOT_TOKEN = "xoxb-POISON-SHOULD-NOT-LEAK";
process.env.CONDOTTO_POISON = "CONDOTTO-POISON-SHOULD-NOT-LEAK";
process.env.MY_TOOLCHAIN_VAR = "toolchain-keepme";

const wtA = await worktrees.create({ repoPath: repo.path, defaultBranch: repo.defaultBranch, sessionId: crypto.randomUUID() });
const sessionA = await adapter.create({
  cwd: wtA.path,
  system: "Condotto env-scrub smoke. Run the one bash command and report its stdout verbatim. Terse.",
});
const MARK = "ENVPROBE";
let replyA = "";
for await (const ev of sessionA.turn(
  {
    text:
      `Run EXACTLY this bash command and report its stdout verbatim:\n` +
      `  echo "${MARK} slack=[$SLACK_BOT_TOKEN] condotto=[$CONDOTTO_POISON] tool=[$MY_TOOLCHAIN_VAR] home=[$HOME] haspath=[${"${PATH:+yes}"}]"`,
    harness: { model: "fable", effort: "low" },
  },
  gate,
)) {
  if (ev.kind === "reply") replyA = ev.text;
  if (ev.kind === "error") console.log(`  [A error] ${ev.message}`);
}
const lineA = (replyA.match(new RegExp(`${MARK}[^\\n]*`)) ?? [""])[0];
console.log(`  [A] shell view: ${lineA}`);
const aOk =
  !/slack=\[xoxb-POISON/.test(lineA) &&
  !/condotto=\[CONDOTTO-POISON/.test(lineA) &&
  /tool=\[toolchain-keepme\]/.test(lineA) &&
  /home=\[\/.+\]/.test(lineA) &&
  /haspath=\[yes\]/.test(lineA);
console.log(`  Part A ${aOk ? "PASS" : "FAIL"} — secrets scrubbed, toolchain/PATH/HOME preserved\n`);
if (!aOk) failures++;

// ---------------- Part B: workflow cancel + cost drain (real adapter) -------
console.log("=== Part B — cancel a running workflow + drain its cost (real adapter) ===");
const wtB = await worktrees.create({ repoPath: repo.path, defaultBranch: repo.defaultBranch, sessionId: crypto.randomUUID() });
const sessionB = await adapter.create({
  cwd: wtB.path,
  system: "Condotto cancel smoke. You may launch multi-agent workflows for parallel read-only work. Be thorough.",
});
let fired = false;
let sawReply = false;
let cancelText = "";
let cancelCost: number | undefined;
for await (const ev of sessionB.turn(
  {
    text:
      "Launch a multi-agent workflow to deeply audit this repo IN PARALLEL: run SIX agents with " +
      "parallel(), each reads README.md, package.json and all of src/, then writes a long detailed " +
      "multi-paragraph analysis. Then synthesize a final report.",
    harness: { model: "fable", effort: "low", subagents: true, workflows: true },
  },
  gate,
)) {
  if (ev.kind === "progress") {
    // Interrupt a few beats after the workflow is visibly running (as an architect's
    // `@Condotto cancel` would), but only once.
    if (!fired && /workflow/i.test(ev.text)) {
      fired = true;
      setTimeout(() => {
        console.log("  [B] >>> session.interrupt() (mid-workflow, like @Condotto cancel)");
        sessionB.interrupt().catch((e) => console.log(`  [B] interrupt threw: ${e}`));
      }, 5000);
    }
  }
  if (ev.kind === "reply") { sawReply = true; console.log(`  [B] UNEXPECTED reply: ${ev.text.slice(0, 80)}`); }
  if (ev.kind === "error") { cancelText = ev.message; cancelCost = ev.costUsd; }
}
console.log(`  [B] final notice: "${cancelText}"  (cost=$${cancelCost})`);
const bOk =
  fired &&
  /Cancelled/.test(cancelText) &&
  /workflow/.test(cancelText) &&
  typeof cancelCost === "number" &&
  cancelCost > 0 &&
  !sawReply;
console.log(`  Part B ${bOk ? "PASS" : "FAIL"} — running workflow cancelled, spend drained into the notice\n`);
if (!bOk) failures++;

if (failures === 0) {
  console.log("[smoke] PASS — both riders work end-to-end through the real adapter.");
  process.exit(0);
}
console.error(`[smoke] FAIL — ${failures} part(s) failed; see above.`);
process.exit(1);

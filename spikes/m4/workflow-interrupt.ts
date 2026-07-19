// M4 §5 spike (b) — background-workflow cancellation + cost drain.
//
// THE load-bearing questions (M3.6 watch-list, DECISIONS.md 2026-07-19):
//   (B1) Does q.interrupt() cancel a DETACHED background workflow task, and does a
//        final `result` still arrive carrying total_cost_usd so the ledger stays
//        accurate? (Today a wedged workflow turn records ZERO cost and may keep
//        spending after the turn parks.)
//   (B2) Does the SDK `maxBudgetUsd` intra-turn brake actually STOP a running
//        background workflow (→ error_max_budget_usd)? That is the candidate
//        mechanism for "auto-cancel on cap breach".
//   Also observed: do task_progress messages carry an incremental usage signal we
//   could watchdog on?
//
//   Run: bun run spikes/m4/workflow-interrupt.ts   (needs subscription auth; ~1-2 min)
import { query } from "@anthropic-ai/claude-agent-sdk";
import { WorktreeManager } from "../../src/core/worktrees";

const TESTREPO = process.env.HOME + "/tmp/condotto-testrepo";
const worktrees = new WorktreeManager(process.env.HOME + "/tmp/condotto-spike-worktrees");

const READ = new Set(["Read", "Glob", "Grep", "TodoWrite"]);
const SPAWN = new Set(["Agent", "Task", "Workflow"]);

// A hook that allows the main Workflow launch + confined workflow-agent reads,
// denies everything else — the real Condotto read-only posture.
function readOnlyHook(tag: string) {
  return async (hi: unknown) => {
    const h = hi as { tool_name?: string; agent_id?: string };
    const name = h.tool_name ?? "?";
    let allow = false;
    if (!h.agent_id && SPAWN.has(name)) allow = true;
    else if (READ.has(name)) allow = true;
    const dec = allow ? "allow" : "deny";
    return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: dec as "allow" | "deny", permissionDecisionReason: tag } };
  };
}

// A workflow prompt that fans out enough parallel read/analyze work to run for a
// while (so we can interrupt mid-flight).
const WF_PROMPT =
  "Launch a multi-agent workflow to deeply audit this repo IN PARALLEL. Pass a `script` " +
  "beginning with `export const meta = {...}` that runs SIX agents with parallel(): each " +
  "agent uses Read to read README.md, package.json, and every file under src/, then writes a " +
  "thorough multi-paragraph analysis of code quality, edge cases, and possible bugs. Make each " +
  "agent's analysis long and detailed. Then synthesize all six into a final report.";

async function runWorkflow(opts: {
  label: string;
  interruptAfterFirstProgress?: boolean;
  maxBudgetUsd?: number;
}): Promise<{
  sawTaskStarted: boolean;
  taskId: string | null;
  workflowName: string | null;
  progressCount: number;
  progressAfterInterrupt: number;
  lastTaskTokens: number;
  finalResult: { subtype: string; terminal?: string; cost?: number } | null;
  msFromInterruptToDone: number | null;
}> {
  const wt = await worktrees.create({ repoPath: TESTREPO, defaultBranch: "main", sessionId: crypto.randomUUID() });
  const q = query({
    prompt: WF_PROMPT,
    options: {
      cwd: wt.path,
      systemPrompt: { type: "preset", preset: "claude_code", append: `Condotto ${opts.label}. Workflow tool available. Be thorough.` },
      allowedTools: [],
      disallowedTools: ["ExitPlanMode", "SlashCommand", "WebFetch", "WebSearch"],
      permissionMode: "bypassPermissions",
      model: "claude-fable-5",
      effort: "low",
      settingSources: [],
      ...(opts.maxBudgetUsd ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
      hooks: { PreToolUse: [{ hooks: [readOnlyHook(opts.label)] }] },
      canUseTool: async (t: string) => ({ behavior: "deny" as const, message: opts.label }),
    },
  });

  let sawTaskStarted = false;
  let taskId: string | null = null;
  let workflowName: string | null = null;
  let progressCount = 0;
  let progressAfterInterrupt = 0;
  let lastTaskTokens = 0;
  let interruptedAt: number | null = null;
  let interruptScheduled = false;
  let finalResult: { subtype: string; terminal?: string; cost?: number } | null = null;

  const iterator = (q as AsyncIterable<Record<string, any>>)[Symbol.asyncIterator]();
  for (;;) {
    let step: IteratorResult<Record<string, any>>;
    try {
      step = await iterator.next();
    } catch (e) {
      // After an interrupt/abort the SDK can THROW on the pull that follows the
      // terminal result (observed: [ede_diagnostic] ... stop_reason=tool_use).
      // We've already captured the final result + cost by then — treat as done.
      console.log(`  [${opts.label}] iterator.next() threw after terminal (expected post-interrupt): ${String(e).slice(0, 80)}`);
      break;
    }
    if (step.done) break;
    const m = step.value;
    if (m.type === "system" && m.subtype === "task_started") {
      sawTaskStarted = true;
      taskId = m.task_id ?? null;
      workflowName = m.workflow_name ?? null;
      console.log(`  [${opts.label}] task_started id=${m.task_id} type=${m.task_type} name=${m.workflow_name}`);
    } else if (m.type === "system" && m.subtype === "task_progress") {
      progressCount++;
      if (interruptedAt) progressAfterInterrupt++;
      const tok = m.usage?.total_tokens ?? 0;
      if (tok > lastTaskTokens) lastTaskTokens = tok;
      if (progressCount <= 3 || progressCount % 5 === 0)
        console.log(`  [${opts.label}] task_progress #${progressCount} desc="${String(m.description ?? "").slice(0, 50)}" tokens=${tok}`);
      // (B1) trigger: interrupt a few seconds after the workflow is visibly working.
      if (opts.interruptAfterFirstProgress && !interruptScheduled) {
        interruptScheduled = true;
        setTimeout(() => {
          interruptedAt = Date.now();
          console.log(`  [${opts.label}] >>> calling q.interrupt() now (mid-workflow)`);
          q.interrupt().catch((e) => console.log(`  [${opts.label}] interrupt() threw: ${e}`));
        }, 4000);
      }
    } else if (m.type === "system" && m.subtype === "task_notification") {
      console.log(`  [${opts.label}] task_notification status=${m.status} id=${m.task_id} tokens=${m.usage?.total_tokens}`);
    } else if (m.type === "result") {
      finalResult = { subtype: m.subtype, terminal: m.terminal_reason, cost: m.total_cost_usd };
      console.log(`  [${opts.label}] RESULT subtype=${m.subtype} terminal=${m.terminal_reason} cost=$${m.total_cost_usd}`);
    }
  }
  const msFromInterruptToDone = interruptedAt ? Date.now() - interruptedAt : null;
  return { sawTaskStarted, taskId, workflowName, progressCount, progressAfterInterrupt, lastTaskTokens, finalResult, msFromInterruptToDone };
}

// Gate each sub-test so a re-run can exercise just one (each ~$0.50-0.80).
//   ONLY=B1 → interrupt test ; ONLY=B2 → maxBudgetUsd test ; unset → both.
const ONLY = process.env.ONLY;

// ================= (B1) interrupt a running workflow =====================
let b1 = { sawTaskStarted: false, taskId: null as string | null, workflowName: null as string | null, progressCount: 0, progressAfterInterrupt: 0, lastTaskTokens: 0, finalResult: null as any, msFromInterruptToDone: null as number | null };
if (ONLY !== "B2") {
  console.log("=== (B1) interrupt a DETACHED background workflow mid-run ===");
  b1 = await runWorkflow({ label: "B1-interrupt", interruptAfterFirstProgress: true });
  console.log();
}

// ================= (B2) maxBudgetUsd brake on a workflow =================
let b2 = { finalResult: null as any } as Awaited<ReturnType<typeof runWorkflow>>;
if (ONLY !== "B1") {
  const b2Budget = Number(process.env.B2_BUDGET ?? "0.02");
  console.log(`=== (B2) maxBudgetUsd=$${b2Budget} on a workflow (auto-cancel-on-breach candidate) ===`);
  b2 = await runWorkflow({ label: "B2-maxbudget", maxBudgetUsd: b2Budget });
  console.log();
}

console.log("================ WORKFLOW-INTERRUPT SPIKE RESULTS ================");
console.log(`(B1) saw task_started (workflow ran as bg task):   ${b1.sawTaskStarted} (name=${b1.workflowName}, task_id=${b1.taskId})`);
console.log(`(B1) task_progress carried a token usage signal:   ${b1.lastTaskTokens > 0} (peak tokens seen ${b1.lastTaskTokens})`);
console.log(`(B1) a final result arrived AFTER interrupt:       ${!!b1.finalResult} subtype=${b1.finalResult?.subtype} terminal=${b1.finalResult?.terminal}`);
console.log(`(B1) that result carried a drainable cost:          ${typeof b1.finalResult?.cost === "number"} ($${b1.finalResult?.cost})`);
console.log(`(B1) progress events AFTER interrupt (want ~0):     ${b1.progressAfterInterrupt}`);
console.log(`(B1) ms from interrupt to query done:              ${b1.msFromInterruptToDone}`);
console.log(`(B2) workflow stopped by maxBudgetUsd:             subtype=${b2.finalResult?.subtype} terminal=${b2.finalResult?.terminal} cost=$${b2.finalResult?.cost}`);
console.log("=================================================================\n");

const b1DrainsCost = !!b1.finalResult && typeof b1.finalResult.cost === "number";
const b1Stops = b1.progressAfterInterrupt <= 2; // interrupt actually halts the bg task
console.log(`[spike] (B1) interrupt drains cost: ${b1DrainsCost} ; interrupt halts the bg task: ${b1Stops}`);
console.log(`[spike] (B2) maxBudgetUsd brakes a workflow: ${b2.finalResult?.subtype === "error_max_budget_usd" || b2.finalResult?.terminal === "budget_exhausted"}`);
console.log("[spike] DONE — record the mechanism (interrupt+drain vs close) and whether maxBudgetUsd is the auto-cancel lever in DECISIONS.md.");
process.exit(0);

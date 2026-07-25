// smoke: prove PLAN MODE works end to end through the REAL adapter and the REAL
// policy engine — the whole product loop, not the units.
//
// What it exercises, in the order the daemon does it:
//   1. plan mode ON  — the adapter runs permissionMode:"plan" with an absolute
//      plansDirectory inside the worktree; reads run; an ordinary write is DENIED
//      by our policy (not gated — nobody should be asked to approve one mid-plan);
//   2. the PLAN arrives as the plan-file WRITE, gated with concern
//      "plan-approval", and the whole plan text is readable in its `content`;
//   3. approval — plan mode goes OFF and the session RESUMES with an empty prompt,
//      the deferred write re-drives and is allowed from the recorded decision;
//   4. the agent IMPLEMENTS: the real code change lands in the worktree.
//
// The assertions are against the FILESYSTEM, not the transcript. An agent that
// says it wrote a file and did not is exactly the failure this has to catch.
//
//   Run: bun run smoke:plan   (needs CONDOTTO_SMOKE_REPO + working auth)
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { smokeEnv } from "./smoke-fixture";
import { WorktreeManager } from "../src/core/worktrees";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code/adapter";
import { evaluate, isPlanPresentation, planTextFrom, type PolicyContext } from "../src/core/policy";
import type { GateFn, ToolCall } from "../src/core/types";

const env = await smokeEnv();
const repo = env.repo;
const worktrees = new WorktreeManager(env.worktreesRoot);
const worktree = await worktrees.create({
  repoPath: repo.path,
  defaultBranch: repo.defaultBranch,
  sessionId: crypto.randomUUID(),
});
const plansDir = join(worktree.path, ".condotto", "plans");
const FORBIDDEN = join(worktree.path, "PLAN_MODE_SHOULD_NOT_WRITE.txt");
console.log(`[smoke] worktree:  ${worktree.path}`);
console.log(`[smoke] plans dir: ${plansDir}`);

// Observations, all of which have to hold for a PASS.
let planWriteGated = false; // the plan reached the gate as a plan
let planTextSeen = ""; // and carried readable plan text
let ordinaryWriteDenied = false; // an ordinary write was DENIED, not gated
let readAllowedWhilePlanning = false;
let deferredId = ""; // the tool_use_id the approval is recorded against

/** Stands in for the approvals table: tool_use_id -> architect's decision. */
const approved = new Set<string>();

/** Plan mode is a per-turn posture, exactly as the session manager treats it. */
let planMode = true;
/**
 * Architect self-approve, which is ON by default in a real thread. Modelled only
 * AFTER the plan is approved, which is exactly the shipped posture: the plan
 * itself is never auto-approved (that exemption is the feature), and the
 * implementation that follows runs on the architect's standing authority.
 */
let autoApprove = false;

const gate: GateFn = async (call: ToolCall) => {
  // The prior-approval short-circuit, i.e. the resume half of the handshake.
  if (call.id && approved.has(call.id)) {
    console.log(`[gate] ${call.name} -> allow (architect-approved)`);
    return { decision: "allow" };
  }
  const ctx: PolicyContext = {
    worktree: worktree.path,
    safeBashAllowlist: ["git status"],
    subagentsEnabled: true,
    ...(planMode ? { planMode: true, plansDir } : {}),
  };
  const d = evaluate(call, ctx);
  const isPlan = planMode && isPlanPresentation(call, plansDir, worktree.path);
  const tag = isPlan ? "PLAN" : call.agentId ? `sub(${call.agentId.slice(0, 6)})` : "main";
  console.log(`[gate] ${tag} ${call.name} -> ${d.action}${d.concern ? ` (${d.concern})` : ""}`);

  if (planMode) {
    if ((call.name === "Read" || call.name === "Glob" || call.name === "Grep") && d.action === "allow") {
      readAllowedWhilePlanning = true;
    }
    if (call.name === "Write" && !isPlan && d.action === "deny") ordinaryWriteDenied = true;
    if (isPlan && d.action === "gate" && d.concern === "plan-approval") {
      planWriteGated = true;
      planTextSeen = planTextFrom(call.input) ?? "";
      deferredId = call.id;
    }
  }
  // Architect auto-approve. Never reached while planning: the plan-approval gate
  // is exempt by design, and everything else in plan mode is a deny, not a gate.
  if (d.action === "gate" && autoApprove && d.concern !== "plan-approval") {
    console.log(`[gate] ${call.name} -> allow (auto-approved, architect's own turn)`);
    return { decision: "allow" };
  }
  return d.action === "allow"
    ? { decision: "allow" }
    : d.action === "deny"
      ? { decision: "deny", reason: d.reason }
      : { decision: "gate" };
};

const adapter = new ClaudeCodeAdapter();
const session = await adapter.create({
  cwd: worktree.path,
  system:
    "You are Condotto (plan-mode smoke). Be terse. When you are planning, write your plan " +
    "to your plan file — that is how you present it for approval.",
});

// ---------------------------------------------------------------- 1 + 2: plan
console.log("\n=== phase 1: plan mode ON ===");
for await (const ev of session.turn(
  {
    text:
      "Add a `subtract` function to src/ledger.ts, next to `add`. First, as a check, try to " +
      "create a file PLAN_MODE_SHOULD_NOT_WRITE.txt with the Write tool and just report whether " +
      "it was refused. Then read src/ledger.ts and write up your plan.",
    harness: { model: "fable", effort: "low", subagents: true, planMode: true, plansDir },
  },
  gate,
)) {
  if (ev.kind === "progress") console.log(`[progress] ${ev.text}`);
  if (ev.kind === "reply") console.log(`[reply] ${ev.text.slice(0, 400)}`);
  if (ev.kind === "deferred") console.log(`[deferred] ${ev.call.name} id=${ev.call.id}`);
  if (ev.kind === "error") console.log(`[error] ${ev.message}`);
}

console.log(`\n[smoke] a read ran while planning:                    ${readAllowedWhilePlanning}`);
console.log(`[smoke] an ordinary write was DENIED (not gated):      ${ordinaryWriteDenied}`);
console.log(`[smoke] the ordinary write did NOT land:               ${!existsSync(FORBIDDEN)}`);
console.log(`[smoke] the PLAN gated with concern plan-approval:     ${planWriteGated}`);
console.log(`[smoke] the plan text is readable (${planTextSeen.length} chars)`);
if (planTextSeen) console.log(`[smoke] plan opens: ${JSON.stringify(planTextSeen.slice(0, 160))}`);

// ------------------------------------------------------- 3 + 4: approve, build
let implemented = false;
let planFileLanded = false;
if (planWriteGated && deferredId) {
  console.log("\n=== phase 2: architect approves -> plan mode OFF, resume, implement ===");
  approved.add(deferredId); // the architect clicked Approve
  planMode = false; // ...which is what clears the mode, before the resume
  autoApprove = true; // and the thread's default posture governs the work that follows

  for await (const ev of session.turn(
    {
      text: "", // empty prompt: the resume half of the defer handshake
      harness: { model: "fable", effort: "low", subagents: true },
    },
    gate,
  )) {
    if (ev.kind === "progress") console.log(`[progress] ${ev.text}`);
    if (ev.kind === "reply") console.log(`[reply] ${ev.text.slice(0, 400)}`);
    if (ev.kind === "deferred") console.log(`[deferred] ${ev.call.name} id=${ev.call.id}`);
    if (ev.kind === "error") console.log(`[error] ${ev.message}`);
  }

  planFileLanded = existsSync(plansDir) && readdirSync(plansDir).some((f) => f.endsWith(".md"));
  const ledger = join(worktree.path, "src", "ledger.ts");
  implemented = existsSync(ledger) && (await Bun.file(ledger).text()).includes("subtract");
}

console.log(`\n[smoke] the approved plan file landed:                 ${planFileLanded}`);
console.log(`[smoke] the agent IMPLEMENTED (src/ledger.ts changed):  ${implemented}`);

const ok =
  readAllowedWhilePlanning &&
  ordinaryWriteDenied &&
  !existsSync(FORBIDDEN) &&
  planWriteGated &&
  planTextSeen.length > 40 &&
  implemented;

if (!ok) {
  console.error("[smoke] FAIL — see the checks above");
  process.exit(1);
}
console.log(
  "[smoke] PASS — plan mode: read-only while planning, the plan gated and readable, " +
    "approval resumed into a real code change. Through the real adapter and the real policy.",
);
process.exit(0);

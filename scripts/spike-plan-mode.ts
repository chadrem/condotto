// SPIKE: what does `permissionMode: "plan"` actually do to Condotto's gate?
// (Step 0 of the plan-mode plan — blocks the implementation.)
//
// The design rests on facts read from sdk.d.ts, not observed. This repo's rule is
// spike-first (CLAUDE.md; DECISIONS 2026-07-19 "re-spike the primitive before
// accepting it"), and at least three of the assumptions would change the design
// if wrong — so we find out before writing any of it.
//
// Questions (Q1 gates shipping at all; Q2/Q6 gate the SDK-native design):
//   Q1  Does PreToolUse still fire under permissionMode:"plan", and does a
//       `defer` still produce deferred_tool_use on the result? The entire gate —
//       and therefore the entire product — rests on this. If NO, plan mode ships
//       Condotto-native instead (permissionMode stays "default", policy denies
//       every gate-tier call, the plan arrives as an ordinary reply).
//   Q2  Does the model emit ExitPlanMode once it leaves disallowedTools, and
//       WHICH KEY holds the plan text? ExitPlanModeInput (sdk-tools.d.ts:568) is
//       `{allowedPrompts?: deprecated} & [k:string]: unknown` — the field name is
//       not in the type, so it must be observed. Condotto renders that key into
//       Slack as the thing an architect approves.
//   Q3  Does the CLI make the model WRITE a plan file, and where? The default is
//       ~/.claude/plans/ (sdk.d.ts:6414) — OUTSIDE the worktree, which policy.ts
//       hard-denies with no approval possible, so the agent would be stuck. Does
//       the write route through PreToolUse at all? Does settings.plansDirectory
//       relocate it, and does a RELATIVE value resolve against cwd or the
//       worktree root? (They differ for a monorepo session.)
//   Q4  Does planModeInstructions reach the model and replace the workflow body,
//       and can it suppress the plan-file convention?
//   Q5  Is conversation_reset emitted on plan exit, and does session_id change?
//       Condotto persists {v:1, sessionId, ...} and resumes from it
//       (adapter.ts:79-94, :771); the adapter drops unknown message types on the
//       floor (:918-1060). A silent fork strands the thread's context.
//   Q6  After an approved defer, does a RESUMED query with permissionMode
//       "default" actually implement? Run it twice — with ExitPlanMode still in
//       context and with it back in disallowedTools, which is what production
//       does the instant plan_mode flips to 0. The second probe decides whether
//       the `planExit` turn option is required or merely defensive.
//   Q7  What do Write/Edit/Bash do under "plan" — denied above our hook, or
//       delivered to it? If they reach the hook AND execute when we allow, then
//       Condotto's own policy narrowing is the ONLY thing keeping a planning
//       session read-only, not defence in depth.
//   Q8  Do subagents run under plan mode (and carry agent_id)? Does maxBudgetUsd
//       still brake a plan turn? Is xhigh effort accepted?
//
// Drives the SDK directly rather than through ClaudeCodeAdapter, on purpose: the
// adapter has no plan-mode support yet, and a spike must not require shipping
// production code to run. Options otherwise mirror adapter.ts:760-848.
//
// Throwaway fixture only — never a real repo (CLAUDE.md build-time safety).
//
// RESULTS — run 2026-07-25, agent-sdk 0.3.220 / claude-code 2.1.220. Recorded here
// as well as in DECISIONS.md so a re-run has something to diff against:
//
//   Q1a YES  The PreToolUse hook fires under permissionMode:"plan".
//   Q1b YES  A `defer` still yields deferred_tool_use (terminal_reason=tool_deferred).
//            THE GATE HOLDS UNDER PLAN MODE — the ship condition.
//   Q1c YES  The empty-prompt resume re-drives the deferred call, still under plan mode.
//
//   Q2  ***  THE ONE THAT CHANGES THE DESIGN ***
//       Q2a NO   The model does NOT emit ExitPlanMode even with the tool removed from
//                disallowedTools. It says so itself — "ExitPlanMode isn't available in
//                this session" — and its own ToolSearch returned "No matching deferred
//                tools found". The plan-exit tool simply is not in the headless tool
//                registry, so `disallowedTools` was never what was blocking it.
//       Q2d YES  The headless plan protocol is a FILE: the model writes the plan to
//                `plansDirectory`, and THAT Write routes through PreToolUse carrying the
//                whole plan as `tool_input.content` (819-849 chars of markdown, observed).
//     ⇒ The plan-file WRITE is the approval trigger, not ExitPlanMode. It is a better
//       one: same proven defer→approve→resume handshake, and the plan text arrives as
//       an ordinary tool input instead of via a tool whose schema declines to name it.
//       `planTextFrom` reads `content`; the ExitPlanMode branch stays as forward-compat
//       so a future SDK that restores the tool gates instead of silently exiting.
//   Q2c YES  Today's BASE_DISALLOWED does prevent plan exit — vacuously, per Q2a.
//
//   Q3a YES  The CLI writes a plan file, by default to ~/.claude/plans/ — OUTSIDE the
//            worktree, where policy.ts hard-denies with no approval possible.
//   Q3b YES  That write DOES route through PreToolUse, so our policy sees it.
//   Q3c YES  An ABSOLUTE settings.plansDirectory relocates it into the worktree.
//   Q3d YES  A RELATIVE one resolves against `cwd`, NOT the worktree root — so a
//            monorepo session would put plans under the sub-project. Use an absolute
//            path built from the worktree root.
//
//   Q4a YES  planModeInstructions reaches the model (nonce echoed).
//   Q4b YES  It can suppress the plan file entirely — but we do NOT want that any more:
//            per Q2d the file write is how the plan reaches Condotto.
//   Q4c      The wrapper still says "you MUST NOT make any edits (with the exception of
//            the plan file mentioned below)" — the plan file IS the sanctioned exception.
//
//   Q5a NO   No conversation_reset is emitted when the plan is approved.
//   Q5b NO   The session_id does not change across the approval.
//     ⇒ The opaque handle stays valid. The suspected silent session fork does not exist,
//       and the adapter needs no conversation_reset branch.
//   Q5c      A resume after the approval still has the plan in context.
//
//   Q6a YES  The approved plan resumes into REAL implementation — asserted against the
//            file, not the transcript: src/ledger.ts gained `subtract`. Design condition.
//   Q6b YES  The re-driven plan-file write lands once plan mode is off.
//     NOTE   The resume must ALLOW the re-driven write (what the real prior-approval
//            short-circuit does). Deferring it a second time reads to the model as
//            "the user said no" — "STOP what you are doing and wait" — and ends the
//            turn. An earlier version of this probe did exactly that and reported a
//            false NO on Q6a.
//
//   Q7a YES  A Write under plan mode reaches our hook.
//   Q7b NO   It does NOT execute even when our hook allows it — the SDK refuses above
//            us. So SDK plan mode is a real second layer, and our policy deny is
//            defence in depth rather than the sole control. It stays load-bearing
//            anyway: it is what makes the READ-ONLY guarantee ours rather than
//            borrowed, and it is the only layer that covers allowlisted bash and the
//            worktree-write opt-in.
//
//   Q8a YES  Subagents run under plan mode and their calls carry agent_id (observed:
//            `[hook] Grep (agent_id=…)`), so read-only fan-out survives planning.
//   Q8x      P8 crashed the CLI subprocess ("Claude Code process exited with code 1")
//            at maxBudgetUsd 0.25 with subagents + xhigh. Not reproduced or diagnosed;
//            re-check before relying on a tight budget with a subagent fan-out.
//
// Run: bun run scripts/spike-plan-mode.ts          (everything)
//      bun run scripts/spike-plan-mode.ts q1       (one section: q1 q2 q3 q4 q56 q7 q8)
import { query } from "@anthropic-ai/claude-agent-sdk";
import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { smokeHome } from "./smoke-fixture";
import { WorktreeManager } from "../src/core/worktrees";

// --- tokens ---------------------------------------------------------------
// Distinctive, greppable, and unguessable-by-accident, so "did this text reach
// the model?" is never a judgement call.
const T = {
  instr: "CONDOTTO_PLAN_INSTR_5E1D",
  wrote: "PLAN_MODE_WROTE_A_FILE_8C4A",
} as const;

/** `bun run scripts/spike-plan-mode.ts q1` re-runs only the named sections. */
const ONLY = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const want = (tag: string) => ONLY.length === 0 || ONLY.includes(tag);

const root = join(smokeHome(), "plan-spike");
const repoPath = join(root, "repo");
const worktreesRoot = join(root, "worktrees");
/** The SDK's default plan-file home — outside any worktree, which is the problem. */
const defaultPlansDir = join(homedir(), ".claude", "plans");

const FIXTURE: Record<string, string> = {
  "README.md": "# plan-spike\n\nA throwaway repo for the plan-mode spike.\n",
  "src/ledger.ts": "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
  // A monorepo-shaped sub-project, so Q3 can tell "project root" from cwd.
  "apps/report/index.ts": "export const REPORT = 'stub';\n",
};

async function git(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${err.trim() || out.trim()}`);
  return out;
}

async function ensureFixture(path: string): Promise<void> {
  if (!existsSync(join(path, ".git"))) {
    mkdirSync(path, { recursive: true });
    await git(["init", "-q", "-b", "main"], path);
  } else {
    await git(["worktree", "prune"], path);
    await git(["reset", "-q", "--hard"], path);
    await git(["clean", "-qfd"], path);
  }
  for (const [rel, content] of Object.entries(FIXTURE)) await Bun.write(join(path, rel), content);
  await git(["add", "-A"], path);
  if ((await git(["status", "--porcelain"], path)).trim() !== "") {
    await git(
      ["-c", "user.email=spike@condotto.invalid", "-c", "user.name=Condotto Spike", "commit", "-qm", "fixture"],
      path,
    );
  }
}

/** Every file under a directory, relative — so we can see what plan mode produced. */
function walk(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, base));
    else out.push(full.slice(base.length + 1));
  }
  return out;
}

/** Files that appeared under `dir` since `before`. */
function newFiles(dir: string, before: string[]): string[] {
  const now = walk(dir);
  const seen = new Set(before);
  return now.filter((f) => !seen.has(f));
}

// --- observation ----------------------------------------------------------

interface Seen {
  tool: string;
  detail: string;
  agentId: string | undefined;
  decision: string;
}

const findings: { q: string; verdict: string; detail: string }[] = [];
const record = (q: string, ok: boolean | null, detail: string) => {
  const verdict = ok === null ? "INCONCLUSIVE" : ok ? "YES" : "NO";
  findings.push({ q, verdict, detail });
  console.log(`\n[result] ${q}: ${verdict} — ${detail}`);
};

/** Condotto's real base posture. ExitPlanMode is removed per-probe. */
const BASE_DISALLOWED = ["ExitPlanMode", "SlashCommand", "WebFetch", "WebSearch"];
const PLAN_EXIT_TOOL = "ExitPlanMode";
const READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "TodoWrite"];

/** Mirrors adapter.ts:150-162 so Q8 tests the shape production actually ships. */
const SUBAGENT_DEFS = {
  explorer: {
    description: "Read-only exploration: reads, searches, and summarizes the codebase in parallel.",
    prompt:
      "You are a read-only exploration subagent. Use Read/Glob/Grep to investigate the working " +
      "tree and report concise, specific findings. Stay within the working tree.",
    tools: ["Read", "Glob", "Grep", "TodoWrite"],
  },
};

interface ProbeResult {
  reply: string;
  seen: Seen[];
  /** EVERY system/init session_id, in order — a fork shows up as a second entry. */
  sessionIds: string[];
  resets: { newConversationId: string; sessionId: string }[];
  costUsd: number | undefined;
  resultSubtype: string | undefined;
  terminalReason: string | undefined;
  deferred: { id: string; name: string; input: Record<string, unknown> } | null;
  /** tool_result blocks, so "did the model get a coherent result?" is evidence, not prose. */
  toolResults: { toolUseId: string; content: string }[];
  raw: string[];
}

type GateMode = "allow" | "gate-reads" | "gate-writes" | "gate-exit" | "gate-planfile";

async function probe(opts: {
  label: string;
  prompt: string;
  cwd: string;
  root?: string;
  resume?: string;
  planMode: boolean;
  /** Drop ExitPlanMode from disallowedTools (production does this only in plan mode). */
  allowExitPlanMode: boolean;
  planModeInstructions?: string;
  plansDirectory?: string;
  gate: GateMode;
  subagents?: boolean;
  effort?: string;
  budgetUsd?: number;
}): Promise<ProbeResult> {
  console.log(`\n${"=".repeat(78)}\n=== ${opts.label} ===`);
  console.log(
    `    planMode=${opts.planMode} exitTool=${opts.allowExitPlanMode ? "in-context" : "disallowed"} ` +
      `gate=${opts.gate} resume=${opts.resume ? "yes" : "no"} ` +
      `plansDir=${opts.plansDirectory ?? "(default)"} subagents=${opts.subagents ?? false}`,
  );
  console.log(`    cwd: ${opts.cwd}`);
  console.log(`    prompt: ${JSON.stringify(opts.prompt.slice(0, 120))}`);

  const seen: Seen[] = [];
  const raw: string[] = [];
  const sessionIds: string[] = [];
  const resets: { newConversationId: string; sessionId: string }[] = [];
  const toolResults: { toolUseId: string; content: string }[] = [];

  const gateHook = async (hookInput: unknown, _toolUseID: string | undefined) => {
    const call = hookInput as { tool_name?: string; tool_input?: unknown; agent_id?: string };
    const name = call.tool_name ?? "unknown";
    const input = (call.tool_input ?? {}) as Record<string, unknown>;
    const detail = String(
      input.file_path ?? input.path ?? input.command ?? input.pattern ?? "",
    ).slice(0, 90);

    // Q2's answer lives here: dump the whole ExitPlanMode input, since the SDK
    // type declines to name the key that carries the plan.
    if (name === PLAN_EXIT_TOOL) {
      console.log(`[exitplanmode] input keys: ${JSON.stringify(Object.keys(input))}`);
      for (const [k, v] of Object.entries(input)) {
        console.log(`[exitplanmode]   ${k}: ${typeof v}${typeof v === "string" ? ` len=${v.length}` : ""}`);
      }
      console.log(`[exitplanmode] raw: ${JSON.stringify(input).slice(0, 1500)}`);
    }

    const readOnly = READ_ONLY_TOOLS.includes(name);
    // The plan-FILE write is the real approval trigger (ExitPlanMode does not
    // exist headless — see the RESULTS block), so this is production's shape:
    // defer the one write plan mode permits, and read the plan out of its input.
    // Computed from the RAW input, never from `detail` — that is truncated to 90
    // chars for logging, and a worktree path alone can exceed it.
    const rawPath = typeof input.file_path === "string" ? input.file_path : "";
    const isPlanFile =
      (name === "Write" || name === "Edit") &&
      opts.plansDirectory !== undefined &&
      rawPath.startsWith(opts.plansDirectory) &&
      rawPath.endsWith(".md");
    if (isPlanFile) {
      const content = typeof input.content === "string" ? input.content : "";
      console.log(`[planfile] ${rawPath}`);
      console.log(`[planfile] content len=${content.length}; first 300: ${JSON.stringify(content.slice(0, 300))}`);
    }
    const shouldDefer =
      (opts.gate === "gate-reads" && readOnly) ||
      (opts.gate === "gate-writes" && !readOnly) ||
      (opts.gate === "gate-exit" && name === PLAN_EXIT_TOOL) ||
      (opts.gate === "gate-planfile" && isPlanFile);

    seen.push({ tool: name, detail, agentId: call.agent_id, decision: shouldDefer ? "defer" : "allow" });
    console.log(
      `[hook] ${name}${call.agent_id ? ` (agent_id=${call.agent_id})` : ""} ` +
        `${shouldDefer ? "DEFER" : "allow"} ${detail}`,
    );

    if (shouldDefer) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: "defer" as const,
          permissionDecisionReason: "Gated by the spike — awaiting approval.",
        },
      };
    }
    return {
      hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "allow" as const },
    };
  };

  const disallowed = opts.allowExitPlanMode
    ? BASE_DISALLOWED.filter((t) => t !== PLAN_EXIT_TOOL)
    : [...BASE_DISALLOWED];
  if (!opts.subagents) disallowed.push("Agent", "Task");
  disallowed.push("Workflow");

  const q = query({
    prompt: opts.prompt,
    options: {
      cwd: opts.cwd,
      ...(opts.root && opts.root !== opts.cwd ? { additionalDirectories: [opts.root] } : {}),
      ...(opts.resume ? { resume: opts.resume } : {}),
      systemPrompt: { type: "preset", preset: "claude_code", append: "You are a spike fixture. Be terse." },
      permissionMode: opts.planMode ? ("plan" as const) : ("default" as const),
      ...(opts.planModeInstructions ? { planModeInstructions: opts.planModeInstructions } : {}),
      settingSources: [],
      // Reads stay auto-allowed via allowedTools UNLESS we want to watch them at
      // the hook (gate-reads) — mirrors the adapter's workflows-on carve-out.
      allowedTools: opts.gate === "gate-reads" ? [] : READ_ONLY_TOOLS,
      disallowedTools: disallowed,
      ...(opts.subagents ? { agents: SUBAGENT_DEFS } : {}),
      ...(opts.effort ? { effort: opts.effort as "low" | "medium" | "high" | "xhigh" | "max" } : {}),
      settings: {
        disableSkillShellExecution: true,
        autoMemoryEnabled: false,
        ...(opts.plansDirectory ? { plansDirectory: opts.plansDirectory } : {}),
      },
      maxBudgetUsd: opts.budgetUsd ?? 0.6, // spike cost brake — these are real API calls
      hooks: { PreToolUse: [{ hooks: [gateHook] }] } as any,
    },
  });

  let reply = "";
  let costUsd: number | undefined;
  let resultSubtype: string | undefined;
  let terminalReason: string | undefined;
  let deferred: { id: string; name: string; input: Record<string, unknown> } | null = null;

  for await (const m of q as AsyncIterable<Record<string, any>>) {
    raw.push(`${m.type}${m.subtype ? "/" + m.subtype : ""}`);
    if (m.type === "system" && m.subtype === "init") {
      if (m.session_id) {
        sessionIds.push(m.session_id);
        console.log(`[init] session_id=${m.session_id}`);
      }
    } else if (m.type === "conversation_reset") {
      // The message the adapter currently drops on the floor (adapter.ts:918-1060).
      resets.push({ newConversationId: String(m.new_conversation_id ?? ""), sessionId: String(m.session_id ?? "") });
      console.log(`[reset] new_conversation_id=${m.new_conversation_id} session_id=${m.session_id}`);
    } else if (m.type === "user") {
      // Q6's evidence: what the model was actually told about its deferred call.
      const blocks: any[] = m.message?.content ?? [];
      for (const b of Array.isArray(blocks) ? blocks : []) {
        if (b?.type === "tool_result") {
          const content = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
          toolResults.push({ toolUseId: String(b.tool_use_id ?? ""), content: String(content).slice(0, 800) });
          console.log(`[tool_result] ${b.tool_use_id}: ${String(content).slice(0, 300)}`);
        }
      }
    } else if (m.type === "result") {
      if (typeof m.result === "string") reply = m.result;
      if (typeof m.total_cost_usd === "number") costUsd = m.total_cost_usd;
      resultSubtype = m.subtype;
      terminalReason = m.terminal_reason;
      const d = m.deferred_tool_use as { id?: string; name?: string; input?: Record<string, unknown> } | undefined;
      if (d?.id) deferred = { id: d.id, name: d.name ?? "unknown", input: d.input ?? {} };
    }
  }
  console.log(
    `[result] subtype=${resultSubtype} terminal_reason=${terminalReason} ` +
      `cost=$${(costUsd ?? 0).toFixed(4)} deferred=${deferred ? deferred.name : "none"}`,
  );
  console.log(`[raw] ${[...new Set(raw)].join(", ")}`);
  console.log(`[reply] ${reply.slice(0, 600)}`);
  return { reply, seen, sessionIds, resets, costUsd, resultSubtype, terminalReason, deferred, toolResults, raw };
}

// --- run ------------------------------------------------------------------

await ensureFixture(repoPath);
const worktrees = new WorktreeManager(worktreesRoot);
const wt = await worktrees.create({ repoPath, defaultBranch: "main", sessionId: crypto.randomUUID() });
const subCwd = join(wt.path, "apps", "report"); // monorepo-shaped cwd for Q3d

console.log(`[spike] repo:       ${repoPath} (throwaway)`);
console.log(`[spike] worktree:   ${wt.path}`);
console.log(`[spike] sub-cwd:    ${subCwd}`);
console.log(`[spike] plans dflt: ${defaultPlansDir}`);

const PLAN_TASK =
  "Plan (do NOT implement) a change that adds a `subtract` function to src/ledger.ts " +
  "next to `add`. Read the file first. When you have a plan, present it for approval.";

// ------------------------------------------------------------------ Q1 (ship)
// Deferring a READ, not a write: under plan mode a read is the one call the model
// is certain to make and certain not to be refused upstream, so a null result
// cannot be blamed on the SDK's own plan-mode refusal.
if (want("q1")) {
  const p1 = await probe({
    label: "P1  does PreToolUse fire, and does defer work, under permissionMode:'plan'?",
    prompt: "Read README.md in the current directory and tell me its first line. Use the Read tool.",
    cwd: wt.path,
    planMode: true,
    allowExitPlanMode: true,
    gate: "gate-reads",
  });
  record(
    "Q1a the PreToolUse hook fires under permissionMode:'plan'",
    p1.seen.length > 0,
    p1.seen.length > 0
      ? `hook saw: ${p1.seen.map((s) => s.tool).join(", ")}`
      : "the hook never fired — the gate does not exist under plan mode",
  );
  record(
    "Q1b a defer under plan mode produces deferred_tool_use on the result *** SHIP CONDITION ***",
    p1.deferred !== null,
    p1.deferred
      ? `deferred ${p1.deferred.name} (id=${p1.deferred.id}), terminal_reason=${p1.terminalReason}`
      : `no deferred_tool_use; subtype=${p1.resultSubtype} terminal_reason=${p1.terminalReason} — ` +
        `if NO, abandon SDK-native plan mode and ship the Condotto-native fallback`,
  );

  if (p1.deferred && p1.sessionIds[0]) {
    const p1b = await probe({
      label: "P1b does the deferred call RE-DRIVE on an empty-prompt resume, still under plan mode?",
      prompt: "",
      cwd: wt.path,
      resume: p1.sessionIds[0],
      planMode: true,
      allowExitPlanMode: true,
      gate: "allow",
    });
    const redriven = p1b.seen.some((s) => s.tool === p1.deferred!.name);
    record(
      "Q1c the production handshake (empty-prompt resume re-drives the same call) works under plan mode",
      redriven,
      redriven
        ? `re-drove ${p1.deferred.name}; reply: ${p1b.reply.slice(0, 120)}`
        : `resume saw: ${p1b.seen.map((s) => s.tool).join(", ") || "(nothing)"}`,
    );
  }
}

// ------------------------------------------------------------------------ Q2
if (want("q2")) {
  const p2 = await probe({
    label: "P2  does the model emit ExitPlanMode, and what key holds the plan?",
    prompt: PLAN_TASK,
    cwd: wt.path,
    planMode: true,
    allowExitPlanMode: true,
    gate: "gate-exit",
  });
  const exit = p2.seen.find((s) => s.tool === PLAN_EXIT_TOOL);
  record(
    "Q2a the model emits ExitPlanMode once it leaves disallowedTools",
    exit !== undefined,
    exit ? "ExitPlanMode reached the hook" : `hook saw: ${p2.seen.map((s) => s.tool).join(", ") || "(nothing)"}`,
  );
  if (p2.deferred?.name === PLAN_EXIT_TOOL) {
    const input = p2.deferred.input;
    const strings = Object.entries(input).filter(([, v]) => typeof v === "string" && v.length > 0);
    const longest = strings.sort((a, b) => String(b[1]).length - String(a[1]).length)[0];
    record(
      "Q2b the plan text lives in a named tool_input key",
      longest !== undefined,
      longest
        ? `key="${longest[0]}" len=${String(longest[1]).length}; all keys=${JSON.stringify(Object.keys(input))}; ` +
          `first 200: ${JSON.stringify(String(longest[1]).slice(0, 200))}`
        : `no non-empty string values; keys=${JSON.stringify(Object.keys(input))} — ` +
          `planTextFrom() must tolerate null and the approval must degrade gracefully`,
    );
  }

  // Control: today's shipped posture must genuinely block plan exit.
  const p2b = await probe({
    label: "P2b control — with ExitPlanMode in disallowedTools (today's shipped posture)",
    prompt: PLAN_TASK,
    cwd: wt.path,
    planMode: true,
    allowExitPlanMode: false,
    gate: "gate-exit",
  });
  record(
    "Q2c today's BASE_DISALLOWED genuinely prevents plan exit",
    !p2b.seen.some((s) => s.tool === PLAN_EXIT_TOOL),
    `hook saw: ${p2b.seen.map((s) => s.tool).join(", ") || "(nothing)"}; reply: ${p2b.reply.slice(0, 150)}`,
  );
}

// ------------------------------------------------------------------------ Q3
// The one most likely to strand the agent: ~/.claude/plans/ is outside the
// worktree, and evaluateBase hard-DENIES an out-of-worktree write (policy.ts:502)
// with no approval possible.
if (want("q3")) {
  const beforeDefault = walk(defaultPlansDir);
  const beforeWt = walk(wt.path);
  const p3a = await probe({
    label: "P3a plan mode, NO plansDirectory — does a plan file appear, and where?",
    prompt: PLAN_TASK,
    cwd: wt.path,
    planMode: true,
    allowExitPlanMode: true,
    gate: "allow",
  });
  const newDefault = newFiles(defaultPlansDir, beforeDefault);
  const newWt = newFiles(wt.path, beforeWt);
  record(
    "Q3a the CLI writes a plan file",
    newDefault.length > 0 || newWt.length > 0,
    `~/.claude/plans: ${JSON.stringify(newDefault)} | worktree: ${JSON.stringify(newWt)}`,
  );
  const planWrite = p3a.seen.find(
    (s) => (s.tool === "Write" || s.tool === "Edit") && (s.detail.includes("plans") || s.detail.endsWith(".md")),
  );
  record(
    "Q3b that write routes through PreToolUse (our policy would see it)",
    newDefault.length + newWt.length > 0 ? planWrite !== undefined : null,
    planWrite
      ? `hook saw ${planWrite.tool} ${planWrite.detail}`
      : `no plan-file write at the hook; hook saw: ${p3a.seen.map((s) => s.tool).join(", ") || "(nothing)"} — ` +
        `if a file appeared anyway, the CLI writes it BELOW our gate (record as an accepted residual)`,
  );

  const absPlans = join(wt.path, ".condotto", "plans");
  rmSync(absPlans, { recursive: true, force: true });
  await probe({
    label: "P3b settings.plansDirectory = ABSOLUTE path inside the worktree",
    prompt: PLAN_TASK,
    cwd: wt.path,
    planMode: true,
    allowExitPlanMode: true,
    plansDirectory: absPlans,
    gate: "allow",
  });
  record(
    "Q3c an absolute plansDirectory relocates the plan file into the worktree",
    walk(absPlans).length > 0,
    `${absPlans}: ${JSON.stringify(walk(absPlans))}`,
  );

  // "Relative to project root" — but for a monorepo session cwd != worktree root,
  // so check BOTH candidates and find out which one "project root" means.
  const relUnderCwd = join(subCwd, ".condotto-plans");
  const relUnderRoot = join(wt.path, ".condotto-plans");
  rmSync(relUnderCwd, { recursive: true, force: true });
  rmSync(relUnderRoot, { recursive: true, force: true });
  await probe({
    label: "P3c settings.plansDirectory = RELATIVE, with cwd BELOW the worktree root",
    prompt: PLAN_TASK,
    cwd: subCwd,
    root: wt.path,
    planMode: true,
    allowExitPlanMode: true,
    plansDirectory: ".condotto-plans",
    gate: "allow",
  });
  const underCwd = walk(relUnderCwd).length > 0;
  const underRoot = walk(relUnderRoot).length > 0;
  record(
    "Q3d a relative plansDirectory resolves against cwd (not the worktree root)",
    underCwd || underRoot ? underCwd : null,
    `under cwd (${relUnderCwd}): ${underCwd} | under root (${relUnderRoot}): ${underRoot} — ` +
      `decides which absolute path the containment carve-out must name`,
  );
}

// ------------------------------------------------------------------------ Q4
if (want("q4")) {
  const echoInstr =
    `${T.instr}\n\nBefore anything else, reply with the single line "INSTR: ${T.instr}" ` +
    `if you can see this instruction. Then stop.`;
  const p4a = await probe({
    label: "P4a does planModeInstructions reach the model at all? (nonce echo)",
    prompt: "Say hello.",
    cwd: wt.path,
    planMode: true,
    allowExitPlanMode: true,
    planModeInstructions: echoInstr,
    gate: "allow",
  });
  record(
    "Q4a planModeInstructions reaches the model",
    p4a.reply.includes(T.instr),
    p4a.reply.includes(T.instr) ? "nonce echoed back" : `reply: ${p4a.reply.slice(0, 200)}`,
  );

  // The real candidate body: Slack-shaped, no plan file.
  const slackInstr = [
    "You are planning inside a chat thread, not a terminal.",
    "- There is no interactive question dialog. If you need to ask, end your turn with the question.",
    "- Do NOT write the plan to a file. Put the plan text in the ExitPlanMode argument.",
    "- Write for someone reading Slack on a phone: at most ~15 lines, ordered steps,",
    "  naming the files you would touch and how the change gets verified. No headers.",
  ].join("\n");
  const beforeDefault = walk(defaultPlansDir);
  const beforeWt = walk(wt.path);
  const p4b = await probe({
    label: "P4b behavioural — can planModeInstructions suppress the plan file?",
    prompt: PLAN_TASK,
    cwd: wt.path,
    planMode: true,
    allowExitPlanMode: true,
    planModeInstructions: slackInstr,
    gate: "gate-exit",
  });
  const madeFile = newFiles(defaultPlansDir, beforeDefault).length + newFiles(wt.path, beforeWt).length > 0;
  record(
    "Q4b planModeInstructions can suppress the plan-file convention",
    !madeFile,
    madeFile
      ? "a plan file appeared anyway — the wrapper's footer wins, so plansDirectory is required"
      : `no plan file; deferred=${p4b.deferred?.name ?? "none"}`,
  );

  // Diagnostic only — models paraphrase, so this is never a verdict.
  const p4c = await probe({
    label: "P4c diagnostic — what does the model say the plan-mode reminder contains?",
    prompt:
      "Without using any tools, print verbatim the plan-mode system reminder you received this session.",
    cwd: wt.path,
    planMode: true,
    allowExitPlanMode: true,
    planModeInstructions: slackInstr,
    gate: "allow",
  });
  record(
    "Q4c what the CLI still wraps around our body (read-only preamble + ExitPlanMode footer?)",
    null,
    p4c.reply.slice(0, 700).replace(/\n/g, " | "),
  );
}

// --------------------------------------------------------------------- Q5 + Q6
// One sequence: plan → defer the exit → "approve" it by resuming → watch for a
// conversation_reset and for whether the model actually implements.
if (want("q56")) {
  // Keyed on the plan-FILE write, not ExitPlanMode: the first run proved the
  // plan-exit tool does not exist in a headless session (the model itself said
  // so, and its ToolSearch found nothing), while the plan-file write DOES route
  // through PreToolUse carrying the plan as `content`. That write is therefore
  // the approval trigger, and this is the production shape.
  const planDir = join(wt.path, ".condotto", "plans");
  rmSync(planDir, { recursive: true, force: true });
  const p5 = await probe({
    label: "P5  plan, then defer the PLAN-FILE WRITE (the production shape)",
    prompt: PLAN_TASK,
    cwd: wt.path,
    planMode: true,
    allowExitPlanMode: false,
    plansDirectory: planDir,
    gate: "gate-planfile",
  });
  const sid = p5.sessionIds[0];
  record(
    "Q2d the plan text arrives as the plan-file write's `content` (the ExitPlanMode replacement)",
    p5.deferred?.name === "Write" && typeof p5.deferred.input.content === "string",
    p5.deferred
      ? `deferred ${p5.deferred.name} path=${String(p5.deferred.input.file_path ?? "")} ` +
        `contentLen=${String(p5.deferred.input.content ?? "").length}`
      : `nothing deferred; subtype=${p5.resultSubtype}`,
  );
  if (!p5.deferred || !sid) {
    record("Q5/Q6 could not run", null, `deferred=${p5.deferred?.name ?? "none"} sessionId=${sid ?? "none"}`);
  } else {
    // P6a — production's approve path exactly: plan_mode flips to 0, so the
    // resumed query runs permissionMode "default", and the deferred plan-file
    // write re-drives. `gate: "allow"` mirrors what the real gate does on a
    // re-drive (the prior-approval short-circuit answers allow) — deferring it
    // AGAIN reads to the model as "the user said no" and stops the turn, which is
    // how the first version of this probe fooled itself.
    const ledger = join(wt.path, "src", "ledger.ts");
    const p6a = await probe({
      label: "P6a approved resume: permissionMode back to 'default', plan-file write re-drives",
      prompt: "",
      cwd: wt.path,
      resume: sid,
      planMode: false,
      allowExitPlanMode: false,
      gate: "allow",
    });
    record(
      "Q5a conversation_reset is emitted when the plan is approved",
      p6a.resets.length > 0,
      p6a.resets.length > 0
        ? `reset: ${JSON.stringify(p6a.resets)} — the adapter MUST adopt the new id or the thread forks`
        : "no conversation_reset seen — the handle stays valid, no adapter branch needed",
    );
    record(
      "Q5b the session_id changes across the approval",
      p6a.sessionIds.some((s) => s !== sid),
      `before=${sid} after=${JSON.stringify(p6a.sessionIds)}`,
    );
    // The design condition is not "a write was attempted" — it is that the code
    // actually changed. Assert against the FILE, not the transcript.
    const ledgerAfter = existsSync(ledger) ? await Bun.file(ledger).text() : "";
    record(
      "Q6a the approved plan resumes into real implementation *** design condition ***",
      ledgerAfter.includes("subtract"),
      ledgerAfter.includes("subtract")
        ? `src/ledger.ts now defines subtract; tools: ${p6a.seen.map((s) => s.tool).join(", ")}`
        : `src/ledger.ts unchanged; hook saw: ${p6a.seen.map((s) => s.tool).join(", ") || "(nothing)"} | ` +
          `reply: ${p6a.reply.slice(0, 250)}`,
    );
    record(
      "Q6b the re-driven plan-file write lands now that plan mode is off",
      existsSync(planDir) && walk(planDir).length > 0,
      `${planDir}: ${JSON.stringify(walk(planDir))}`,
    );
    record(
      "Q6c what tool_result the model received for the re-driven plan write",
      null,
      p6a.toolResults.map((t) => `${t.toolUseId}: ${t.content.slice(0, 200)}`).join(" || ") || "(none captured)",
    );

    // Does the resumed session still know the plan? A silent fork would strand
    // the worktree's context — the real production question behind Q5.
    const p5c = await probe({
      label: "P5c does the session still know the plan after the approval?",
      prompt: "What plan did we agree on? Answer from memory, do not use tools.",
      cwd: wt.path,
      resume: p6a.sessionIds.at(-1) ?? sid,
      planMode: false,
      allowExitPlanMode: false,
      gate: "allow",
    });
    record(
      "Q5c resuming after the approval still has the plan in context",
      null,
      `subtype=${p5c.resultSubtype} | reply: ${p5c.reply.slice(0, 300)}`,
    );
  }
}

// ------------------------------------------------------------------------ Q7
// If a Write reaches our hook AND executes when we allow it, then Condotto's own
// policy narrowing is the ONLY thing keeping a planning session read-only.
if (want("q7")) {
  const probeFile = join(wt.path, "plan-probe.txt");
  rmSync(probeFile, { force: true });
  const p7 = await probe({
    label: "P7  what do Write and Bash do under permissionMode:'plan'?",
    prompt:
      `Create a file named plan-probe.txt containing ${T.wrote}, using the Write tool. ` +
      "Then run `echo hi` with Bash. Do both now.",
    cwd: wt.path,
    planMode: true,
    allowExitPlanMode: true,
    gate: "allow", // deliberately permissive: anything absent was blocked ABOVE us
  });
  const sawWrite = p7.seen.some((s) => s.tool === "Write");
  const sawBash = p7.seen.some((s) => s.tool === "Bash");
  record(
    "Q7a a Write/Bash under plan mode reaches our hook",
    sawWrite || sawBash,
    `Write=${sawWrite} Bash=${sawBash}; hook saw: ${p7.seen.map((s) => s.tool).join(", ") || "(nothing)"}`,
  );
  record(
    "Q7b it EXECUTES when our hook allows it (⇒ our policy narrowing is the only control)",
    existsSync(probeFile),
    existsSync(probeFile)
      ? `${probeFile} exists — plan mode does NOT stop an allowed call; the policy deny is load-bearing`
      : "the file was not written — the SDK refuses above our hook (our deny is defence in depth)",
  );
}

// ------------------------------------------------------------------------ Q8
if (want("q8")) {
  const p8 = await probe({
    label: "P8  subagents + budget + effort under plan mode",
    prompt:
      "Plan a refactor of src/ledger.ts. Delegate the reading to a subagent (the Agent tool) " +
      "with subagent_type 'explorer', then summarize.",
    cwd: wt.path,
    planMode: true,
    allowExitPlanMode: true,
    gate: "allow",
    subagents: true,
    effort: "xhigh",
    budgetUsd: 0.25, // low on purpose, to try to trip the brake
  });
  const subCall = p8.seen.find((s) => s.agentId !== undefined);
  record(
    "Q8a subagents run under plan mode and their calls carry agent_id",
    subCall !== undefined,
    subCall
      ? `agent_id=${subCall.agentId} on ${subCall.tool}`
      : `no agent_id seen; hook saw: ${p8.seen.map((s) => s.tool).join(", ") || "(nothing)"}`,
  );
  record(
    "Q8b maxBudgetUsd still brakes a plan turn",
    p8.resultSubtype === "error_max_budget_usd" ? true : null,
    `subtype=${p8.resultSubtype} cost=$${(p8.costUsd ?? 0).toFixed(4)} (INCONCLUSIVE just means it stayed under)`,
  );
  record(
    "Q8c xhigh effort is accepted under plan mode",
    p8.resultSubtype !== "error" && p8.reply.length > 0,
    `subtype=${p8.resultSubtype} replyLen=${p8.reply.length}`,
  );
}

// --- summary --------------------------------------------------------------
console.log(`\n${"=".repeat(78)}\nSPIKE SUMMARY\n${"=".repeat(78)}`);
for (const f of findings) console.log(`${f.verdict.padEnd(13)} ${f.q}\n              ${f.detail}\n`);
console.log(`worktree left in place for inspection: ${wt.path}`);

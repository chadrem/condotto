// SPIKE: what can a background workflow sub-agent actually DO, now that the
// session has a real tool list? (Blocks Milestone 1's "re-probe, then delete, the
// workflow-Grep sentence in the system prompt".)
//
// The claim under test is recorded in DECISIONS.md (2026-07-18, M3.6) and repeated
// in three places — `condottoSystemPrompt`, DESIGN.md §8's "Known SDK limitation",
// and DESIGN.md's workflow-confinement passage:
//
//     "Read/Glob route through our hook and are confined reliably; Grep/Bash/Write
//      are frequently denied by the SDK's task-permission layer UPSTREAM of our
//      hook, inconsistently run-to-run."
//
// The premise moved underneath it. When that was observed, workflows-on meant
// `allowedTools: []` and NO `tools` option — and the 2026-07-26 spike proved that
// posture reaches the model with no Grep and no Glob AT ALL. So "the task layer
// denied the Grep" and "there was no Grep to call" produce the same symptom, and
// the original diagnosis could not tell them apart. Since 2026-07-26 the adapter
// passes an explicit `tools` allowlist that names Grep.
//
// Questions:
//   Q1  Under the SHIPPED posture, does a workflow sub-agent's Grep reach our
//       PreToolUse hook with an `agent_id`, get allowed by the real policy engine,
//       and return a real result?
//   Q2  Is Read genuinely the reliable one? The claim splits the tools into two
//       tiers; if Read is denied at the same rate, the tier is imaginary.
//   Q3  Control: under the OLD posture (no `tools`), what did the agents actually
//       do? If they reach for `ToolSearch` looking for Grep, the original finding
//       was measuring absence, not denial.
//   Q4  Is a single agent (no parallel contention) treated differently from six?
//
// Bash is deliberately NOT the subject. A workflow agent's Bash is denied by
// Condotto's OWN policy (`evaluateConfined` — bash has no worktree confinement), so
// "workflow agents cannot run shell" is true regardless of what the SDK does.
//
// Ground truth comes from the sub-agent transcripts the runtime writes under
// `~/.claude/projects/<encoded-cwd>/<session>/subagents/workflows/`, because our own
// hook log can only see the calls that REACHED it — an upstream denial is invisible
// from inside the daemon, which is precisely what made the original finding hard to
// pin down. Reading an SDK-internal path is a spike liberty, not a pattern to ship.
//
// Drives the SDK directly with the adapter's posture constants COPIED (a spike must
// keep reporting what the SDK does even after the adapter changes), but gates with
// the REAL policy engine, so an "allow" here is an allow in production.
//
// Throwaway fixture only — never a real repo (CLAUDE.md build-time safety).
//
// ── RESULTS (2026-07-26, agent-sdk 0.3.220 / claude-code 2.1.220, fable-5/low) ──
//
// 53 sub-agent tool calls across 11 workflow runs on the git fixture (plus earlier
// runs on a non-git fixture, and the read-only `smoke:workflows` run, which agree):
//
//   window         Grep ran   Read ran   runs  note
//   ────────────   ────────   ────────   ────  ────────────────────────────────────
//   bad (early)    4/8        0/6        5     WIDE.1 = Grep 3/3, Read 0/3 in ONE
//                                              workflow — the inverse of the claim
//   good (later)   6/6        5/6        2     same script, same fixture, ~20 min on
//   no-hook ctrl   12/12      12/12      4     no PreToolUse gate installed at all
//
//   Q1  YES. Grep IS in a workflow sub-agent's context now and runs: the calls reach
//       our hook carrying an `agent_id`, the real policy engine allows them as
//       confined reads, and they return correct results (`docs/notes.md` etc.).
//
//   Q2  NO, and this is the finding that matters. The refusal is TOOL-AGNOSTIC.
//       There is a run in which all three sub-agent `Grep`s ran and all three
//       `Read`s were refused — the exact inverse of the documented tier — and runs
//       where both ran clean. `Read` is not a reliable tier above `Grep`; there is
//       one nondeterministic upstream refusal and it hits whatever the agent calls.
//
//   Q3  CONFIRMED, and it re-diagnoses the original finding: under the old posture
//       the sub-agents did not call Grep at all — they called
//       `ToolSearch{query:"select:Grep"}`, looking for a tool that was not in the
//       session. 2026-07-18 recorded a *tool-availability* bug (ours) as a
//       *task-permission* bug (the SDK's). The 2026-07-26 `tools` allowlist fixed
//       the half that was ours.
//
//   Q4  A single agent is NOT exempt (1/2 with no siblings at all), so contention
//       between parallel agents is not the mechanism.
//
//   WHOSE BUG? Not settled. The no-hook control ran 24/24 clean — but so did a
//   HOOKED run minutes later, and the bad window contained only hooked runs, so the
//   control is confounded by time. What IS established: refusals arrive in bursts,
//   are not caused deterministically by gating, and cannot be provoked on demand.
//
//   SIDE FINDING (out of scope — logged to PLAN.md): `StructuredOutput`, the tool
//   `agent(prompt, {schema})` forces a workflow agent to call, was refused on EVERY
//   observed attempt in BOTH postures (a dozen-plus). A schema'd workflow returns
//   empty results and the main agent synthesizes "the agents completed without
//   returning anything" over work that actually succeeded.
//
//   SIDE FINDING 2 (out of scope — logged to PLAN.md): the SDK now emits
//   `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` — "canUseTool will not be invoked:
//   permissionMode 'bypassPermissions' auto-approves every tool call before the
//   callback is consulted." If accurate, the adapter's `canUseTool` backstop is
//   inert in the workflows-on posture, which contradicts DESIGN §8. Needs its own
//   probe before anyone edits DESIGN — the PreToolUse hook, which is the actual
//   boundary, is unaffected either way.
//
// Run: bun run scripts/spike-workflow-grep.ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { Glob } from "bun";
import { smokeHome } from "./smoke-fixture";
import { evaluate } from "../src/core/policy";

// --- the adapter's posture, copied (see the header) -------------------------
const BASE_DISALLOWED = ["ExitPlanMode", "SlashCommand", "WebFetch", "WebSearch"];
const BASE_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "ToolSearch",
  "TodoWrite",
  "Bash",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Skill",
  "Agent",
  "Task",
  "Workflow",
];
const SUBAGENT_DEFS = {
  explorer: {
    description: "Read-only exploration: reads, searches, and summarizes the codebase in parallel.",
    prompt: "You are a read-only exploration subagent for Condotto.",
    tools: ["Read", "Glob", "Grep", "TodoWrite"],
  },
};

// --- fixture ----------------------------------------------------------------
// Tokens findable ONLY by search: the prompt never says which file holds which,
// so an agent that cannot Grep cannot answer by reading a path it was handed.
const root = join(smokeHome(), "wf-grep-spike");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
await Bun.write(join(root, "src/ledger.ts"), "// ALPHA_TOKEN_7Q\nexport const balance = 1;\n");
await Bun.write(join(root, "src/format.ts"), "// BETA_TOKEN_4X\nexport const fmt = 2;\n");
await Bun.write(join(root, "docs/notes.md"), "# notes\n\nGAMMA_TOKEN_9M lives here.\n");
await Bun.write(join(root, "README.md"), "# wf-grep-spike\n\nA throwaway fixture for the workflow-tool spike.\n");
// A real session's cwd is a git worktree, and the runtime's own sandboxing keys off
// the workspace it detects — so the fixture is a git repo, not a bare directory.
for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.email=smoke@condotto.invalid", "-c", "user.name=Condotto Smoke", "commit", "-qm", "fixture"]]) {
  const p = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if ((await p.exited) !== 0) throw new Error(`git ${args[0]} failed: ${await new Response(p.stderr).text()}`);
}

// --- the gate ---------------------------------------------------------------
interface SeenCall {
  tool: string;
  agentId?: string;
  escaped?: boolean;
  decision: string;
}

/**
 * The production gate, verbatim, with one exception: the main agent's Workflow
 * LAUNCH gates in production (an architect clicks Approve) and there is nobody to
 * click here, so it auto-allows — exactly what `smoke-workflows` does.
 */
function makeGate(seen: SeenCall[]) {
  return (name: string, input: unknown, agentId?: string, escaped?: boolean) => {
    if (name === "Workflow" && !agentId && !escaped) {
      seen.push({ tool: name, decision: "allow" });
      return { action: "allow" as const, reason: "launch auto-approved for the spike" };
    }
    const d = evaluate(
      { id: "", name, input, agentId, escaped },
      { worktree: root },
    );
    seen.push({ tool: name, agentId, escaped, decision: d.action });
    return d;
  };
}

// --- ground truth from the runtime's own sub-agent transcripts --------------
const UPSTREAM_DENY = "doesn't want to take this action";

interface AgentCall {
  agent: string;
  tool: string;
  outcome: "ran" | "denied-upstream";
}

/**
 * Replay what each workflow sub-agent actually attempted. The runtime writes one
 * JSONL per sub-agent; a tool_use followed by a tool_result carrying the CLI's
 * canonical refusal is a denial that never reached our hook.
 */
function transcriptCalls(sessionId: string): AgentCall[] {
  const out: AgentCall[] = [];
  // `dot: true` matters — the transcripts live under `~/.claude`, and Bun's Glob
  // skips dot-directories by default, which silently returns nothing.
  const pattern = `.claude/projects/*/${sessionId}/subagents/workflows/*/agent-*.jsonl`;
  for (const rel of new Glob(pattern).scanSync({ cwd: homedir(), absolute: true, dot: true })) {
    const agent = rel.split("/").pop()!.replace(/^agent-|\.jsonl$/g, "");
    const pending = new Map<string, string>(); // tool_use_id -> tool name
    for (const line of readFileSync(rel, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let m: Record<string, any>;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      for (const block of m.message?.content ?? []) {
        if (block.type === "tool_use") pending.set(block.id, block.name);
        if (block.type === "tool_result") {
          const tool = pending.get(block.tool_use_id);
          if (!tool) continue;
          const text = JSON.stringify(block.content ?? "");
          out.push({ agent, tool, outcome: text.includes(UPSTREAM_DENY) ? "denied-upstream" : "ran" });
        }
      }
    }
  }
  return out;
}

// --- arms -------------------------------------------------------------------
interface Arm {
  tag: string;
  what: string;
  /** Pass the explicit `tools` allowlist (the 2026-07-26 change)? */
  explicitTools: boolean;
  prompt: string;
  runs: number;
  /**
   * Install Condotto's PreToolUse gate? Off in the NOHOOK arm, which asks the one
   * question that decides whose bug this is: if sub-agent calls are denied upstream
   * even with no hook at all, the denial is the runtime's and nothing in the daemon
   * can fix it. Safe only because the fixture is throwaway and the prompt is reads.
   */
  hook?: boolean;
}

/** Six agents, half Grep and half Read, so the two tools are measured side by side. */
const WIDE_PROMPT =
  "Launch ONE multi-agent workflow with SIX agents running in parallel. Do NOT pass a `schema` to " +
  "any agent — every agent returns plain text. Each agent makes exactly ONE tool call:\n" +
  "  agents 1-3: Grep for ALPHA_TOKEN_7Q, BETA_TOKEN_4X, GAMMA_TOKEN_9M respectively, using the " +
  "Grep tool ONLY, and return the repo-relative path it matched.\n" +
  "  agents 4-6: Read src/ledger.ts, src/format.ts and README.md respectively, using the Read tool " +
  "ONLY, and return that file's first line.\n" +
  "An agent whose call is refused returns the single word REFUSED. Then reply with one line per " +
  "agent, `<agent> = <answer>`, and nothing else. Do not retry, do not investigate a refusal, and " +
  "do not read any file yourself.";

/** One agent, one call — the same work with no parallel contention. */
const SINGLE_PROMPT =
  "Launch ONE multi-agent workflow containing exactly ONE agent. Do NOT pass a `schema`. That agent " +
  "makes exactly one tool call: Grep for GAMMA_TOKEN_9M using the Grep tool ONLY, and returns the " +
  "repo-relative path it matched, or REFUSED if the call is refused. Reply with just that answer. " +
  "Do not retry and do not read any file yourself.";

const ALL_ARMS: Arm[] = [
  { tag: "WIDE", what: "shipped posture — 6 parallel agents, 3 Grep + 3 Read", explicitTools: true, prompt: WIDE_PROMPT, runs: 2, hook: true },
  { tag: "ONE", what: "shipped posture — a single agent, one Grep (no contention)", explicitTools: true, prompt: SINGLE_PROMPT, runs: 2, hook: true },
  { tag: "OLD", what: "CONTROL: pre-2026-07-26 posture (no `tools`) — 6 parallel agents", explicitTools: false, prompt: WIDE_PROMPT, runs: 1, hook: true },
  { tag: "NOHOOK", what: "CONTROL: shipped posture with NO Condotto gate — whose denial is it?", explicitTools: true, prompt: WIDE_PROMPT, runs: 2, hook: false },
];
// `SPIKE_ARMS=NOHOOK,ONE` re-runs one arm without paying for the others.
const only = process.env.SPIKE_ARMS?.split(",").map((s) => s.trim().toUpperCase());
const ARMS = only?.length ? ALL_ARMS.filter((a) => only.includes(a.tag)) : ALL_ARMS;

async function run(arm: Arm): Promise<{ seen: SeenCall[]; reply: string; sessionId: string; initTools: string[] }> {
  const seen: SeenCall[] = [];
  const gate = makeGate(seen);
  let sessionId = "";
  let initTools: string[] = [];
  const q = query({
    prompt: arm.prompt,
    options: {
      cwd: root,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append:
          "You are Condotto (workflow-tool spike). You may launch multi-agent workflows (the " +
          "Workflow tool) for parallel read-only investigation. Be terse and follow the " +
          "instructions literally.",
      },
      settingSources: [],
      model: "claude-fable-5",
      effort: "low",
      maxBudgetUsd: 1.5,
      agents: SUBAGENT_DEFS,
      // The shipped workflows-on posture: reads move OFF allowedTools onto the hook.
      allowedTools: [],
      disallowedTools: BASE_DISALLOWED,
      permissionMode: "bypassPermissions",
      ...(arm.explicitTools ? { tools: BASE_TOOLS } : {}),
      ...(arm.hook === false ? {} : {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (hookInput: unknown) => {
                const c = hookInput as { tool_name?: string; tool_input?: unknown; agent_id?: string };
                const d = gate(c.tool_name ?? "unknown", c.tool_input, c.agent_id);
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse" as const,
                    ...(d.action === "allow"
                      ? { permissionDecision: "allow" as const }
                      : {
                          // A defer needs a session to resume into; this spike has no
                          // approval loop, so a gate reads as a deny here. Every call
                          // the spike measures is allow-or-deny anyway.
                          permissionDecision: "deny" as const,
                          permissionDecisionReason: d.reason,
                        }),
                  },
                };
              },
            ],
          },
        ],
      },
      }),
    } as never,
  });

  let reply = "";
  for await (const m of q as AsyncIterable<Record<string, any>>) {
    if (m.type === "system" && m.subtype === "init") {
      sessionId = (m.session_id as string) ?? "";
      initTools = (m.tools as string[]) ?? [];
    }
    // A workflow turn yields MULTIPLE results (the "launched; waiting…" one, then
    // the synthesized one) — keep the last success, same as the adapter.
    if (m.type === "result" && m.subtype === "success") reply = (m.result as string) ?? "";
  }
  return { seen, reply, sessionId, initTools };
}

// --- measure ----------------------------------------------------------------
interface Row {
  arm: string;
  run: number;
  /** Per tool: how many sub-agent calls RAN vs were denied upstream of our hook. */
  ran: Record<string, number>;
  denied: Record<string, number>;
  /** Sub-agent calls that reached our gate, by decision. */
  atGate: number;
  atGateAllowed: number;
}
const rows: Row[] = [];
const bump = (r: Record<string, number>, k: string) => (r[k] = (r[k] ?? 0) + 1);

for (const arm of ARMS) {
  for (let i = 1; i <= arm.runs; i++) {
    process.stdout.write(`\n[${arm.tag}.${i}] ${arm.what}\n`);
    let out: Awaited<ReturnType<typeof run>>;
    try {
      out = await run(arm);
    } catch (err) {
      process.stdout.write(`  FAILED: ${err}\n`);
      continue;
    }
    if (i === 1) {
      const has = (t: string) => (out.initTools.includes(t) ? "Y" : "-");
      process.stdout.write(`  main-agent tools(${out.initTools.length}): Grep=${has("Grep")} Glob=${has("Glob")} Read=${has("Read")}\n`);
    }
    const agentCalls = out.seen.filter((c) => c.agentId || c.escaped);
    const row: Row = {
      arm: arm.tag,
      run: i,
      ran: {},
      denied: {},
      atGate: agentCalls.length,
      atGateAllowed: agentCalls.filter((c) => c.decision === "allow").length,
    };
    for (const c of transcriptCalls(out.sessionId)) {
      bump(c.outcome === "ran" ? row.ran : row.denied, c.tool);
      process.stdout.write(`  sub(${c.agent.slice(0, 6)}) ${c.tool.padEnd(17)} ${c.outcome}\n`);
    }
    process.stdout.write(`  at our gate: ${row.atGate} sub-agent calls (${row.atGateAllowed} allowed by the policy engine)\n`);
    process.stdout.write(`  reply: ${out.reply.slice(0, 220).replace(/\n/g, " | ")}\n`);
    rows.push(row);
  }
}

// --- summary ----------------------------------------------------------------
process.stdout.write(`\n=== summary: sub-agent tool calls, ran / attempted ===\n`);
const TOOLS = ["Grep", "Read", "Glob", "ToolSearch", "StructuredOutput"];
process.stdout.write(`arm   run  ${TOOLS.map((t) => t.padEnd(18)).join("")}at-gate\n`);
for (const r of rows) {
  const cells = TOOLS.map((t) => {
    const ran = r.ran[t] ?? 0;
    const total = ran + (r.denied[t] ?? 0);
    return (total === 0 ? "-" : `${ran}/${total}`).padEnd(18);
  });
  process.stdout.write(`${r.arm.padEnd(6)}${String(r.run).padEnd(5)}${cells.join("")}${r.atGate}\n`);
}

const total = (arms: string[], tool: string, which: "ran" | "denied") =>
  rows.filter((r) => arms.includes(r.arm)).reduce((n, r) => n + (r[which][tool] ?? 0), 0);
const rate = (arms: string[], tool: string) => {
  const ran = total(arms, tool, "ran");
  const t = ran + total(arms, tool, "denied");
  return t === 0 ? "no attempts" : `${ran}/${t}`;
};
const shipped = ["WIDE", "ONE"];
process.stdout.write(`\nQ1 shipped posture, sub-agent Grep ran:   ${rate(shipped, "Grep")}\n`);
process.stdout.write(`Q2 shipped posture, sub-agent Read ran:   ${rate(shipped, "Read")}\n`);
process.stdout.write(`Q3 OLD posture — Grep attempts: ${rate(["OLD"], "Grep")}, ToolSearch attempts: ${rate(["OLD"], "ToolSearch")}\n`);
process.stdout.write(`Q4 single-agent Grep ran: ${rate(["ONE"], "Grep")} vs 6-agent ${rate(["WIDE"], "Grep")}\n`);
process.stdout.write(`side finding — StructuredOutput ran: ${rate(["WIDE", "ONE", "OLD"], "StructuredOutput")}\n`);
process.stdout.write(`\nfixture: ${root} (throwaway — delete it freely)\n`);

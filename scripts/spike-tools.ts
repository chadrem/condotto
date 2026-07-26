// SPIKE: which option actually governs whether the model HAS Grep and Glob?
// (Blocks Milestone 1's "restore Grep and Glob under the shipped posture".)
//
// The audit found that the shipped default posture (workflows on ⇒
// `allowedTools: []`) reaches the model with no search tools at all: it can Read a
// path it already knows and nothing else, and every "find where X is used" costs a
// gated `grep` through Bash. That contradicts sdk.d.ts's own prose for
// `allowedTools` ("To restrict which tools are available, use the `tools` option
// instead"), which is exactly why it gets probed instead of assumed.
//
// Questions:
//   Q1  What does the shipped posture actually put in the model's context today?
//       Read the `tools` array off the `system`/`init` message for the real
//       adapter option set, workflows ON and OFF.
//   Q2  Does `tools: {type:'preset',preset:'claude_code'}` restore Grep/Glob under
//       an empty `allowedTools`? The preset is the cheapest possible fix if so.
//   Q3  Does an explicit `tools: [...]` restore them, and does `disallowedTools`
//       still SUBTRACT from it? The whole gate posture rests on bare-name
//       disallow removing WebFetch/SlashCommand/Agent/Workflow from context; if
//       `tools` overrode that, the fix would re-open tools the architect turned off.
//   Q4  Does naming a tool in `tools` bring back things the default set omits —
//       specifically `TodoWrite`, which the audit reports as absent in every
//       configuration?
//   Q5  Does adding `tools` disturb the two things layered on top of it —
//       `agents` (the read-only explorer) and plan mode?
//
// Drives the SDK directly rather than through ClaudeCodeAdapter: a spike must not
// require shipping the production code it is meant to justify. Options otherwise
// mirror adapter.ts's `runQuery`.
//
// Costs ~nothing: each probe reads the init message and interrupts before the
// model is asked to do anything.
//
// Throwaway fixture only — never a real repo (CLAUDE.md build-time safety).
//
// RESULTS — run 2026-07-26, agent-sdk 0.3.220 / claude-code 2.1.220, model
// claude-opus-5[1m]. Recorded here so a re-run has
// something to diff against:
//
//   Q1  The shipped posture (workflows ON) reaches the model with 27 tools and
//       NEITHER Grep NOR Glob. Workflows OFF has both — because `allowedTools`
//       names them, which is the coupling that hid the bug. The 27 also include
//       Cron*, ScheduleWakeup, RemoteTrigger, PushNotification, SendMessage,
//       DesignSync, Monitor, ReportFindings, Task* and Enter/ExitWorktree, none of
//       which `policy.ts` has an arm for.
//
//   Q2  *** THE ONE THAT CHANGES THE FIX ***
//       `tools: {type:'preset',preset:'claude_code'}` is a NO-OP — the init list
//       is byte-identical to omitting the option, Grep/Glob still absent (P1 vs
//       P2). "Use all default Claude Code tools" means the runtime's defaults,
//       which on a native build are the thing that lacks search. The plan had
//       named the preset as an acceptable alternative; it is not one.
//
//   Q3a YES  An explicit `tools: [...]` restores Grep and Glob under an empty
//            `allowedTools` (P3), which is the shipped posture.
//   Q3b YES  `disallowedTools` still SUBTRACTS from an explicit list: P6 names
//            Agent/Task/Workflow in `tools` and disallows them, and all three are
//            absent. The per-turn capability toggles keep working.
//   Q3c      A name the runtime does not expose is IGNORED, not an error
//            (AskUserQuestion, MultiEdit, Agent were all requested and absent).
//            `Agent` is exposed only under its legacy name `Task`.
//
//   Q4  NO   `TodoWrite` is absent even when named in `tools`. It is genuinely
//            unavailable in this runtime, in every configuration measured.
//
//   Q5  YES  `agents` (P9) and `permissionMode:"plan"` (P10) are both unaffected —
//            init lists identical to P3.
//
//   P11 YES  A real turn under the shipped posture + the explicit list: the model
//            called Grep exactly once, the hook allowed it, and it answered
//            correctly. No approval click, no Bash fallback.
//
// Run: bun run scripts/spike-tools.ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { smokeHome } from "./smoke-fixture";

// Condotto's real posture constants, copied (not imported) so the probe keeps
// reporting what the SDK does even after the adapter changes.
const ALLOWED_TOOLS = ["Read", "Glob", "Grep", "TodoWrite"];
const BASE_DISALLOWED = ["ExitPlanMode", "SlashCommand", "WebFetch", "WebSearch"];
const SUBAGENT_TOOLS = ["Agent", "Task"];
const WORKFLOW_TOOL = "Workflow";

/** The candidate explicit base set: the claude_code preset is a value, not a list. */
const CONDOTTO_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Bash",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "TodoWrite",
  "ToolSearch",
  "Skill",
  "Agent",
  "Task",
  "Workflow",
  "AskUserQuestion",
];

const root = join(smokeHome(), "tools-spike");
if (!existsSync(root)) mkdirSync(root, { recursive: true });

interface Probe {
  tag: string;
  what: string;
  opts: Record<string, unknown>;
}

/** The shipped adapter posture for a given workflow toggle, minus any `tools`. */
function posture(workflows: boolean): Record<string, unknown> {
  const disallowed = [...BASE_DISALLOWED];
  if (!workflows) disallowed.push(...SUBAGENT_TOOLS, WORKFLOW_TOOL);
  return {
    allowedTools: workflows ? [] : ALLOWED_TOOLS,
    disallowedTools: disallowed,
    permissionMode: workflows ? "bypassPermissions" : "default",
  };
}

const PRESET = { type: "preset" as const, preset: "claude_code" as const };

const PROBES: Probe[] = [
  { tag: "P1", what: "shipped posture, workflows ON (today)", opts: posture(true) },
  { tag: "P2", what: "workflows ON + tools: preset claude_code", opts: { ...posture(true), tools: PRESET } },
  { tag: "P3", what: "workflows ON + explicit tools list", opts: { ...posture(true), tools: CONDOTTO_TOOLS } },
  { tag: "P4", what: "shipped posture, workflows OFF (today)", opts: posture(false) },
  { tag: "P5", what: "workflows OFF + tools: preset claude_code", opts: { ...posture(false), tools: PRESET } },
  { tag: "P6", what: "workflows OFF + explicit tools list", opts: { ...posture(false), tools: CONDOTTO_TOOLS } },
  {
    tag: "P7",
    what: "workflows ON + preset + agents (the explorer subagent)",
    opts: {
      ...posture(true),
      tools: PRESET,
      agents: {
        explorer: {
          description: "Read-only exploration.",
          prompt: "You are a read-only exploration subagent.",
          tools: ["Read", "Glob", "Grep", "TodoWrite"],
        },
      },
    },
  },
  {
    tag: "P8",
    what: "plan mode + preset",
    opts: {
      allowedTools: [],
      disallowedTools: BASE_DISALLOWED,
      permissionMode: "plan",
      tools: PRESET,
    },
  },
  {
    tag: "P9",
    what: "workflows ON + explicit tools list + agents",
    opts: {
      ...posture(true),
      tools: CONDOTTO_TOOLS,
      agents: {
        explorer: {
          description: "Read-only exploration.",
          prompt: "You are a read-only exploration subagent.",
          tools: ["Read", "Glob", "Grep", "TodoWrite"],
        },
      },
    },
  },
  {
    tag: "P10",
    what: "plan mode + explicit tools list",
    opts: {
      allowedTools: [],
      disallowedTools: BASE_DISALLOWED,
      permissionMode: "plan",
      tools: CONDOTTO_TOOLS,
    },
  },
];

/** Read the init message's tool list, then stop before the model does anything. */
async function toolsFor(p: Probe): Promise<{ tools: string[]; model: string; mode: string }> {
  const q = query({
    prompt: "Say nothing.",
    options: {
      cwd: root,
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: [],
      // Never reached — we interrupt at init — but a gate that could fire must
      // fail closed, same as production.
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async () => ({
                hookSpecificOutput: {
                  hookEventName: "PreToolUse" as const,
                  permissionDecision: "deny" as const,
                  permissionDecisionReason: "spike",
                },
              }),
            ],
          },
        ],
      },
      ...p.opts,
    } as never,
  });
  let out = { tools: [] as string[], model: "", mode: "" };
  try {
    for await (const m of q as AsyncIterable<Record<string, any>>) {
      if (m.type === "system" && m.subtype === "init") {
        out = {
          tools: (m.tools as string[]) ?? [],
          model: (m.model as string) ?? "",
          mode: (m.permissionMode as string) ?? "",
        };
        break;
      }
    }
  } finally {
    try {
      await q.interrupt();
    } catch {
      /* the query may already be done */
    }
  }
  return out;
}

const WATCH = ["Grep", "Glob", "Read", "Bash", "Write", "Edit", "TodoWrite", "Agent", "Task", "Workflow", "Skill"];

const rows: { tag: string; what: string; tools: string[] }[] = [];
for (const p of PROBES) {
  process.stdout.write(`\n[${p.tag}] ${p.what}\n`);
  let r: { tools: string[]; model: string; mode: string };
  try {
    r = await toolsFor(p);
  } catch (err) {
    process.stdout.write(`  FAILED: ${err}\n`);
    continue;
  }
  rows.push({ tag: p.tag, what: p.what, tools: r.tools });
  process.stdout.write(`  model=${r.model} mode=${r.mode}\n`);
  process.stdout.write(`  tools(${r.tools.length}): ${r.tools.join(", ") || "<none>"}\n`);
  const have = new Set(r.tools);
  process.stdout.write(`  watched: ${WATCH.map((t) => `${t}=${have.has(t) ? "Y" : "-"}`).join(" ")}\n`);
}

process.stdout.write(`\n=== summary ===\n`);
const pad = (s: string, n: number) => s.padEnd(n);
process.stdout.write(`${pad("probe", 6)}${WATCH.map((t) => pad(t, 12)).join("")}\n`);
for (const r of rows) {
  const have = new Set(r.tools);
  process.stdout.write(`${pad(r.tag, 6)}${WATCH.map((t) => pad(have.has(t) ? "yes" : "-", 12)).join("")}\n`);
}
process.stdout.write(`\nfull lists:\n`);
for (const r of rows) process.stdout.write(`  ${r.tag}: ${r.tools.join(", ") || "<none>"}\n`);

// --- P11: the "done when" -------------------------------------------------
// An init array is a claim about context, not about behaviour. This runs a REAL
// turn under the shipped posture + the explicit list and asks a question that can
// only be answered by searching, with a hook that mirrors production: reads
// auto-allow, everything else denies (in production a Bash outside the allowlist
// would GATE, i.e. cost an approval click). If the model reaches for Grep/Glob and
// the hook allows it, "a member-turn search costs no approval click" is observed
// rather than argued.
process.stdout.write(`\n[P11] live turn: does a search actually run un-gated?\n`);
const FIXTURE: Record<string, string> = {
  "src/ledger.ts": "export function computeLedgerBalanceZK7(entries: number[]): number {\n  return entries.reduce((a, b) => a + b, 0);\n}\n",
  "src/format.ts": "export const fmt = (n: number) => n.toFixed(2);\n",
  "README.md": "# tools-spike\n\nA throwaway fixture for the tool-posture spike.\n",
};
for (const [rel, content] of Object.entries(FIXTURE)) await Bun.write(join(root, rel), content);

const seen: { tool: string; decision: string }[] = [];
const READS = new Set(["Read", "Glob", "Grep"]);
const live = query({
  prompt: "Which file defines computeLedgerBalanceZK7? Reply with just the path.",
  options: {
    cwd: root,
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: [],
    ...posture(true),
    tools: CONDOTTO_TOOLS,
    maxBudgetUsd: 0.5,
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (hookInput: unknown) => {
              const name = (hookInput as { tool_name?: string }).tool_name ?? "unknown";
              const ok = READS.has(name);
              seen.push({ tool: name, decision: ok ? "allow" : "deny" });
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse" as const,
                  ...(ok
                    ? { permissionDecision: "allow" as const }
                    : {
                        permissionDecision: "deny" as const,
                        permissionDecisionReason: "spike: only reads auto-allow here",
                      }),
                },
              };
            },
          ],
        },
      ],
    },
  } as never,
});
let reply = "";
for await (const m of live as AsyncIterable<Record<string, any>>) {
  if (m.type === "result") reply = (m.result as string) ?? (m.subtype as string) ?? "";
}
process.stdout.write(`  tool calls: ${seen.map((s) => `${s.tool}:${s.decision}`).join(", ") || "<none>"}\n`);
process.stdout.write(`  reply: ${reply.slice(0, 200).replace(/\n/g, " ")}\n`);
const searched = seen.filter((s) => s.tool === "Grep" || s.tool === "Glob");
process.stdout.write(
  `  verdict: ${
    searched.length > 0 && searched.every((s) => s.decision === "allow")
      ? "YES — the model searched with Grep/Glob and every search auto-allowed (no approval click)"
      : "NO — no allowed Grep/Glob call was observed"
  }\n`,
);

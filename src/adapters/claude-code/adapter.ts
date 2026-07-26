import { query } from "@anthropic-ai/claude-agent-sdk";
import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  GateFn,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessSession,
  HarnessSkill,
  HarnessTurnOptions,
  SessionHandle,
  TurnEvent,
  TurnInput,
} from "../../core/types";
import { parseWorkflowMeta } from "../../core/policy";

/**
 * The SDK `query()` surface the adapter drives — narrowed to what `runQuery` uses
 * (an async iterable of messages plus `interrupt`). Injectable so tests can drive
 * the real adapter loop with a scripted SDK message stream (buffering, canUseTool,
 * hook mapping) without a live query. Production uses the real `query`.
 */
export type QueryFn = (args: { prompt: unknown; options: Record<string, any> }) => AsyncIterable<Record<string, any>> & {
  interrupt(): Promise<void>;
};

// Claude Code harness adapter over the Agent SDK.
//
// Verified facts this code builds on (spike 2026-07-16 + live docs, see
// Verified SDK facts (see CLAUDE.md, "SDK gotchas"):
//  - Auth is EITHER an Anthropic API key OR the machine's Claude subscription
//    login (keychain OAuth / headless CLAUDE_CODE_OAUTH_TOKEN). The credential is
//    resolved by the composition root (core/config loadAuthConfig) and handed in;
//    this file never reads it from the environment itself.
//
//    REVERSED 2026-07-20. This comment previously read "There is no
//    ANTHROPIC_API_KEY in this deployment and this file must never read one" —
//    true of the original single-operator deployment, wrong as a rule for an
//    installable daemon. Anthropic's guidance is that developers building on the
//    Agent SDK authenticate with a Console API key, and that Free/Pro/Max plan
//    limits assume ordinary individual use; Condotto is explicitly multi-person.
//    So API key is now the documented default and subscription OAuth is the
//    explicitly single-operator path. Both are supported.
//
//    The key reaches the model by riding the SDK subprocess environment — the
//    SDK's documented mechanism (sdk.d.ts:1414 names ANTHROPIC_API_KEY as a
//    variable the subprocess needs inherited). That means it is readable from the
//    agent's own shell, exactly as CLAUDE_CODE_OAUTH_TOKEN already is; what
//    guards it is the policy hard-deny on commands naming either variable
//    (core/policy.ts) plus CommandRunner's scrub. Do not weaken either.
//  - `resume: <sessionId>` + same cwd resumes a session across processes;
//    session storage is keyed by encoded cwd, so cwd must be stable.
//  - Without the claude_code systemPrompt preset the model has no environment
//    context (it invents paths) — always use the preset + append.
//  - `session_id` arrives on the `system`/`init` message.
//
// The core GateFn answers allow or deny for every tool call.
//  - allow -> PreToolUse `allow` (the hook still confines, which beats
//             allowedTools per the SDK precedence).
//  - deny  -> PreToolUse `deny` with a reason fed back to the agent.
// There used to be a third answer, `gate`, mapped to the SDK's `defer` so a turn
// could end un-executed and resume on an architect's click. Deleted 2026-07-26
// with the approval loop. `canUseTool` remains as a deny-by-default backstop for
// calls that reach the permission flow instead of the hook (a batched call, or a
// workflow agent's call that carried no agent_id) — it runs the same core policy,
// so the answer is identical wherever the call lands.

/**
 * Opaque to the core. Owned entirely by this adapter. Deliberately does NOT
 * carry the system prompt — that is core policy, re-supplied on every
 * create/resume so a posture change reaches existing sessions. (Legacy handles
 * from an earlier version may still contain a `system` field; asHandle ignores it.)
 */
interface ClaudeCodeHandle {
  v: 1;
  sessionId: string | null;
  /**
   * Command names the runtime reported on this session's last `system`/`init`
   * message. Kept only as a CROSS-CHECK against our own enumeration (see
   * `enumerateSkills`), so a name we would dispatch that the runtime does not list
   * gets logged rather than silently failing.
   *
   * `v` deliberately stays 1. `asHandle` throws on any other version, so bumping it
   * would wedge every thread for an operator who rolls a binary back — permanently,
   * since the migration story is forward-only. An additive optional field is
   * compatible in both directions: an older binary reads the row and drops the key.
   */
  runtimeCommands?: string[];
}

// `allowedTools` auto-approves reads (the hook still denies out-of-worktree
// reads — a hook `deny` beats an allow rule). Write/Edit/Bash are deliberately
// NEITHER allowed (they must gate) NOR disallowed (they must be reachable so the
// agent can propose them). NOTE: when the Workflow tool is enabled we clear
// allowedTools and drive reads through the PreToolUse hook instead — in
// allowedTools a tool is "auto-approved before the callback is consulted", and for
// a background workflow's sub-agents that shadow path silently DENIES the read
// (spike 2026-07-18). Via the hook, reads still auto-allow (confined) for the main
// agent and the workflow agents alike.
//
// This list governs AUTO-APPROVAL ONLY. Whether a tool exists for the session at
// all is `BASE_TOOLS` below — a distinction that used to be invisible because
// naming a tool here also happened to supply it, which is how emptying this list
// silently took Grep and Glob away (spike 2026-07-26).
const ALLOWED_TOOLS = ["Read", "Glob", "Grep", "TodoWrite"];
// Always removed from context, regardless of capability flags: slash commands and
// network reads are out of scope for the implementer.
//
// `ExitPlanMode` stays listed but the entry is now belt-and-braces, not the
// control: the runtime does not expose a plan-exit tool in a headless session at
// all (spike 2026-07-25 — the model itself reported "ExitPlanMode isn't available
// in this session" and its own ToolSearch found nothing), so removing it from this
// list changes nothing. Condotto's plan mode does not need it: the model presents
// a plan by WRITING it to `plansDirectory`, and that write is what gates. If a
// future SDK restores the tool, leave it in NEITHER list — `allowedTools` is an
// auto-approve list consulted before the callback, so putting it there would
// shadow-approve the plan exit and the plan would never reach the thread.
const BASE_DISALLOWED = ["ExitPlanMode", "SlashCommand", "WebFetch", "WebSearch"];

/**
 * The base set of built-in tools this session may have at all — the `tools`
 * option, which is ORTHOGONAL to `allowedTools` (availability vs. auto-approve).
 * `disallowedTools` still subtracts from it, so the per-turn capability toggles
 * below keep working exactly as before.
 *
 * Why this exists (spike 2026-07-26, `scripts/spike-tools.ts`): the native runtime
 * does not ship `Grep`/`Glob` in its default set — sdk.d.ts says as much under
 * `tools` ("native builds may provide search via Bash `find`/`grep` instead...
 * List Grep/Glob here or in `allowedTools` to get them"). Naming them in
 * `allowedTools` is what used to supply them, so the moment workflows turned on
 * and `allowedTools` went empty (see WORKFLOW_TOOL), the implementer lost search
 * entirely — under what is now the SHIPPED DEFAULT posture. It could Read a path it
 * already knew and nothing else, and every "where is this used?" became a gated
 * `grep` through Bash. Putting them back in `allowedTools` is not available to us:
 * that is the shadow-deny this whole arrangement exists to avoid. `tools` is.
 *
 * The `{type:'preset',preset:'claude_code'}` value is NOT an alternative — the
 * spike measured it as byte-identical to omitting the option, Grep/Glob still
 * absent. Only an explicit list works.
 *
 * An explicit list REPLACES the default set, so this is also, deliberately, the
 * reachable tool surface. What it drops is everything the runtime ships that
 * `policy.ts` has no arm for — `Cron*`, `ScheduleWakeup`, `RemoteTrigger`,
 * `PushNotification`, `SendMessage`, `DesignSync`, `Monitor`, `ReportFindings`,
 * `Task*` (the background-task manager, unrelated to the `Task` subagent alias)
 * and `EnterWorktree`/`ExitWorktree`. Every one of those already gated into an
 * unreadable "I want to use X" card with raw JSON, so none of them worked; and
 * `ExitWorktree` takes `{action:'remove', discard_changes?: true}`, which is a
 * worktree-destroying call nothing in the bash floor covers. An allowlist fails
 * CLOSED as the runtime's built-ins grow, which is the same reason
 * `enumerateSkills` builds its own list instead of filtering the runtime's.
 *
 * Names the runtime does not currently expose are harmless here (verified: a
 * `tools` entry that matches nothing is ignored, not an error), so tools
 * `policy.ts` classifies are listed even when this runtime lacks them —
 * `TodoWrite` and `MultiEdit` are absent from every posture the spike measured,
 * and `Agent` is exposed only under its legacy `Task` name.
 *
 * NOTE for anything that later un-disallows a tool: removing a name from
 * `BASE_DISALLOWED` is no longer sufficient by itself — it must also appear here,
 * or it stays out of context.
 */
const BASE_TOOLS = [
  // Confined reads (policy `READ_TOOLS`). Grep/Glob are the point of this list.
  "Read",
  "Glob",
  "Grep",
  // Side-effect-free (policy `NO_FS_TOOLS`).
  "ToolSearch",
  "TodoWrite",
  // Gated actions — reachable so the agent can PROPOSE them, never auto-allowed.
  "Bash",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  // Architect-invocable skills.
  "Skill",
  // Fan-out. Present here unconditionally; `disallowedTools` is what turns them
  // off per-turn when the architect has not opted in.
  "Agent",
  "Task",
  "Workflow",
];

/**
 * The plan-mode workflow body (SDK `planModeInstructions`). Replaces the runtime's
 * default code-implementation phases; the CLI still wraps it with its own
 * read-only preamble and plan protocol.
 *
 * SHAPE ONLY, deliberately. What plan mode permits, what approval means, and what
 * a denial means are Condotto policy and live in `condottoSystemPrompt`, which the
 * core re-supplies on every resume. Restating the rules here would create a second
 * copy that ages independently — and the stale one would be this one.
 */
const PLAN_MODE_INSTRUCTIONS = [
  "You are planning inside a chat thread, not a terminal. Someone reads your plan on a phone.",
  "",
  "- Investigate as much as you need first: read files, search, and delegate read-only",
  "  exploration to subagents if you have them.",
  "- There is no interactive question dialog here. If you need something decided before you",
  "  can plan, just end your turn with the question and wait for a reply in the thread.",
  "- Write the plan to your plan file. Keep it short enough to read in one message: what you",
  "  would change, which files you would touch, and how the change gets verified. Ordered",
  "  steps, no headers, no preamble. Say what you would NOT do if that is the risky part.",
  "- Writing the plan file is how you present the plan for approval; it is the one write you",
  "  can make right now. Do not try to implement anything first.",
].join("\n");
// Subagent tools, disabled BY DEFAULT (subagents are architect opt-in). Both the
// current `Agent` name and the legacy `Task` alias are listed so "subagents off"
// is genuinely off regardless of which the runtime exposes. Un-disallowed per-turn
// only when the session enables the capability; even then every tool call a
// subagent makes still hits the PreToolUse gate (agent_id-tagged).
const SUBAGENT_TOOLS = ["Agent", "Task"];
// The multi-agent Workflow tool (architect opt-in). Disabled by default and
// re-enabled per-turn only when the session enables workflows. When enabled the
// query runs under `permissionMode: "bypassPermissions"` so the background
// workflow's sub-agent tool calls route THROUGH the PreToolUse hook (agent_id-
// tagged) where the read-only subagent policy confines them — the hook still
// outranks permission mode, so main-agent defer/deny are unaffected (spike
// 2026-07-18). Was disabled outright earlier (which used
// permissionMode "default", under which the same agents default-DENY off-gate).
const WORKFLOW_TOOL = "Workflow";

// Model/effort. The core passes an opaque model token; the adapter is the only
// place that knows SDK model IDs (keeps the port clean). Unrecognized tokens
// pass through (the SDK also accepts bare aliases / full IDs), but the core has
// already validated against `supportedModels`, so that path is belt-and-braces.
const MODEL_IDS: Record<string, string> = {
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  fable: "claude-fable-5",
};
const SUPPORTED_MODELS = Object.keys(MODEL_IDS);
// Independent of extended thinking. xhigh needs Fable 5 / Opus 4.7+ / Sonnet 5
// (our Opus 5 default qualifies, and is why xhigh is the shipped default); the
// SDK silently falls back to `high` elsewhere. Note that Opus 5 refuses a request
// that DISABLES thinking at xhigh/max — we set no thinking option, so don't start.
const SUPPORTED_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/**
 * Daemon-side subagent definitions. When the architect enables
 * subagents, the implementer fans out to these for parallel READ-ONLY work; their
 * tool calls still hit the gate (agent_id-tagged), and the restricted `tools` list
 * is defense-in-depth. Subagents never write/run shell — the policy engine denies
 * any subagent-initiated gated call (defer→resume is main-agent-only), so the main
 * agent performs mutations through the approval loop. Daemon-defined (not from repo
 * config), so enabling them needs no repo trust.
 */
const SUBAGENT_DEFS = {
  explorer: {
    description:
      "Read-only exploration: reads, searches, and summarizes the codebase in parallel. " +
      "Use to investigate before the main agent makes changes.",
    prompt:
      "You are a read-only exploration subagent for Condotto. Use Read/Glob/Grep to investigate " +
      "the working tree and report concise, specific findings (files, symbols, line numbers). You " +
      "cannot write files or run shell commands; if a change is needed, describe exactly what the " +
      "main agent should do. Stay within the working tree.",
    tools: ["Read", "Glob", "Grep", "TodoWrite"],
  },
};

function resolveModel(token: string | undefined): string | undefined {
  if (!token) return undefined;
  return MODEL_IDS[token] ?? token;
}
function resolveEffort(token: string | undefined): string | undefined {
  return token && SUPPORTED_EFFORTS.includes(token) ? token : undefined;
}

/**
 * Build the per-turn tool posture from the session's harness capabilities.
 * Subagent / workflow tools are removed from context unless the architect opted
 * in. When workflows are ON, reads move OUT of allowedTools onto the hook (so the
 * background workflow's sub-agents aren't shadow-denied — see WORKFLOW_TOOL);
 * otherwise reads stay auto-allowed via allowedTools (unchanged behaviour).
 * Write/bash are always absent from both lists so they gate.
 *
 * `tools` is constant across postures on purpose: what the agent HAS should not
 * depend on whether the architect turned workflows on. Availability is `tools`,
 * auto-approve is `allowedTools`, and conflating the two is what cost the shipped
 * posture its search (see BASE_TOOLS).
 */
function toolPosture(h: HarnessTurnOptions | undefined): {
  tools: string[];
  allowedTools: string[];
  disallowedTools: string[];
} {
  const disallowed = [...BASE_DISALLOWED];
  if (!h?.subagents) disallowed.push(...SUBAGENT_TOOLS);
  if (!h?.workflows) disallowed.push(WORKFLOW_TOOL);
  const allowedTools = h?.workflows ? [] : ALLOWED_TOOLS;
  return { tools: BASE_TOOLS, allowedTools, disallowedTools: disallowed };
}

// ---------------------------------------------------------------------------
// Skill enumeration
//
// Condotto builds its OWN list of dispatchable skills rather than trusting the
// runtime's `slash_commands`, for four reasons the spike made concrete:
//
//  1. Provenance. `slash_commands` is a flat `string[]`; it cannot say WHICH file
//     a name resolves to. Since a repo skill and an operator skill may share a
//     name and the list de-duplicates, "is this the `ship` I mean?" is answerable
//     only here, at enumeration time.
//  2. Built-ins stay out. The runtime's list carries ~45 built-ins that grow with
//     every CLI release — `/clear`, `/model`, `/compact`, `/rewind`, and whatever
//     ships next. A denylist over that set fails OPEN on upgrade, silently. An
//     allowlist of files we found ourselves fails closed.
//  3. Frontmatter is inspectable before dispatch. `context: fork` runs the skill
//     as a SUBAGENT (verified: its Read and Bash carried an `agent_id`), where
//     `evaluateConfined` denies bash — so it would half-run. Refuse it up front.
//  4. `@path` in a skill BODY inlines a file with no tool call at all, outside
//     worktree confinement (verified live). Refuse bodies that use it.
//
// This is a *shape* check over vouched content, not a sandbox: repo skills load
// only for `trusted` repos and operator skills are the operator's own. It exists
// so an architect is never surprised by which file ran, not to make hostile skills
// safe — nothing here would.

/** Where a dispatchable skill may come from, and what it is called there. */
const SKILL_DIRS = [
  { rel: join(".claude", "skills"), kind: "skill" as const },
  { rel: join(".claude", "commands"), kind: "command" as const },
];

/** Frontmatter keys that change HOW a skill runs in ways Condotto must not lose. */
const REFUSED_FRONTMATTER: { key: string; value?: string; why: string }[] = [
  // Runs the skill in a subagent, which re-enables fan-out the architect may have
  // turned off AND lands its calls in `evaluateConfined`, where bash is denied.
  { key: "context", value: "fork", why: "it runs in a subagent, where Condotto denies the shell it would need" },
  // The architect owns model/effort through `@Condotto model` / `effort`.
  { key: "model", why: "it overrides the model the architect chose for this thread" },
  { key: "effort", why: "it overrides the reasoning effort the architect chose for this thread" },
];

// Inline shell in a skill body: a bang IMMEDIATELY followed by a backticked
// command, at a line start or after whitespace. The leading-boundary requirement is
// what separates the real construct from prose — a sentence containing `refresh!`
// in a code span puts a bang next to a backtick without meaning anything by it, and
// an earlier version of this check refused a real skill over exactly that.
const INLINE_SHELL_RE = /(?:^|\s)!`[^`\n]*`/m;

// `@path` file inlining. Only an ESCAPING path is a problem: expansion inlines the
// file with no Read call, so it never meets `policy.ts` confinement — but an
// in-worktree path grants nothing the agent could not already read through the
// gate. Absolute, `~`, and `..` are the escapes.
const INLINE_FILE_RE = /(?:^|\s)@(\S+)/gm;
function inlinesFileOutsideWorktree(body: string): string | null {
  INLINE_FILE_RE.lastIndex = 0;
  for (const m of body.matchAll(INLINE_FILE_RE)) {
    const path = m[1]!;
    if (path.startsWith("/") || path.startsWith("~") || path.split("/").includes("..")) return path;
  }
  return null;
}

/** Name shape, mirrored from the core so a malformed name never reaches a prompt. */
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}(?::[A-Za-z0-9][A-Za-z0-9_-]{0,62})?$/;

/** Split a markdown file into frontmatter lines and body. */
function splitFrontmatter(text: string): { front: Record<string, string>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { front: {}, body: text };
  const front: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (kv) front[kv[1]!.toLowerCase()] = kv[2]!.trim().replace(/^["']|["']$/g, "");
  }
  return { front, body: m[2] ?? "" };
}

/**
 * Every skill Condotto will dispatch for this session, keyed by lowercased name.
 *
 * `repoRoot` contributes only when the repo is trusted — untrusted repos do not
 * load their own `.claude/` at all (`settingSources`), so offering their skills
 * would promise something the runtime would refuse. A name claimed by more than
 * one source is dropped with a reason: silently picking one is exactly the
 * confusion this enumeration exists to prevent.
 */
export function enumerateSkills(opts: {
  /** Worktree (or worktree root) — the dir CONTAINING `.claude/`. */
  repoRoot?: string;
  /** The operator's home directory — the dir CONTAINING `.claude/`, not `~/.claude` itself. */
  operatorHome?: string;
  log?: (msg: string) => void;
}): { skills: HarnessSkill[]; refused: Map<string, string> } {
  const found = new Map<string, HarnessSkill[]>();
  const refused = new Map<string, string>();

  const sources: { base: string; source: HarnessSkill["source"] }[] = [
    ...(opts.repoRoot ? [{ base: opts.repoRoot, source: "repo" as const }] : []),
    ...(opts.operatorHome ? [{ base: opts.operatorHome, source: "operator" as const }] : []),
  ];

  for (const { base, source } of sources) {
    for (const { rel, kind } of SKILL_DIRS) {
      const dir = join(base, rel);
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue; // no such directory is the normal case, not an error
      }
      for (const entry of entries) {
        // A skill is `<name>/SKILL.md`; a legacy command is `<name>.md`.
        const path = kind === "skill" ? join(dir, entry, "SKILL.md") : join(dir, entry);
        const nameFromPath = kind === "skill" ? entry : entry.replace(/\.md$/i, "");
        if (kind === "command" && !/\.md$/i.test(entry)) continue;
        let text: string;
        try {
          text = readFileSync(path, "utf8");
        } catch {
          continue;
        }
        const { front, body } = splitFrontmatter(text);
        const name = (front.name || nameFromPath).trim();
        const key = name.toLowerCase();
        if (!SKILL_NAME_RE.test(name)) {
          refused.set(key, "its name isn't a shape Condotto will dispatch");
          continue;
        }
        const badFront = REFUSED_FRONTMATTER.find(
          (r) => front[r.key] !== undefined && (r.value === undefined || front[r.key]!.toLowerCase() === r.value),
        );
        if (badFront) {
          refused.set(key, badFront.why);
          continue;
        }
        // An escaping `@path` is refused: it inlines a file during expansion, with
        // no Read call and therefore no confinement check.
        const escaping = inlinesFileOutsideWorktree(body);
        if (escaping) {
          refused.set(key, `it inlines \`${escaping}\` with \`@\`, which reaches outside the worktree`);
          continue;
        }
        // Inline shell (`` !`cmd` ``) runs during expansion, before the model and
        // before our hook. It is allowed: a skill that gathers context this way is
        // a skill working as designed, and these are your own skills in your own
        // repo. Worth saying once in the listing so nobody is surprised that a
        // skill runs a command before it starts.
        const warning = INLINE_SHELL_RE.test(body)
          ? "runs shell inline to gather context, before the turn starts"
          : undefined;
        const skill: HarnessSkill = {
          name,
          source,
          path,
          ...(front.description ? { description: front.description } : {}),
          ...(warning ? { warning } : {}),
        };
        found.set(key, [...(found.get(key) ?? []), skill]);
      }
    }
  }

  const skills: HarnessSkill[] = [];
  for (const [key, matches] of found) {
    if (refused.has(key)) continue;
    if (matches.length > 1) {
      // Which one the runtime would actually pick is unstated, and the architect
      // typed a name expecting a specific file. Refuse rather than guess.
      refused.set(key, `two skills claim that name (${matches.map((m) => m.path).join(" and ")})`);
      continue;
    }
    skills.push(matches[0]!);
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, refused };
}

/**
 * The SDK warns — with a full stack trace, on EVERY query() — that read-only
 * tools are "shadowed" from canUseTool by allowedTools
 * (CLAUDE_SDK_CAN_USE_TOOL_SHADOWED). For Condotto that is expected and correct:
 * read-only tools are auto-approved by allowedTools and confined by the
 * PreToolUse hook, so they must never reach the deny-by-default canUseTool
 * backstop — only gated tools do. Left alone it masquerades
 * as an error in the daemon log after every turn. Silence exactly that one
 * warning code (nothing else) across every emission path. Idempotent; runs once
 * on import so both the daemon and the smoke scripts get clean output.
 */
const SDK_SHADOW_WARNING = "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED";
let sdkWarningsSuppressed = false;
function suppressKnownSdkWarnings(): void {
  if (sdkWarningsSuppressed) return;
  sdkWarningsSuppressed = true;
  const mentions = (v: unknown): boolean => {
    if (typeof v === "string") return v.includes(SDK_SHADOW_WARNING);
    if (v && typeof v === "object") {
      const o = v as { code?: unknown; message?: unknown };
      if (o.code === SDK_SHADOW_WARNING) return true;
      if (typeof o.message === "string" && o.message.includes(SDK_SHADOW_WARNING)) return true;
    }
    return false;
  };
  for (const method of ["warn", "error"] as const) {
    const orig = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      if (!args.some(mentions)) orig(...args);
    };
  }
  const origEmit = process.emitWarning.bind(process);
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const opt = rest[0];
    const code = opt && typeof opt === "object" ? (opt as { code?: unknown }).code : rest[1];
    if (code === SDK_SHADOW_WARNING || mentions(warning)) return;
    return (origEmit as (...a: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}
suppressKnownSdkWarnings();

/** Abort a turn if the SDK produces nothing at all for this long. */
const TURN_INACTIVITY_MS = 10 * 60_000;
/** After we ask for an interrupt, wait only this long to drain the final result's
 *  cost before giving up (the SDK settles the aborted turn fast — spike b, ~567ms). */
const DRAIN_AFTER_ABORT_MS = 30_000;

/**
 * rider (a): env-scrub the agent shell. The SDK's `options.env` REPLACES the
 * subprocess environment entirely (sdk.d.ts:1411), so this is a DENYLIST over a
 * spread of `process.env`: drop the daemon's own secret namespaces (`SLACK_*`,
 * `CONDOTTO_*`) so an in-worktree Bash command can never read the daemon's Slack
 * tokens or config from its own environ, while PRESERVING everything the toolchain
 * and the Claude Code CLI need — `PATH`/`HOME`, the repo's build env, and the Claude
 * auth token (which never matches these prefixes, so keychain OAuth AND a headless
 * `CLAUDE_CODE_OAUTH_TOKEN` both survive). Belt-and-braces over the  policy floor
 * (credential/secret hard-deny stays); spike-proven under keychain OAuth
 * (verified 2026-07-19). Distinct from CommandRunner's scrub, which
 * drops a fixed NAME list incl. the Claude auth token because a deploy command,
 * unlike the agent, does not need it.
 */
const DAEMON_SECRET_ENV_PREFIXES = ["SLACK_", "CONDOTTO_"];

/**
 * The resolved harness credential, handed down by the composition root. Structurally
 * `core/config`'s `AuthConfig`, restated locally so the adapter depends on the shape
 * rather than importing a core type through the port.
 */
export type HarnessAuth = { mode: "api_key" | "subscription"; apiKey?: string };
export function scrubDaemonEnv(base: NodeJS.ProcessEnv, auth?: HarnessAuth): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (DAEMON_SECRET_ENV_PREFIXES.some((p) => k.startsWith(p))) continue;
    out[k] = v;
  }
  // Three states, deliberately distinct. NO auth argument — tests and the
  // scripts/smoke-* harnesses, which construct the adapter bare — means inherit
  // whatever the environment has, exactly as before this parameter existed; a
  // smoke run under api_key auth must still pick up the operator's key.
  if (!auth) return out;
  // A RESOLVED auth config, from the daemon's composition root, is authoritative:
  // api_key installs the chosen key, and subscription deletes any ANTHROPIC_API_KEY
  // the daemon happened to inherit, so a stray shell-profile export can't silently
  // bill an operator who configured subscription auth. Keychain OAuth and a headless
  // CLAUDE_CODE_OAUTH_TOKEN are untouched in every state.
  if (auth.mode === "api_key" && auth.apiKey) out.ANTHROPIC_API_KEY = auth.apiKey;
  else delete out.ANTHROPIC_API_KEY;
  return out;
}

/** rider (b): the reason a turn's query was interrupted, for the notice. */
type AbortReason = "timeout" | "cancel" | "budget";
function abortNotice(reason: AbortReason, sawWorkflow: boolean, costUsd: number | undefined): string {
  const what = sawWorkflow ? "the running workflow" : "the running turn";
  const spent = costUsd !== undefined ? ` ($${costUsd.toFixed(2)} spent this turn)` : "";
  switch (reason) {
    case "timeout":
      return `I stopped ${what} after 10 minutes with no activity${spent}.`;
    case "cancel":
      return `Cancelled — I stopped ${what}${spent}.`;
    case "budget":
      return (
        `I hit this thread's cost budget and stopped ${what}${spent}. ` +
        `An architect can raise it with \`@Condotto budget <usd>\` to continue.`
      );
  }
}

/** Bound what a persisted — or corrupted — handle can carry back into memory. */
const MAX_RUNTIME_COMMANDS = 500;
const MAX_COMMAND_NAME_LEN = 64;

function asHandle(handle: SessionHandle): ClaudeCodeHandle {
  const h = handle as Partial<ClaudeCodeHandle> | null;
  if (!h || h.v !== 1 || (h.sessionId !== null && h.sessionId !== undefined && typeof h.sessionId !== "string")) {
    throw new Error("claude-code: unrecognized session handle");
  }
  // A legacy (pre-skills) handle and a corrupted one are treated alike: an unusable
  // cross-check list degrades to "not known", never to a thrown turn. This list is
  // advisory — the dispatchable set comes from our own enumeration — so losing it
  // costs a log line, not a capability.
  const raw = Array.isArray(h.runtimeCommands) ? h.runtimeCommands : null;
  const runtimeCommands = raw
    ? raw
        .filter((s): s is string => typeof s === "string" && s.length > 0 && s.length <= MAX_COMMAND_NAME_LEN)
        .slice(0, MAX_RUNTIME_COMMANDS)
    : undefined;
  return { v: 1, sessionId: h.sessionId ?? null, ...(runtimeCommands ? { runtimeCommands } : {}) };
}

/** True when running inside a `bun build --compile` binary: its module URLs live
 *  in Bun's virtual FS (`/$bunfs/` POSIX, `~BUN` Windows) rather than on disk. */
function isCompiledBinary(): boolean {
  return import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN");
}

/**
 * The native `claude` CLI the SDK spawns as its runtime subprocess.
 *
 * Under `bun run` (dev / clone-and-run) the SDK resolves it from `node_modules`
 * itself — return `undefined` and change nothing. A `bun build --compile` binary
 * can't: the SDK resolves its native CLI relative to a `$bunfs` path no child
 * process can exec, and the 236MB per-platform package was never bundled. So when
 * compiled, point the SDK at a real `claude`, in priority order:
 *   1. CONDOTTO_CLAUDE_CLI — explicit operator override (any installed `claude`,
 *      or a custom sidecar path). `extractFromBunfs` is a no-op on a real path
 *      and future-proofs an embedded (`type: "file"` → `$bunfs`) path pointed here.
 *   2. a `claude` sidecar next to the compiled binary — the default release
 *      bundle (`condotto` + `claude` shipped together).
 * Gated on the compiled-binary signal so a dev box with Claude Code installed
 * next to `bun` (e.g. /opt/homebrew/bin/claude) is never silently picked up.
 */
function resolveClaudeCliPath(): string | undefined {
  const override = process.env.CONDOTTO_CLAUDE_CLI?.trim();
  if (override) {
    const resolved = extractFromBunfs(override);
    if (existsSync(resolved)) return resolved;
    console.warn(
      `[claude-code] CONDOTTO_CLAUDE_CLI="${override}" does not exist — ignoring it and falling ` +
        `back to the SDK's own CLI resolution.`,
    );
  }
  if (isCompiledBinary()) {
    // Name must match what scripts/build-binary.ts ships beside the binary
    // (claude.exe on Windows, claude elsewhere) — Node's existsSync is a literal
    // path check, not a PATHEXT lookup.
    const claudeName = process.platform === "win32" ? "claude.exe" : "claude";
    const sidecar = join(dirname(process.execPath), claudeName);
    if (existsSync(sidecar)) return sidecar;
    console.warn(
      `[claude-code] running as a compiled binary but found no '${claudeName}' CLI beside it ` +
        `(${dirname(process.execPath)}) and CONDOTTO_CLAUDE_CLI is unset — the agent runtime will ` +
        `fail to start. Ship the native '${claudeName}' next to the binary or set CONDOTTO_CLAUDE_CLI.`,
    );
  }
  return undefined;
}

// Resolved lazily on first turn (not at module load) so `--help`/`--version` in
// a compiled binary never emit the resolution warning. The path is process-
// stable (execPath/env don't change mid-run), so memoize the first result —
// `undefined` included.
let claudeCliPathMemo: { value: string | undefined } | undefined;
function claudeCliPath(): string | undefined {
  return (claudeCliPathMemo ??= { value: resolveClaudeCliPath() }).value;
}

class ClaudeCodeSession implements HarnessSession {
  constructor(
    private _handle: ClaudeCodeHandle,
    private cwd: string,
    /** Condotto protocol prompt (preset append). Supplied fresh each turn. */
    private system: string,
    /** The SDK query function (injectable for tests). */
    private queryFn: QueryFn,
    /** Inactivity watchdog window; overridable so tests can exercise the timeout→
     *  interrupt→drain path without waiting 10 minutes. Defaults to the constant. */
    private turnInactivityMs: number = TURN_INACTIVITY_MS,
    /**
     * The enclosing tree the agent must reach when `cwd` is a monorepo
     * sub-project — the worktree root. Undefined (or equal to `cwd`) for an
     * ordinary session. See `additionalDirectories` at the query below.
     */
    private root?: string,
    /**
     * The resolved harness credential, or undefined to inherit the ambient
     * environment (tests / smoke harnesses). Never read from the environment here.
     */
    private auth?: HarnessAuth,
  ) {}

  /** The in-flight query, so an out-of-band interrupt() can reach it.
   *  Null when no turn is running. */
  private activeQuery: ReturnType<QueryFn> | null = null;
  /** Set when interrupt() actually fired on the active query — the turn loop then
   *  drains the aborted result's cost and reports a cancellation instead of an error. */
  private cancelRequested = false;

  get handle(): SessionHandle {
    return this._handle;
  }

  /**
   * Enumerated once per session and cached, because `listSkills()` is synchronous
   * by contract and answers `@Condotto skills` — a listing must not do filesystem
   * work on every call, and it must work before any turn has run.
   */
  private skillCache: HarnessSkill[] | null = null;

  listSkills(): readonly HarnessSkill[] | null {
    if (this.skillCache) return this.skillCache;
    // Both sources are enumerated here, tagged by `source`: the repo's own
    // `.claude/skills` and the operator's `~/.claude/skills`. Both are reachable.
    const { skills, refused } = enumerateSkills({
      repoRoot: this.root ?? this.cwd,
      operatorHome: homedir(),
    });
    for (const [name, why] of refused) {
      console.warn(`[claude-code] not offering skill "${name}": ${why}`);
    }
    this.skillCache = skills;
    return skills;
  }

  /**
   * The prompt for a turn. A skill is dispatched by putting `/name args` at the
   * START of the prompt — verified end to end (spike 2026-07-25), including with
   * `SlashCommand` still in `disallowedTools` and with `resume` set. Minting the
   * `/` is this adapter's job and only this adapter's; the core passes a bare name.
   */
  private buildPrompt(input: TurnInput): string {
    if (!input.skill) return input.text;
    const args = input.skill.args?.trim();
    return `/${input.skill.name}${args ? ` ${args}` : ""}`;
  }

  async *turn(input: TurnInput, gate: GateFn): AsyncIterable<TurnEvent> {
    // Fresh per turn — a stale flag from a prior cancel must not taint this turn.
    this.cancelRequested = false;
    // Fail closed on a skill name this adapter would not itself offer. The core
    // already checks membership, but a cold or stale core-side list must never be
    // a bypass — and refusing HERE means no query is spawned at all.
    if (input.skill) {
      const wanted = input.skill.name.toLowerCase();
      const match = (this.listSkills() ?? []).find((s) => s.name.toLowerCase() === wanted);
      if (!SKILL_NAME_RE.test(input.skill.name) || !match) {
        yield { kind: "error", message: `I don't have a skill called \`/${input.skill.name}\` in this session.` };
        return;
      }
    }
    yield* this.runQuery(input, gate, /* allowFreshRetry */ true);
  }

  private async *runQuery(
    input: TurnInput,
    gate: GateFn,
    allowFreshRetry: boolean,
  ): AsyncGenerator<TurnEvent> {
    // The gate is THE security boundary — it must fail closed. A gate that
    // throws would otherwise fall through to the SDK permission system, where
    // allowedTools would silently auto-approve the call.
    const gateHook = async (hookInput: unknown, toolUseID: string | undefined) => {
      const call = hookInput as { tool_name?: string; tool_input?: unknown; agent_id?: string };
      let decision: Awaited<ReturnType<GateFn>>;
      try {
        decision = await gate({
          id: toolUseID ?? "",
          name: call.tool_name ?? "unknown",
          input: call.tool_input,
          // Present ONLY inside a subagent. The core policy treats
          // subagent-initiated calls read-only (gated actions denied) since a
          // subagent call can't be paused for approval (defer is main-thread-only).
          agentId: call.agent_id,
        });
      } catch (err) {
        decision = { decision: "deny", reason: `gate error (denied fail-closed): ${err}` };
      }
      // Map the domain decision onto the SDK's PreToolUse contract.
      const out =
        decision.decision === "allow"
          ? {
              permissionDecision: "allow" as const,
              updatedInput: decision.updatedInput as Record<string, unknown> | undefined,
            }
          : { permissionDecision: "deny" as const, permissionDecisionReason: decision.reason };
      return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, ...out } };
    };

    // Per-turn harness capabilities (opaque config from the core): model/effort
    // tune the implementer, subagents/workflows toggle the multi-agent tools.
    const h = input.harness;
    const { tools, allowedTools, disallowedTools } = toolPosture(h);
    const model = resolveModel(h?.model);
    const effort = resolveEffort(h?.effort);
    // Every repo loads its own project config: `CLAUDE.md`, `.claude/`, its
    // skills, its hooks. There used to be a per-repo `trusted` flag deciding this
    // and it was deleted 2026-07-26 — Condotto runs on one team's own machine
    // against their own repos, and refusing to read the conventions they wrote is
    // ceremony rather than safety.
    //
    // The operator's own `~/.claude` skills reach the agent in either case:
    // omitting the `skills` option is documented as "no SDK auto-configuration,
    // the CLI's own defaults still apply", which is explicitly not "skills off".
    const settingSources: ("user" | "project" | "local")[] = ["project"];

    // Workflows run under bypassPermissions ONLY so the background workflow's
    // sub-agent tool calls route through the PreToolUse hook (agent_id-tagged) where
    // the policy confines them — NOT to weaken gating. Hooks outrank permission
    // mode, so main-agent defer/deny and the canUseTool backstop still hold (spike
    // 2026-07-18: diag3/diag4). Non-workflow sessions stay "default" (unchanged).
    //
    // Plan mode wins over workflows: the option holds one value, and a workflow
    // launch is gate-tier, which the policy denies while planning — so
    // bypassPermissions would be a mode with nothing left to serve. The core
    // already stops sending `workflows` during plan mode; this ordering is the
    // belt to that braces. Verified 2026-07-25 (spike Q1): the PreToolUse hook
    // still fires under "plan" and `defer` still yields deferred_tool_use, so the
    // whole gate handshake survives the mode.
    const permissionMode = h?.planMode
      ? ("plan" as const)
      : h?.workflows
        ? ("bypassPermissions" as const)
        : ("default" as const);

    // The canUseTool backstop runs the CORE policy on an `escaped` call — one that
    // reached the permission flow instead of the hook. Same policy, same answer;
    // it exists so a call can never route around the boundary by taking a
    // different path. Fails closed on error.
    const canUseToolFn = async (toolName: string, toolInput: unknown) => {
      let decision: Awaited<ReturnType<GateFn>>;
      try {
        decision = await gate({ id: "", name: toolName, input: toolInput, escaped: true });
      } catch (err) {
        decision = { decision: "deny", reason: `gate error (denied fail-closed): ${err}` };
      }
      if (decision.decision === "allow") {
        return {
          behavior: "allow" as const,
          updatedInput: (decision.updatedInput ?? toolInput) as Record<string, unknown>,
        };
      }
      return { behavior: "deny" as const, message: decision.reason };
    };

    const q = this.queryFn({
      prompt: this.buildPrompt(input),
      options: {
        cwd: this.cwd,
        // A monorepo sub-project session starts BELOW the worktree root, but the
        // whole worktree stays in scope (shared packages, root config) — the
        // confinement boundary is the worktree, enforced by our PreToolUse hook.
        // The SDK models working roots at or below cwd, so name the root
        // explicitly or it would sit above the session and be unreachable. Omitted
        // when cwd already IS the root, keeping ordinary sessions byte-identical.
        ...(this.root && this.root !== this.cwd ? { additionalDirectories: [this.root] } : {}),
        resume: this._handle.sessionId ?? undefined,
        // rider (a): scrub the daemon's own SLACK_*/CONDOTTO_* secrets from the
        // environment the agent's Bash inherits (belt-and-braces over the  policy
        // floor). options.env REPLACES the subprocess env, so this is a denylist
        // spread of process.env that keeps PATH/HOME + the toolchain + the Claude
        // auth token the SDK needs (spike-proven under keychain OAuth).
        env: scrubDaemonEnv(process.env, this.auth),
        // Point the SDK at the native `claude` CLI when running as a compiled
        // binary; omitted under `bun run`, where the SDK finds it itself.
        ...(claudeCliPath() ? { pathToClaudeCodeExecutable: claudeCliPath()! } : {}),
        systemPrompt: { type: "preset", preset: "claude_code", append: this.system },
        // Which built-ins EXIST for this session (see BASE_TOOLS) — orthogonal to
        // allowedTools, which only says which of them skip the callback.
        tools,
        allowedTools,
        disallowedTools,
        permissionMode,
        // Exact SDK model id + reasoning effort. Omitted = SDK
        // defaults; the core always supplies them (default Opus 5 + xhigh).
        ...(model ? { model } : {}),
        ...(effort ? { effort: effort as "low" | "medium" | "high" | "xhigh" | "max" } : {}),
        // Intra-turn runaway brake. The SDK stops the turn if it
        // exceeds this, returning an `error_max_budget_usd` result we surface as
        // a clear Slack notice (never a silent stall). The core passes the
        // session's remaining thread headroom; omitted = no per-turn cap.
        ...(typeof input.budgetUsd === "number" && input.budgetUsd > 0
          ? { maxBudgetUsd: input.budgetUsd }
          : {}),
        // When subagents are enabled, offer the read-only `explorer`
        // subagent (restricted toolset — defense-in-depth over the gate).
        ...(h?.subagents ? { agents: SUBAGENT_DEFS } : {}),
        // Load the trusted repo's skills alongside its project settings.
        skills: "all" as const,
        // Untrusted (default): never load filesystem settings (CLAUDE.md,
        // .mcp.json, .claude/) from the worktree — repo content is untrusted
        // input and must not register MCP servers or alter permissions.
        settingSources,
        // The `settings` tier is the highest user-controlled layer and applies
        // regardless of `settingSources`, so both keys below are PINNED in both
        // directions rather than left to a default a repo could move.
        settings: {
          // Auto-memory. The `settings` tier is the highest user-controlled layer and
          // applies regardless of `settingSources`, so this PINS the posture in both
          // directions rather than relying on a default:
          //   on  — point it at the core's proven per-(repo, channel) directory. The
          //         SDK default is keyed on the SANITIZED CWD (sdk.d.ts:6378), i.e. a
          //         worktree that gets destroyed, so without this memory cannot persist.
          //   off — explicitly false, so a repo's checked-in settings cannot switch
          //         memory on by themselves. Memory outlives the worktree, which is
          //         what makes it worth the operator naming the repo.
          // The agent writes memory with ordinary Write/Edit, so those calls hit the
          // hook below and the core's memory rules govern them (spike 2026-07-20).
          // NOTE: deliberately NOT added to `additionalDirectories` — the spike showed
          // the write lands without it, so widening the SDK's own scope buys nothing.
          ...(h?.memoryDir
            ? { autoMemoryEnabled: true, autoMemoryDirectory: h.memoryDir }
            : { autoMemoryEnabled: false }),
          // Where the runtime writes plan files. REQUIRED whenever plan mode is on,
          // and the core supplies it absolute (see HarnessTurnOptions.plansDir).
          // Two facts make this load-bearing rather than cosmetic, both verified
          // 2026-07-25 (spike Q3):
          //   - the default is `~/.claude/plans/`, OUTSIDE the worktree, which
          //     policy.ts hard-denies with no approval possible — the agent could
          //     never present a plan at all;
          //   - a RELATIVE value resolves against `cwd`, which for a monorepo
          //     session is the sub-project rather than the worktree root.
          // The plan file is also how a plan reaches Condotto: the runtime exposes
          // no plan-exit tool headless, so the model presents a plan by writing it
          // here, and that write carries the plan as `content` through the hook.
          ...(h?.planMode && h.plansDir ? { plansDirectory: h.plansDir } : {}),
        },
        // Replaces the plan-mode reminder's default code-implementation workflow
        // body; the CLI still wraps it with its own read-only preamble and plan
        // protocol. Shape only — the RULES of plan mode live in the core system
        // prompt, which is re-supplied on every resume, so two texts can't drift
        // into disagreeing about what is allowed.
        ...(h?.planMode ? { planModeInstructions: PLAN_MODE_INSTRUCTIONS } : {}),
        hooks: { PreToolUse: [{ hooks: [gateHook] }] },
        // Backstop for calls that reach the permission flow instead of the hook.
        // Runs the same core policy, so the answer is identical either way.
        canUseTool: canUseToolFn,
      },
    });

    // Expose the running query so an out-of-band interrupt() (architect `@Condotto
    // cancel`) can reach it. Cleared in the finally.
    this.activeQuery = q;
    let sawResult = false;
    // A workflow turn produces MULTIPLE `result` messages: an intermediate
    // "workflow launched; waiting…" success, then the FINAL synthesized success
    // once the background workflow completes (spike 2026-07-18). Buffer the latest
    // success and deliver only it at turn end, so the human sees the real answer,
    // not "launched; waiting". A terminal deferred/error supersedes and clears it.
    let pendingReply: { text: string; costUsd?: number } | null = null;
    // Track the background workflow so we can stream a live status
    // line and tag the final reply for the summary footer.
    let sawWorkflow = false;
    let lastWorkflowDesc = "";
    // rider (b): when a turn is interrupted — inactivity timeout, an architect
    // `@Condotto cancel`, or a budget breach that hit a RUNNING workflow — we stop the
    // (possibly detached) background task and DRAIN the aborted result's cost into the
    // ledger, then post one notice. `q.interrupt()` is the only lever that actually
    // halts a detached workflow (maxBudgetUsd does NOT — spike b), and the aborted
    // result still carries total_cost_usd, so the runaway cap stays accurate.
    let abortReason: AbortReason | null = null;
    let drainedCost: number | undefined;
    try {
      const iterator = q[Symbol.asyncIterator]();
      // A SINGLE in-flight pull, re-raced against the timeout across abort re-arms. It
      // must be reused (not re-created) on a timeout: Promise.race leaves the losing
      // iterator.next() pending, and a fresh next() would be queued BEHIND it — so the
      // stale pull would swallow the interrupt's aborted result (and its cost) and the
      // new one would get `done`. Advance `pending` only after actually consuming a step.
      let pending = iterator.next();
      while (true) {
        // Inactivity watchdog: a wedged SDK query must not hang the session's turn
        // queue forever. Once we're draining after an abort, wait only briefly for
        // the aborted result's cost before giving up (the SDK settles fast).
        let timer: ReturnType<typeof setTimeout> | undefined;
        // Once ANY interrupt is in flight (an in-loop abort OR an out-of-band cancel),
        // wait only briefly for the aborted result's cost, not the full inactivity window.
        const aborting = abortReason !== null || this.cancelRequested;
        const waitMs = aborting ? DRAIN_AFTER_ABORT_MS : this.turnInactivityMs;
        const timeout = new Promise<"timeout">((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout("timeout"), waitMs);
        });
        let step: IteratorResult<Record<string, any>> | "timeout";
        try {
          step = await Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
        } catch (pullErr) {
          // After an interrupt/abort the SDK can THROW on the pull that FOLLOWS the
          // terminal result (observed: [ede_diagnostic] … stop_reason=tool_use — spike
          // b). The result + cost already arrived, so if an abort is in flight this is
          // the expected clean end. Otherwise it's a real failure — rethrow.
          if (aborting) break;
          throw pullErr;
        }
        if (step === "timeout") {
          // Already interrupting and the aborted result didn't arrive in time — give up
          // on the cost rather than waiting/re-interrupting forever.
          if (aborting) break;
          // No SDK activity for 10 minutes. Interrupt to halt any detached background
          // workflow (which would otherwise keep spending after the turn parks), then
          // re-race the SAME `pending` so the interrupt's aborted result is drained.
          abortReason = "timeout";
          await q.interrupt().catch(() => {});
          continue;
        }
        if (step.done) break;
        // Consumed a real message — prefetch the next one on a fresh pull.
        pending = iterator.next();

        const m = step.value as Record<string, any>;
        if (m.type === "system" && m.subtype === "init") {
          // The init message carries the session id AND the runtime's own list of
          // dispatchable commands. Emit once if EITHER changed: on a resume the
          // session id is unchanged while the command set may have moved, and
          // nesting the emit inside the id check would drop that update forever.
          const nextId: string | null = m.session_id ?? this._handle.sessionId;
          const commands: string[] | undefined = Array.isArray(m.slash_commands)
            ? m.slash_commands
                .filter((s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= MAX_COMMAND_NAME_LEN)
                .slice(0, MAX_RUNTIME_COMMANDS)
            : undefined;
          const nextCommands = commands ?? this._handle.runtimeCommands;
          const changed =
            nextId !== this._handle.sessionId ||
            JSON.stringify(nextCommands ?? null) !== JSON.stringify(this._handle.runtimeCommands ?? null);
          if (changed) {
            this._handle = {
              ...this._handle,
              sessionId: nextId,
              ...(nextCommands ? { runtimeCommands: nextCommands } : {}),
            };
            yield { kind: "handle_updated", handle: this._handle };
          }
          // Cross-check: we dispatch from our OWN enumeration, so a name the runtime
          // does not list would fail as "Unknown command" with no explanation. This
          // is the only place the two lists can be compared.
          if (commands && input.skill) {
            const listed = commands.some((c) => c.replace(/^\//, "").toLowerCase() === input.skill!.name.toLowerCase());
            if (!listed) {
              console.warn(
                `[claude-code] dispatching /${input.skill.name} but the runtime did not list it ` +
                  `(${commands.length} commands reported) — expect "Unknown command".`,
              );
            }
          }
          continue;
        }
        // A local slash command can answer without running the model loop at all
        // (/context, /usage). Its output arrives here rather than as an assistant
        // message, and `terminal_reason` is unset when the loop was bypassed — so
        // without this the turn could report "produced no result" while the command
        // had in fact answered. Buffered like any reply: a real `result` later in
        // the same turn supersedes it, which is what happens for an unknown command
        // (observed: the text comes back on `result`, not here).
        if (m.type === "system" && m.subtype === "local_command_output") {
          const text = typeof m.content === "string" ? m.content.trim() : "";
          if (text) pendingReply = { text };
          continue;
        }
        // A running workflow emits background-task lifecycle system
        // messages (task_started/task_progress/task_updated, background_tasks_
        // changed). Note the workflow ran, and stream a live status line — but only
        // when the description changes (task_progress repeats per agent as tokens
        // accumulate). Each such message also resets the inactivity watchdog above.
        if (m.type === "system" && typeof m.subtype === "string" && (m.subtype.startsWith("task") || m.subtype === "background_tasks_changed")) {
          sawWorkflow = true;
          const desc = describeWorkflowEvent(m);
          if (desc && desc !== lastWorkflowDesc) {
            lastWorkflowDesc = desc;
            yield { kind: "progress", text: desc };
          }
          continue;
        }
        if (m.type === "assistant") {
          const blocks: any[] = m.message?.content ?? [];
          for (const block of blocks) {
            if (block?.type === "tool_use") {
              yield { kind: "progress", text: describeToolUse(block.name, block.input) };
            }
          }
          continue;
        }
        if (m.type === "result") {
          sawResult = true;
          // total_cost_usd is reported on EVERY result — success, deferred, and
          // error (incl. error_max_budget_usd) — so the core's cost ledger and
          // runaway cap count all of them (verified against SDKResult* types).
          const cost = typeof m.total_cost_usd === "number" ? m.total_cost_usd : undefined;
          // An architect `@Condotto cancel` interrupted this turn out-of-band: the SDK
          // now emits an aborted result. Capture its cost and report the cancellation.
          if (this.cancelRequested && !abortReason) abortReason = "cancel";
          // Already aborting (cancel/timeout, or a budget breach handled just below):
          // just drain the cost; the single post-loop notice reports it.
          if (abortReason) {
            if (cost !== undefined) drainedCost = cost;
            continue;
          }
          if (m.subtype === "success") {
            // Buffer, don't yield: a later result may supersede this one (workflow
            // "launched" → "completed"). Delivered after the loop (last wins).
            pendingReply = {
              text: typeof m.result === "string" && m.result.length > 0 ? m.result : "(no reply)",
              costUsd: cost,
            };
          } else if (m.subtype === "error_max_budget_usd" || m.terminal_reason === "budget_exhausted") {
            if (sawWorkflow) {
              // The budget brake fired DURING a workflow. The SDK signal alone does
              // NOT stop the detached background task — it keeps spending past the cap
              // (spike b). Interrupt to actually halt it (auto-cancel on breach), then
              // drain + report once via the post-loop notice.
              abortReason = "budget";
              if (cost !== undefined) drainedCost = cost;
              await q.interrupt().catch(() => {});
              continue;
            }
            // The turn hit its cost budget and stopped. Surface it clearly
            // with the spend — the core will then pause the session.
            pendingReply = null;
            yield {
              kind: "error",
              message:
                `I hit this turn's cost budget${cost !== undefined ? ` ($${cost.toFixed(2)})` : ""} and ` +
                `stopped before finishing. An architect can raise the budget to let me continue.`,
              costUsd: cost,
            };
          } else {
            pendingReply = null;
            yield { kind: "error", message: `session turn ended abnormally (${m.subtype})`, costUsd: cost };
          }
        }
      }
      // A cancel whose interrupt-throw arrived before any aborted result still counts
      // as an abort (no cost to drain, but report it cleanly rather than as "no reply").
      // BUT if the turn had already buffered a completed success when the cancel landed
      // (the cancel raced a just-finished turn), deliver that reply + its cost — dropping
      // it would lose the reply AND under-count the turn's spend against the runaway cap.
      const abort: AbortReason | null = abortReason ?? (this.cancelRequested && !pendingReply ? "cancel" : null);
      if (abort) {
        yield { kind: "error", message: abortNotice(abort, sawWorkflow, drainedCost), costUsd: drainedCost };
      } else if (pendingReply) {
        // Deliver the final buffered reply (the last success result of the turn).
        yield { kind: "reply", text: pendingReply.text, costUsd: pendingReply.costUsd, workflow: sawWorkflow };
      }
    } catch (err) {
      // A persisted session id the runtime no longer knows (pruned storage,
      // moved machine) would otherwise wedge the thread forever. Recover by
      // starting fresh once: context is lost but the conversation continues.
      const message = err instanceof Error ? err.message : String(err);
      // Recover a normal message turn by starting fresh — but NEVER an
      // approval-resume (empty prompt): a fresh session would silently drop the
      // just-approved action and wipe context (#10). Let that surface as error.
      //
      // NEVER a skill turn either, and for the opposite reason. A skill turn also
      // carries `text: ""`, so guarding on `input.text` alone would refuse to
      // recover it; but "recovering" it means re-dispatching `/ship` into a brand
      // new session, running a side-effecting command a SECOND time. An error the
      // architect can see and re-issue is strictly better than a silent double run.
      if (
        allowFreshRetry &&
        // Never retry an interrupted turn — the architect/timeout ended it on purpose.
        !this.cancelRequested &&
        !input.skill &&
        input.text.trim().length > 0 &&
        this._handle.sessionId &&
        /No conversation found/i.test(message)
      ) {
        this._handle = { ...this._handle, sessionId: null };
        yield { kind: "handle_updated", handle: this._handle };
        yield {
          kind: "progress",
          text: "previous session could not be resumed — starting fresh (prior context lost)",
        };
        yield* this.runQuery(input, gate, false);
        return;
      }
      throw err;
    } finally {
      // The query is done (or being abandoned) — stop routing interrupts to it so a
      // later `@Condotto cancel` on an idle session is a clean no-op, not a stray abort.
      if (this.activeQuery === q) this.activeQuery = null;
    }
    // A turn that produced no result at all (and wasn't an intentional abort) is an
    // error. An abort (timeout/cancel/budget) already yielded its own notice above, so
    // don't also emit "produced no result" — that would double-post a contradictory
    // message (e.g. a wedged query that times out with nothing drainable).
    if (!sawResult && !this.cancelRequested && !abortReason) {
      yield { kind: "error", message: "session turn produced no result" };
    }
  }

  /**
   * Interrupt the in-flight turn's query: halts a wedged/over-cap multi-agent
   * workflow — `q.interrupt()` is the only lever that actually stops the DETACHED
   * background task (spike b) — and lets the turn loop drain the aborted result's
   * cost. A no-op when no turn is running, so an architect `@Condotto cancel` on an
   * idle session does nothing. Only sets `cancelRequested` when a query is actually
   * live, so it can never taint a subsequent normal turn.
   */
  async interrupt(): Promise<void> {
    const q = this.activeQuery;
    if (!q) return;
    this.cancelRequested = true;
    await q.interrupt().catch(() => {});
  }
}

function describeToolUse(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "Read":
      return `reading ${i.file_path ?? "a file"}`;
    case "Glob":
      return `listing files matching ${i.pattern ?? "a pattern"}`;
    case "Grep":
      return `searching for ${i.pattern ?? "a pattern"}`;
    case "TodoWrite":
      return "updating its plan";
    case "Write":
      return `preparing to write ${i.file_path ?? "a file"}`;
    case "Edit":
    case "MultiEdit":
      return `preparing to edit ${i.file_path ?? "a file"}`;
    case "Bash":
      return `preparing to run a command`;
    case "Agent":
    case "Task":
      return `delegating to a subagent`;
    case "Workflow": {
      // The workflow script begins with `export const meta = { name, description }`.
      const meta = parseWorkflowMeta(i.script ?? i.scriptPath);
      return meta?.name ? `launching workflow \`${meta.name}\`` : `launching a multi-agent workflow`;
    }
    default:
      return `using ${name}`;
  }
}

/**
 * A live status line for a workflow background-task system message.
 * Returns null for events not worth surfacing. `task_progress.description` is the
 * per-agent activity (e.g. "Read: read-readme"); `background_tasks_changed` marks
 * the running set. Kept terse (Slack ergonomics) — the caller de-dups repeats.
 */
function describeWorkflowEvent(m: Record<string, any>): string | null {
  switch (m.subtype) {
    case "task_started":
      return m.description ? `workflow started: ${String(m.description).slice(0, 100)}` : "workflow started";
    case "task_progress":
      return m.description ? `workflow · ${String(m.description).slice(0, 100)}` : null;
    case "task_updated": {
      const status = m.patch?.status;
      return status ? `workflow ${String(status)}` : null;
    }
    case "background_tasks_changed": {
      const n = Array.isArray(m.tasks) ? m.tasks.length : 0;
      return n > 0 ? `workflow running (${n} background task${n === 1 ? "" : "s"})` : null;
    }
    default:
      return null;
  }
}

export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly id = "claude-code";
  /**
   * Injectable query (tests pass a fake); defaults to the real SDK `query`.
   * `turnInactivityMs` overrides the per-turn inactivity watchdog (tests only — lets
   * the timeout→interrupt→drain path be exercised without a 10-minute wait).
   */
  constructor(
    private queryFn: QueryFn = query as unknown as QueryFn,
    private turnInactivityMs: number = TURN_INACTIVITY_MS,
    /**
     * Harness credentials from the composition root (core/config loadAuthConfig).
     * UNDEFINED when the adapter is constructed bare — every test and every
     * scripts/smoke-* harness — in which case the agent inherits the ambient
     * environment exactly as it did before this parameter existed. Only the daemon
     * passes a resolved config, and only then does the credential become
     * authoritative. See scrubDaemonEnv.
     */
    private auth?: HarnessAuth,
  ) {}
  readonly capabilities: HarnessCapabilities = {
    mechanicalGating: true, // defer-based gating (verified), wired live
    resumeAfterRestart: true,
    // Under api_key auth total_cost_usd is real spend against the Console account;
    // under subscription auth it is notional API pricing (nothing is billed per
    // token) and serves only as a usage-governance signal. Budgets work the same
    // either way — only the meaning of the number changes.
    costReporting: true,
    imageInput: true, // the runtime accepts images; the TurnInput image path arrives with attachments
    // The tokens the core validates an architect's model/effort against.
    supportedModels: SUPPORTED_MODELS, // ["opus","sonnet","fable"]
    supportedEfforts: SUPPORTED_EFFORTS, // ["low","medium","high","xhigh","max"]
    // A human can dispatch a skill by name: `prompt: "/name args"` expands it
    // inline, which is the ONLY route to a `disable-model-invocation: true` skill
    // (that flag is enforced on the model-invocation route only). Verified live,
    // spike 2026-07-25.
    skillInvocation: true,
    // `permissionMode: "plan"` runs a read-only planning turn, and the PreToolUse
    // gate survives it intact — the hook still fires and `defer` still yields a
    // deferred_tool_use (spike 2026-07-25, Q1). The plan reaches Condotto as the
    // plan-file write, since the runtime exposes no plan-exit tool headless.
    planMode: true,
  };

  async create(opts: { cwd: string; system: string; root?: string }): Promise<HarnessSession> {
    return new ClaudeCodeSession(
      { v: 1, sessionId: null },
      opts.cwd,
      opts.system,
      this.queryFn,
      this.turnInactivityMs,
      opts.root,
      this.auth,
    );
  }

  async resume(handle: SessionHandle, cwd: string, system: string, root?: string): Promise<HarnessSession> {
    return new ClaudeCodeSession(
      asHandle(handle),
      cwd,
      system,
      this.queryFn,
      this.turnInactivityMs,
      root,
      this.auth,
    );
  }
}

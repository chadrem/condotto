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

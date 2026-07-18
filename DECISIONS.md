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

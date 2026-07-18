# Milestone 3 — kickoff

Paste-in seed for a fresh Claude Code session to start Milestone 3. Self-contained
state summary; the authority is still DESIGN.md (§8 build plan) + DECISIONS.md.

---

Continue Conduit development. Read DESIGN.md in full first, then DECISIONS.md and
CLAUDE.md — they are current and describe everything below. Everything is
committed AND pushed to origin/main (github.com/chadrem/conduit).

**State:** Milestones 0, 1, and 2 are DONE. M2 (policy engine + defer-based
approval loop + roles) is complete, adversarially reviewed, and verified LIVE in
the real Slack workspace (gated write → architect Approve → execution; member
click rejected). 82 tests green, tsc clean, `scripts/check-ports.ts` clean (runs
in the suite). The daemon boots, holds Socket Mode, and the M2 real-harness smoke
proves defer→approve→cross-process-resume→execute (`bun run smoke:gate` then
`smoke:approve` in separate processes).

**Code structure** (ports-and-adapters; core speaks only domain types):
- `src/core/`: `types.ts` (Principal, ConversationRef, ToolCall, GateFn returning
  allow|deny|gate, TurnEvent incl. `deferred`, Role, RepoConfig.safeBashAllowlist,
  ApprovalPrompt); `policy.ts` (pure `evaluate(call,ctx)->allow|gate|deny`:
  hard-deny first, then auto-allow read-only+worktree-confined & fully-allowlisted
  bash, else gate); `session-manager.ts` (approval-aware gate audits every tool
  call, executeTurn, handleApprovalDecision, per-session FIFO, park/resume,
  pending-approval guard); `store.ts` (bun:sqlite WAL; sessions/roles/approvals/
  audit_log/turns; UNIQUE(surface_id,conversation_id); roleOf/isArchitect,
  approvals keyed by tool_use_id, tryActivate, expirePendingApprovals, clearRoles,
  listAudit); `config.ts` (repos + roles from CONDUIT_ARCHITECTS /
  conduit.roles.json; DEFAULT_SAFE_BASH_ALLOWLIST); `worktrees.ts`; `framing.ts`
  (A1).
- `src/adapters/claude-code/adapter.ts` (Agent SDK: gate->PreToolUse defer,
  canUseTool deny-by-default backstop, deferred_tool_use detection, system prompt
  supplied fresh per create/resume, benign-warning suppression).
- `src/adapters/slack/adapter.ts` (Bolt Socket Mode: Approve/Deny buttons,
  injected domain-typed authority, block_actions handlers); `render.ts` (mrkdwn +
  approvalBlocks + resolveApprovalMessage).
- `src/daemon.ts` (composition root: role seeding, authority wiring).
- `scripts/` (check-ports, smoke-create/resume [M1], smoke-gate/gate-approve [M2]).
- `tests/` (policy, store, config, render, session-manager, ports, fakes.ts).

**Key facts already settled** (all in DECISIONS.md — do NOT re-derive or re-flag):
- Auth is subscription OAuth, no ANTHROPIC_API_KEY. Runtime is Bun 1.2+, run from
  source, no build step.
- Gating = PreToolUse `defer`; canUseTool is the deny-by-default backstop for the
  one batching caveat. SDK precedence: hooks→deny-rules→ask→permissionMode→
  allow-rules→canUseTool; a hook `deny` beats allowedTools; read-only tools are
  shadowed from canUseTool (expected & correct).
- The `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning is BENIGN and is suppressed in
  the adapter — do not treat it as an error or "fix" it.
- The system prompt is core policy, re-supplied on create AND resume (never frozen
  in the harness handle) — a posture change must reach existing sessions.
- `@slack/bolt` is PINNED to 4.x (5.x breaks under Bun). Slash commands can't run
  in threads: `/conduit assign` posts an anchor message; `@Conduit assign` claims
  an existing thread. Socket Mode auto-enables Slack Interactivity.
- Roles are config-authoritative (clearRoles + reseed at boot). The architect is
  seeded via `CONDUIT_ARCHITECTS=slack:UJYA5CHRA` in `.env` (gitignored) — the demo
  is ready to run.
- Development runs in the REAL company workspace (Acme); prefer a test
  channel. `/conduit assign` with no repo defaults to the throwaway `testrepo`.

**BUILD-TIME SAFETY** (still in force — this shapes M3): point sessions only at
the throwaway `testrepo` for anything that writes; wire land/deploy as no-ops/echo
FIRST; never a real repo's real deploy path until M4 hardening + gating review.
Real repos are registered in `conduit.repos.json` but for read-leaning use only.
So M3 builds the test/land/deploy MECHANISM and demos it on `testrepo` with
land/deploy as gated echo/no-ops; real repo + real deploy is M4.

**Possibly still open:** nothing blocking. If you want, re-run `bun test`, tsc,
and check-ports to confirm the green baseline before starting.

**Next work: Milestone 3** (DESIGN.md §8) — "Real work end-to-end":
1. Per-repo test/land/deploy commands (schema already has `repos.deploy_cmd`,
   `repos.land_cmd`, `safe_bash_allowlist`). Architect-ordered land/ship/deploy
   behind the gate (see DESIGN journey 4); land/deploy stay echo/no-op on
   `testrepo` until M4. The test command runs the repo's real tests.
2. Streaming progress into a single edited status message (improve the existing
   showProgress; don't flood — `chat.update` is rate-limited).
3. Multiple concurrent threads/sessions — verify in-process `query()` concurrency
   under load (§7); child-process isolation is a later call, not required here.
4. Cost budgets + runaway cap — per-thread cumulative `total_cost_usd` (turns
   table has `cost_usd`), a hard cap that pauses the session and pings the
   architect; wire the SDK's `error_max_budget_usd` result subtype to a Slack
   notice, not a silent stall.
5. Harden injection framing (Appendix A1) — red-team `framing.ts` against the
   content-forges-authority attack; add tests.
6. Production-data gate (§4) — reading the codebase is free; investigating
   production data is gated like a build and results in-thread are aggregates
   only. For M3 this is policy + system-prompt + audit (real prod creds are M4).

**Demo (defines done):** a PM reports a bug in a thread; the session diagnoses,
proposes a fix, gets architect approval, runs tests, "lands" on approval — all in
Slack, on the throwaway repo.

**Process:** keep DECISIONS.md updated; update DESIGN.md when reality disagrees.
Each milestone is independently demoable. Commit as you go on main; run the
multi-agent adversarial review (like M1/M2) before finishing; the user says when
to push. Throwaway repo only; land/deploy stay no-ops.

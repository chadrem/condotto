# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Conduit turns Slack threads into tickets that work themselves: each assigned thread gets a persistent Claude Code session running on a real dev machine, with humans (product + architect) and the AI implementer conversing in the thread. The daemon is built through **Milestone 3.6**: a ports-and-adapters core in `src/core/` (types, `bun:sqlite` store, session manager, policy engine, worktrees, A1 framing, `command-runner` for land/deploy) with Slack (`src/adapters/slack/`) and Claude Code (`src/adapters/claude-code/`) adapters. Live: gating + the defer-based approval loop; per-repo test/land/deploy (land/deploy daemon-run through the gate, echo/no-op on testrepo); cost budgets + runaway cap; a daemon-wide concurrency semaphore; the production-data gate; red-teamed injection framing; **M3.5 harness controls** — per-session model + effort (`@Conduit model`/`effort`, default Opus + high), architect opt-in subagents + an `ultra` preset, and trust-scoped project config (`trusted: true` repos load their `CLAUDE.md`/skills/`.claude/`); and **M3.6 workflows** — the multi-agent **Workflow** tool, re-enabled gated + confined (`@Conduit workflows on|off`, re-folded into `ultra`). The spike-first re-test INVERTED the M3.5 "workflows bypass the gate" finding: that was an artifact of `permissionMode:"default"`; under **`permissionMode:"bypassPermissions"`** (set only when workflows are on) the background workflow's sub-agent calls route THROUGH the PreToolUse hook with an `agent_id`, so the read-only subagent policy confines them (main-agent defer + the `canUseTool` backstop still hold — hooks outrank permission mode). Workflow UX: the **launch** is gated (Approve/Deny with the workflow's name/desc + a fan-out concern), live status streams the background-task lifecycle, and the synthesized reply carries a cost footer. An **informed worktree-write opt-in** (`@Conduit workflows write on|off`, mandatory warning) lets confined subagent/workflow/escaped calls write in the worktree without per-write approval (out-of-worktree/credential/prod-data stay hard-denied). **Known SDK limit:** a background workflow sub-agent's Grep/Bash/Write can be denied by the SDK's task permission upstream of our gate — best-effort (Read/Glob route reliably; the security boundary always holds). M0 spikes in `spikes/m0/`; M3.5 in `spikes/m3.5/`; M3.6 in `spikes/m3.6/`. `DESIGN.md` is still the authoritative, self-contained design document — read it before doing anything; this file only orients you.

## Process rules (from DESIGN.md)

- Execute the build plan in DESIGN.md §8. **M0, M1, M2, M3, M3.5, and M3.6 are done (2026-07-18).** M0 settled gating = `PreToolUse` `defer`; M1 shipped the Slack echo session (live demo clean); M2 added the policy engine + defer-based approval loop + roles (architect-only assign/stop/approvals, config-authoritative via `CONDUIT_ARCHITECTS`/`conduit.roles.json`); M3 added per-repo test/land/deploy (daemon-run through the gate), cost budgets + runaway cap, a concurrency semaphore, the production-data gate, and red-teamed injection framing; M3.5 exposed harness capabilities to the architect in-thread (Tier A model+effort, Tier B subagents + an `ultra` preset, Tier C trust-scoped project config), all behind the §4 gate; M3.6 re-enabled the multi-agent **Workflow** tool gated + confined (the M3.5 "bypasses the gate" finding was an artifact of `permissionMode:"default"` — `bypassPermissions` routes workflow sub-agent calls through the PreToolUse hook, agent_id-tagged, where the read-only subagent policy confines them) with a gated launch + live status + summary and an informed worktree-write opt-in. Full facts in DECISIONS.md. **Next up: Milestone 4** (dedicated box + scoped daemon credentials, session process isolation if needed, read-only Slack audit channel, worktree cleanup, real deploy paths behind the M4 gating review). Each milestone is independently demoable.
- Keep a `DECISIONS.md` log from M0 onward. Update DESIGN.md when reality disagrees with it.
- The Agent SDK facts in DESIGN.md §6/Appendix B were verified at writing time but **re-confirm any exact field name against the live docs** (URLs in Appendix B) before building on it. The former load-bearing unknown — `defer` and its resume handshake — was settled by the M0 spike (2026-07-16): resume re-drives the deferred call through `PreToolUse` with the same `tool_use_id`. See DESIGN.md §6 and DECISIONS.md.
- **Build-time safety:** while building, point the system only at a throwaway git repo — never a real repo or deploy path until M4 hardening. Wire deploy/land commands as no-ops/`echo` first. Slack development runs in the **real company workspace** (Acme) by explicit architect decision (2026-07-18, DECISIONS.md) — do not flag this as a violation; prefer a dedicated test channel.

## Toolchain

Runtime is **Bun 1.2+** — TypeScript run directly, no build step, no transpile.

- Run: `bun run <file>` — daemon and scripts run directly from source
- Test: `bun test` (built-in runner); single file: `bun test <path>`
- Deps: `bun add @anthropic-ai/claude-agent-sdk` (M0), `bun add @slack/bolt` (M1+). SQLite is built in via `bun:sqlite` — no package.
- Auth: the machine's Claude subscription login (keychain OAuth; verified headless 2026-07-16) — no `ANTHROPIC_API_KEY` in this deployment. Headless box alternative: `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`
- Distribution target: `bun build --compile` → single binary

The Agent SDK is developed against Node; M0 verified Bun compatibility (Bun 1.3.14 via Homebrew, 2026-07-16): spawn, streaming, hooks, `defer`, and resume all work. If a future SDK update trips on Bun, record the exact failure in `DECISIONS.md` and pick a hedge from §6 (isolate the SDK in a Node child process behind the harness port, or run the daemon on Node temporarily).

## Architecture (the shape to preserve)

One long-lived Bun daemon, ports-and-adapters. The core (session manager, policy engine, SQLite store, worktree manager) speaks only domain types and has exactly two seams:

- **Surface port** — how humans reach Conduit (Slack v1; Teams/email/SMS/web later). Adapters own their transport and prefer outbound connections (Slack: Bolt over Socket Mode — no public URL, hard requirement). Capabilities are flags (`threads`, `buttons`, `editMessages`, `identityStrength`), not a lowest common denominator.
- **Harness port** — how Conduit drives a coding agent (Claude Code via Agent SDK v1; others later). The non-negotiable capability is **mechanical gating**: pausing a tool call un-executed until the policy engine or a human approves. A harness that can't gate runs only under OS-level confinement or not at all. Never simulate gating by watching output.

**Port erosion is a review-blocking bug even with one adapter per seam:** no `@slack/bolt` or `@anthropic-ai/claude-agent-sdk` import outside `adapters/`; no `thread_ts` in the session manager; no SDK type in the policy engine. Domain types (`Principal`, `ConversationRef`, `ToolCall`) live in the core. Enforce with a lint rule once code exists.

## Security model (the heart of the product)

The daemon is by construction an RCE portal — text from Slack drives an agent with a shell. Non-negotiables from §4 and Appendix A:

- Authority attaches **only** to a surface-verified `Principal` (e.g. `slack:U0123ABC` from a genuine platform event) — never to display names, bot usernames, or message *content*. Approval clicks are verified server-side against the roles table.
- Tool calls are mechanically gated: auto-allow read-only, gate writes/bash-outside-allowlist/push/deploy behind architect approval, hard-deny a denylist no one can override.
- Thread content rendered into agent context must be unforgeable-by-content (framing rules in Appendix A1 — this exact injection was found in the prototype).
- Production-data reads are gated like builds; results in-thread are aggregates only.
- Audit every tool call, approval, and decision.

## Key invariants (enforce in code, not just schema)

- `(surface_id, conversation_id)` → exactly one session, forever: one conversation → one worktree → one harness session handle.
- `worktree_path` is stable and absolute — the SDK keys session storage by encoded cwd; moving a live session's worktree loses the session.
- `harness_session_handle` is opaque JSON owned by the harness adapter; the core persists it but never inspects it.
- Slack `ts` values are strings, never floats (leading zeros in the fractional part are significant).

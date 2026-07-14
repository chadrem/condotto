# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Conduit turns Slack threads into tickets that work themselves: each assigned thread gets a persistent Claude Code session running on a real dev machine, with humans (product + architect) and the AI implementer conversing in the thread. **There is no code yet** — `DESIGN.md` is the authoritative, self-contained design document. Read it before doing anything; this file only orients you.

## Process rules (from DESIGN.md)

- Execute the build plan in DESIGN.md §8, starting at **Milestone 0** (the gated-resume spike). Each milestone is independently demoable.
- Keep a `DECISIONS.md` log from M0 onward. Update DESIGN.md when reality disagrees with it.
- The Agent SDK facts in DESIGN.md §6/Appendix B were verified at writing time but **re-confirm any exact field name against the live docs** (URLs in Appendix B) before building on it. The one load-bearing unknown is `PreToolUse` `permissionDecision: "defer"` and its resume handshake — M0 exists to settle `defer` vs. `canUseTool` with a working spike, not on paper.
- **Build-time safety:** while building, point the system only at a throwaway git repo and a scratch Slack workspace — never a real repo, deploy path, or team channel until M4 hardening. Wire deploy/land commands as no-ops/`echo` first.

## Toolchain

Runtime is **Bun 1.2+** — TypeScript run directly, no build step, no transpile.

- Run: `bun run <file>` — daemon and scripts run directly from source
- Test: `bun test` (built-in runner); single file: `bun test <path>`
- Deps: `bun add @anthropic-ai/claude-agent-sdk` (M0), `bun add @slack/bolt` (M1+). SQLite is built in via `bun:sqlite` — no package.
- Auth: `ANTHROPIC_API_KEY` env var (the only credential the SDK needs headless)
- Distribution target: `bun build --compile` → single binary

The Agent SDK is developed against Node; M0 doubles as the Bun-compatibility check (spawn, streaming, hooks, resume). If Bun trips, record the exact failure in `DECISIONS.md` and pick a hedge from §6 (isolate the SDK in a Node child process behind the harness port, or run the daemon on Node temporarily).

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

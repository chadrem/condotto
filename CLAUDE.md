# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Condotto turns Slack threads into tickets that work themselves: each assigned thread gets a persistent Claude Code session running on a real dev machine, with humans (product + architect) and the AI implementer conversing in the thread. It is an installable open-source daemon with a ports-and-adapters core in `src/core/` (types, `bun:sqlite` store, session manager, policy engine, worktrees, framing, `command-runner` for land/deploy) plus Slack (`src/adapters/slack/`) and Claude Code (`src/adapters/claude-code/`) adapters.

What it does: gating + the defer-based approval loop; per-repo test/land/deploy (land/deploy daemon-run through the gate, echo/no-op on testrepo); cost budgets + a runaway cap; a daemon-wide concurrency semaphore; the production-data gate; and red-teamed injection framing. **Harness controls** (architect-only, in-thread): per-session model + effort (`@Condotto model`/`effort`, default Opus + high), opt-in subagents + an `ultra` preset, and trust-scoped project config (`trusted: true` repos load their `CLAUDE.md`/skills/`.claude/`). **Workflows:** the multi-agent **Workflow** tool, gated + confined (`@Condotto workflows on|off`, folded into `ultra`). Workflows run under **`permissionMode:"bypassPermissions"`** (set only when workflows are on), so the background workflow's sub-agent calls route THROUGH the PreToolUse hook with an `agent_id` and the read-only subagent policy confines them (main-agent defer + the `canUseTool` backstop still hold — hooks outrank permission mode). The workflow **launch** is gated (Approve/Deny with the workflow's name/desc + a fan-out concern), live status streams the background-task lifecycle, and the synthesized reply carries a cost footer. An **informed worktree-write opt-in** (`@Condotto workflows write on|off`, mandatory warning) lets confined subagent/workflow/escaped calls write in the worktree without per-write approval (out-of-worktree/credential/prod-data stay hard-denied). **Known SDK limit:** a background workflow sub-agent's Grep/Bash/Write can be denied by the SDK's task permission upstream of our gate — best-effort (Read/Glob route reliably; the security boundary always holds). **Role delegation + architect auto-approve:** `@Condotto grant @user architect [everywhere]` / `revoke` delegates authority at runtime (channel-scoped default; a `roles.source` column persists grants across the boot reseed while config stays authoritative), and `@Condotto auto-approve on|off` (on by default) runs a gate-tier call on an architect-*initiated* verified-surface turn without the Approve click. Auto-approve covers everything that would prompt (writes/bash/network/prod-data/workflow launches) EXCEPT the mechanical hard-deny floor (out-of-worktree/credential/daemon-secret/`rm -rf` escapes); member turns still gate; a resume is governed by the ORIGINAL initiator, never the approving decider (no laundering). It lives in the session-manager gate closure — `policy.ts` stays pure. **Packaging:** a single `condotto.toml` (all config; secrets in-file, env override), `bun build --compile` binaries (the native `claude` runtime rides alongside as a sidecar) with ordered `user_version` schema migrations, real worktree teardown/GC, a daemon-wide operator `/condotto status`, agent-shell env-scrub + background-task cost/cancellation, and a README/runbook + sample launchd/systemd units (`deploy/`).

`DESIGN.md` is the authoritative design document (architecture, security model, data model, verified SDK/Slack facts) — read it before doing anything. `README.md` owns the product overview, install, and runbook; the two deliberately do not repeat each other, so keep each fact in exactly one of them. This file only orients you.

## Process rules (from DESIGN.md)

- **The build is complete.** `DESIGN.md` is the authoritative spec of the system's design (§8 is the current-capabilities summary); `README.md` is the authoritative overview + install/runbook; `DECISIONS.md` is the chronological log of decisions and verified facts. Keep appending to `DECISIONS.md`; update `DESIGN.md` when reality disagrees with it — and don't duplicate content between README and DESIGN (decision 2026-07-20).
- The Agent SDK facts in DESIGN.md §6/Appendix B were verified at writing time but **re-confirm any exact field name against the live docs** (URLs in Appendix B) before building on it. The core gate handshake — `defer` and its resume — re-drives the deferred call through `PreToolUse` with the same `tool_use_id`. See DESIGN.md §6 and DECISIONS.md.
- **Build-time safety:** point the system only at a throwaway git repo — never a real repo or deploy path while developing Condotto itself — and wire deploy/land commands as no-ops/`echo` first. (The gate is proven, so an *operating* team pointing its install at a real repo/deploy is their call.) Slack development runs in the **real company workspace** (Acme) by explicit architect decision (2026-07-18, DECISIONS.md) — do not flag this as a violation; prefer a dedicated test channel.

## Toolchain

Runtime is **Bun 1.2+** — TypeScript run directly, no build step, no transpile.

- Run: `bun run <file>` — daemon and scripts run directly from source
- Test: `bun test` (built-in runner); single file: `bun test <path>`
- Deps: `bun add @anthropic-ai/claude-agent-sdk`, `bun add @slack/bolt`. SQLite is built in via `bun:sqlite` — no package.
- Auth: the machine's Claude subscription login (keychain OAuth; verified headless 2026-07-16) — no `ANTHROPIC_API_KEY` in this deployment. Headless box alternative: `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`
- Distribution target: `bun build --compile` → single binary

The Agent SDK is developed against Node; Bun compatibility is verified (Bun 1.3.14 via Homebrew, 2026-07-16): spawn, streaming, hooks, `defer`, and resume all work. If a future SDK update trips on Bun, record the exact failure in `DECISIONS.md` and pick a hedge from §6 (isolate the SDK in a Node child process behind the harness port, or run the daemon on Node temporarily).

## Architecture (the shape to preserve)

One long-lived Bun daemon, ports-and-adapters. The core (session manager, policy engine, SQLite store, worktree manager) speaks only domain types and has exactly two seams:

- **Surface port** — how humans reach Condotto (Slack v1; Teams/email/SMS/web later). Adapters own their transport and prefer outbound connections (Slack: Bolt over Socket Mode — no public URL, hard requirement). Capabilities are flags (`threads`, `buttons`, `editMessages`, `identityStrength`), not a lowest common denominator.
- **Harness port** — how Condotto drives a coding agent (Claude Code via Agent SDK v1; others later). The non-negotiable capability is **mechanical gating**: pausing a tool call un-executed until the policy engine or a human approves. A harness that can't gate runs only under OS-level confinement or not at all. Never simulate gating by watching output.

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

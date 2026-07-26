# CLAUDE.md

Orientation for working in this codebase.

This file and `README.md` are the only documents. This one is for whoever is
editing the code; `README.md` is the product overview, install and runbook. Keep
each fact in exactly one of them.

`DESIGN.md`, `PLAN.md` and `DECISIONS.md` were deleted on 2026-07-26. One fact
lived in four places, so every correction cost four edits and the copies drifted
apart faster than they helped. Do not recreate them. A new fact goes in the code
comment nearest the thing it explains, or here if a future session would trip
without it.

## What this repo is

Condotto turns Slack threads into tickets that work themselves. Each assigned
thread gets a persistent Claude Code session running on a real dev machine, and
the humans and the AI implementer converse in the thread.

It is an installable open-source daemon: a ports-and-adapters core in `src/core/`
(types, `bun:sqlite` store, session manager, policy engine, worktrees, framing)
plus a Slack adapter (`src/adapters/slack/`) and a Claude Code adapter
(`src/adapters/claude-code/`).

## In flight: the 2026-07-26 simplification

The security model was built for an untrusted, multi-tenant world. This install
is a trusted team on a dedicated server, so most of it is friction rather than
safety. Architects get god mode. Delete this whole section when the phases are
done.

- [x] **Phase 0 — docs.** Delete DESIGN/PLAN/DECISIONS, fold the load-bearing SDK
      facts in here, make README self-contained.
- [x] **Phase 1 — test/land/deploy.** Delete `core/command-runner.ts`, the
      `test_cmd`/`land_cmd`/`deploy_cmd` config keys, `@Condotto land`/`deploy`,
      `runShip` and their store columns (migration v7). That path existed only
      because shell was gated; the agent runs its own tests now. Retired config
      keys are ignored rather than rejected, so an old `condotto.toml` still
      boots. `safeBashAllowlist` outlives it by one phase and dies in phase 2,
      where it is a policy concept rather than a config one.
- [ ] **Phase 2 — collapse `policy.ts`.** Two answers, allow or deny. Deny is the
      floor and nothing else. Delete the gate tier, `PolicyConcern`, production
      data detection, the bash allowlist, `workflowWrite`, and
      `evaluateConfined`'s separate rules (subagents and workflow agents get the
      same answer the main agent gets). Widen the floor tests while doing it:
      after this they are the only security tests in the repo.
- [ ] **Phase 3 — delete the approval loop.** The defer/resume handshake, the
      approvals table and its store methods, Approve/Deny blocks, the
      prior-approval short-circuit, `@Condotto auto-approve`, the budget-capped
      approval resume, the `canUseTool` batching backstop. A turn becomes one
      query that runs to completion.
- [ ] **Phase 4 — only architects drive.** A non-architect's message is recorded
      and framed as context for the next architect turn, but never starts one.
      `@Condotto grant @user architect` is how you hand someone the keys.
- [ ] **Phase 5 — trust stops being per-repo ceremony.** Drop the `trusted` flag;
      every repo loads its own `CLAUDE.md`, skills and `.claude/`. Drop
      `checkSkillArgs`. Keep `disableAllHooks` and `disableSkillShellExecution`
      pinned: a repo's checked-in shell runs before any hook, which is the one
      path that walks straight past the floor.
- [ ] **Phase 6 — tests, smokes, and this file.** Delete the gate, approval,
      prod-data, allowlist and confined-tier tests. Drop `smoke:gate` and
      `smoke:approve`. Clean up the ~48 stale `DESIGN.md`/`DECISIONS.md`
      references in code comments. Trim the section above.

**Still in the tree until those phases land:** the defer-based approval loop,
Approve/Deny cards, auto-approve, the production-data gate, the safe bash
allowlist, and per-repo `trusted`. Expect to meet
them in the code; they are on the way out, not load-bearing.

## What survives, and why

These are the whole security model after the simplification. Nothing here ever
asks a human anything, which is the point.

- **Worktree containment.** Every path-bearing tool call resolves inside the
  session's worktree. The boundary is the worktree ROOT, which may sit above the
  cwd in a monorepo session, and containment is computed only from the root.
- **The hard-deny floor.** Credential env names (`ANTHROPIC_API_KEY`,
  `CLAUDE_CODE_OAUTH_TOKEN`, the daemon's own secrets), `rm -rf` escapes, and
  linking an out-of-tree path into the worktree. No one overrides it.
- **Injection framing** (`core/framing.ts`). Thread text reaches the model inside
  an unforgeable random-nonce fence with protocol-sentinel defanging. Authority
  attaches only to the verified `user=` id in the header, never to display names
  or message content. This is the control that a trusted team does not replace:
  the attacker here is a string in a dependency README, not a person in Slack.
- **Cost cap and runaway brake.** Not security, money. A wedged thread can spend
  real cash overnight.
- **The audit log.** Free at runtime, and the only record of what the agent did.
- **Agent memory.** Per (repo, channel), outside the worktree, the one named
  exception to containment. `verifyMemoryTarget` re-proves every target against
  the filesystem (no symlinks, no hard links) before the call runs. That per-call
  proof is the boundary; the sweep in `prepare` is hygiene.
- **Plan mode.** Read-only "investigate and propose first". Keeps the posture,
  loses the Approve/Deny card.

## Architecture (the shape to preserve)

One long-lived Bun daemon. The core speaks only domain types and has exactly two
seams:

- **Surface port** — how humans reach Condotto (Slack v1; Teams/email/web later).
  Adapters own their transport and prefer outbound connections. Slack uses Bolt
  over Socket Mode, and that is a hard requirement: no public URL. Capabilities
  are flags (`threads`, `buttons`, `editMessages`, `identityStrength`), not a
  lowest common denominator.
- **Harness port** — how Condotto drives a coding agent (Claude Code via the
  Agent SDK v1; others later). The non-negotiable capability is mechanically
  stopping a tool call before it runs. Never simulate that by watching output.

**Port erosion is a review-blocking bug even with one adapter per seam:** no
`@slack/bolt` or `@anthropic-ai/claude-agent-sdk` import outside `adapters/`, no
`thread_ts` in the core, no SDK type in `policy.ts`. Domain types (`Principal`,
`ConversationRef`, `ToolCall`) live in the core. `bun run check:ports` enforces
part of this; the rest is on you.

## Key invariants (enforce in code, not just schema)

- `(surface_id, conversation_id)` maps to exactly one session, forever. One
  conversation, one worktree, one harness session handle.
- `worktree_path` is stable and absolute. The SDK keys session storage by encoded
  cwd, so moving a live session's worktree loses the session.
- `harness_session_handle` is opaque JSON owned by the harness adapter. The core
  persists it and never inspects it.
- Slack `ts` values are strings, never floats. Leading zeros in the fractional
  part are significant.

## Toolchain

Runtime is **Bun 1.2+**. TypeScript runs directly, no build step.

- Run: `bun run <file>`. Test: `bun test`, or `bun test <path>` for one file.
- Deps: `@anthropic-ai/claude-agent-sdk` and `@slack/bolt`. SQLite is built in
  via `bun:sqlite`. **Bolt is pinned to v4 and must stay there**: Bolt 5 pulls
  `@slack/socket-mode@^3`, which Bun cannot run. On an existing clone always
  `bun install --frozen-lockfile`, never a bare `bun add @slack/bolt`.
- Requires agent-sdk **>= 0.3.220**, the release at parity with Claude Code
  2.1.220, which is what added `claude-opus-5`. An older sidecar has no such
  model id.
- Auth: two modes, chosen by `[auth].mode` (`core/config.ts`, `loadAuthConfig`).
  `api_key` resolves `[auth].api_key` then env `ANTHROPIC_API_KEY`; this is the
  default and the right posture for a team install. `subscription` uses keychain
  OAuth, or `claude setup-token` into `CLAUDE_CODE_OAUTH_TOKEN` when headless;
  supported, not deprecated, and scoped to a single operator driving their own
  sessions. Under both modes the credential rides the SDK subprocess env and is
  readable from the agent's shell, so the floor's hard-deny on commands naming
  either variable is what guards it. Pinned by a regression test. Do not weaken.
- Distribution: `bun build --compile` to a single binary, with the native
  `claude` runtime riding alongside as a sidecar.

Bun compatibility with the SDK is verified (Bun 1.3.14): spawn, streaming, hooks
and resume all work. If a future SDK update trips on Bun, the hedges are to
isolate the SDK in a Node child process behind the harness port, or run the
daemon on Node.

## SDK gotchas

Facts that cost real money to learn and will silently re-break if forgotten.
Re-confirm exact field names against the live docs before building on them; two
of the last three we relied on contradicted the SDK's own documentation.

- **`tools` and `allowedTools` are orthogonal.** `tools` says which built-ins
  exist for the session; `allowedTools` says which of them skip the permission
  callback. Naming a tool in `allowedTools` also supplies it, which is how
  emptying that list once silently took `Grep` and `Glob` away from the shipped
  posture. The adapter passes an explicit `tools` allowlist, so the reachable
  tool surface is that list. Removing a name from `BASE_DISALLOWED` no longer
  supplies it; it must also be added to `BASE_TOOLS`.
- **`tools: {type:'preset',preset:'claude_code'}` is a no-op**, byte-identical to
  omitting the option. Only an explicit list works.
- A `tools` entry the runtime does not expose is ignored, not an error.
  `TodoWrite` is absent in every configuration measured. `Agent` is exposed only
  under its legacy name `Task`.
- **Without `systemPrompt: {type:'preset', preset:'claude_code'}`** the model gets
  no environment context and invents paths. Use the preset plus an append.
- **`settings.plansDirectory` must be absolute.** A relative value resolves
  against cwd, which in a monorepo session is the sub-project. The default
  `~/.claude/plans/` is outside the worktree and hard-denied, so plan mode
  cannot present a plan at all without this.
- **Skill text is preprocessed before the model sees it.** `` !`cmd` `` runs
  shell and `@path` inlines a file, both before any hook, so `policy.ts` never
  sees them. `disableSkillShellExecution: true` closes the shell half.
- **`disableAllHooks` governs filesystem hooks only.** The SDK-passed
  programmatic `PreToolUse` hook still fires, which is what makes it safe to pin.
- **Session storage is keyed by encoded cwd**:
  `~/.claude/projects/<cwd with every non-alphanumeric replaced by ->/<id>.jsonl`.
  Resuming requires the same cwd. Relocate with `CLAUDE_CONFIG_DIR`.
- **A workflow turn yields multiple `result` messages**: an immediate "launched,
  waiting" one, then the real synthesized one when the background task finishes.
  Buffer and deliver the last.
- **Background workflow sub-agents get refused at random**, upstream of our hook,
  with the CLI's "The user doesn't want to take this action right now". It is
  tool-agnostic and arrives in bursts, so a workflow's coverage is best-effort.
  Measured 2026-07-26, `scripts/spike-workflow-grep.ts`.
- **xhigh effort** needs Fable 5, Opus 4.7+ or Sonnet 5; elsewhere the SDK falls
  back to `high` silently. Opus 5 refuses a request that disables thinking at
  xhigh or max, so do not set a thinking option.

## Process rules

- **Do not add documents.** See the top of this file.
- **Spike before building on SDK behaviour.** Probes go in the scratchpad, or
  `scripts/spike-<name>.ts` if worth keeping, and run against a throwaway fixture
  directory. Never a real repo, never a real deploy path.
- **Build-time safety:** point the system only at a throwaway git repo while
  developing Condotto itself. Slack development runs in the real company
  workspace by explicit architect decision; prefer a dedicated test channel.
- **Commit directly to main.** No branches.

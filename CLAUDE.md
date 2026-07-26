# CLAUDE.md

Orientation for working in this codebase.

This file and `README.md` are the only documents. This one is for whoever is
editing the code; `README.md` is the product overview, install and runbook. Keep
each fact in exactly one of them.

Do not add a third. A new fact goes in the code comment nearest the thing it
explains, or here if a future session would trip without it.

## What this repo is

Condotto turns Slack threads into tickets that work themselves. Each assigned
thread gets a persistent Claude Code session running on a real dev machine, and
the humans and the AI implementer converse in the thread.

It is an installable open-source daemon: a ports-and-adapters core in `src/core/`
(types, `bun:sqlite` store, session manager, policy engine, worktrees, framing)
plus a Slack adapter (`src/adapters/slack/`) and a Claude Code adapter
(`src/adapters/claude-code/`).

## The security model, in full

Condotto runs on one team's machine, against their own repos, driven by people
they trust. Nothing here ever asks a human anything — there is no approval step.
What follows is the whole model.

- **Worktree containment.** Every path-bearing tool call resolves inside the
  session's worktree. The boundary is the worktree ROOT, which may sit above the
  cwd in a monorepo session, and containment is computed only from the root. It is
  origin-blind: a subagent, a workflow agent and a call arriving on the
  `canUseTool` backstop all get the identical answer.
- **The hard-deny floor.** Credential env names (`ANTHROPIC_API_KEY`,
  `CLAUDE_CODE_OAUTH_TOKEN`, the daemon's own secrets), credential directories
  (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`), environment dumps, `rm -rf`
  escapes, and linking an out-of-tree path into the worktree. No one overrides it.
  It applies to Bash, which has no path confinement — a command is a string, so
  this pattern list is the whole boundary there. Match credential DIRECTORIES, not
  filenames: matching only `.ssh/` once left `cp -r ~/.ssh mine` allowed, and a
  copy inside the worktree reads back clean.
- **Injection framing** (`core/framing.ts`). Thread text reaches the model inside
  an unforgeable random-nonce fence with protocol-sentinel defanging. Authority
  attaches only to the verified `user=` id in the header, never to display names
  or message content. This is the control that a trusted team does not replace:
  the attacker here is a string in a dependency README, not a person in Slack.
- **Cost cap.** Off by default, money not security. `@Condotto budget <usd>` opts
  a thread in, `budget off` opts back out, and the row is authoritative once
  `assign` has seeded it. The thread cap is checked BETWEEN turns; a thread that
  has one also arms the SDK's per-turn `maxBudgetUsd` with the remaining headroom,
  which is the only thing that stops a runaway mid-turn. The backstop that does
  not depend on Condotto being correct is the Console spend cap.
- **The audit log.** Free at runtime, and the only record of what the agent did.
- **Agent memory.** Per (repo, channel), outside the worktree, the one named
  exception to containment. `verifyMemoryTarget` re-proves every target against
  the filesystem (no symlinks, no hard links) before the call runs. That per-call
  proof is the boundary; the sweep in `prepare` is hygiene.
- **Plan mode.** Read-only "investigate and propose first". The plan-file write is
  the one write it permits, `policy.ts` flags that decision with `plan: true`, and
  the session manager posts the content into the thread. `@Condotto plan off` is
  how it ends — there is no button.

**Outside the boundary by design:** a repo's checked-in hooks, a skill's inline
`` !`cmd` ``, and skill arguments all expand BEFORE the model and before our hook,
so `policy.ts` never sees them. Accepted — they are your repo and your typing —
but remember the agent can write files in that repo, so in principle it could
write itself a hook.

## Architecture (the shape to preserve)

One long-lived Bun daemon. The core speaks only domain types and has exactly two
seams:

- **Surface port** — how humans reach Condotto (Slack v1; Teams/email/web later).
  Adapters own their transport and prefer outbound connections. Slack uses Bolt
  over Socket Mode, and that is a hard requirement: no public URL. Capabilities
  are flags, not a lowest common denominator: `buttons`, `editMessages`,
  `attachments` and `identityStrength` each gate real behaviour. (`threads` is
  declared and read nowhere — every surface so far has them.)
- **Harness port** — how Condotto drives a coding agent (Claude Code via the
  Agent SDK v1; others later). The non-negotiable capability is mechanically
  stopping a tool call before it runs. Never simulate that by watching output.

**Port erosion is a review-blocking bug even with one adapter per seam:** no
`@slack/bolt` or `@anthropic-ai/claude-agent-sdk` import outside `adapters/`, no
`thread_ts` in the core, no SDK type in `policy.ts`. Domain types (`Principal`,
`ConversationRef`, `ToolCall`) live in the core. `bun run check:ports` (also run
by `bun test`) catches the mechanical half: platform imports, relative imports
into `adapters/`, and the surface wire tokens listed in `scripts/check-ports.ts`
anywhere outside `adapters/`. A domain type that merely mirrors an SDK shape is
on you.

## Files in and out of a thread

Both directions go through the WORKTREE, not the model's context, so worktree
confinement is the only boundary either needs. Keep it that way. The reasoning and
the two controls that hold it up are in `core/attachments.ts`'s header.

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
- **`Bun.TOML.parse` silently drops a table header preceded by a bare `#` line.**
  A comment line that is exactly `#` — no space, no text — makes the `[[repos]]`
  or `[section]` under it disappear, and its keys fold into the PREVIOUS table.
  `# `, `# text` and two bare `#`s are all fine, which is why it hides. It shipped
  in `condotto.example.toml` and surfaced as "No repos configured" pointing at the
  wrong thing. Pinned by a test that loads the example file for real.

Bun compatibility with the SDK is verified (Bun 1.3.14): spawn, streaming, hooks
and resume all work.

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
  `TodoWrite` and `MultiEdit` are absent in every configuration measured. `Agent`
  is exposed only under its legacy name `Task`.
- **Without `systemPrompt: {type:'preset', preset:'claude_code'}`** the model gets
  no environment context and invents paths. Use the preset plus an append.
- **`settings.plansDirectory` must be absolute.** A relative value resolves
  against cwd, which in a monorepo session is the sub-project. The default
  `~/.claude/plans/` is outside the worktree and hard-denied, so plan mode
  cannot present a plan at all without this.
- **Skill text is preprocessed before the model sees it.** `` !`cmd` `` runs
  shell and `@path` inlines a file, both before any hook, so `policy.ts` never
  sees them. `disableSkillShellExecution: true` would close the shell half for a
  skill BODY, though not for arguments. The adapter does
  NOT set it, deliberately: skills that shell out to gather context are the
  normal kind, and this is the "your repo, your skills" line the security model
  already draws. Turning it on is a product decision, not a bug fix.
- **Session storage is keyed by encoded cwd**:
  `~/.claude/projects/<cwd with every non-alphanumeric replaced by ->/<id>.jsonl`.
  Resuming requires the same cwd. Relocate with `CLAUDE_CONFIG_DIR`.
- **A workflow turn yields multiple `result` messages**: an immediate "launched,
  waiting" one, then the real synthesized one when the background task finishes.
  Buffer and deliver the last.
- **Background workflow sub-agents get refused at random**, upstream of our hook,
  with the CLI's "The user doesn't want to take this action right now". It is
  tool-agnostic and arrives in bursts, so a workflow's coverage is best-effort.
- **xhigh effort** needs Fable 5, Opus 4.7+ or Sonnet 5; elsewhere the SDK falls
  back to `high` silently. Opus 5 refuses a request that disables thinking at
  xhigh or max, so do not set a thinking option.

## Process rules

- **Probe before building on SDK behaviour.** Write the throwaway probe in the
  scratchpad, run it against a throwaway fixture directory — never a real repo —
  and then delete it. What you learned goes in a plain comment next to the code
  that depends on it, stated as a fact. Not the story of how you found out.
- **Build-time safety:** point the system only at a throwaway git repo while
  developing Condotto itself. Slack development runs in the real company
  workspace by explicit architect decision; prefer a dedicated test channel.
- **Commit directly to main.** No branches.
- **Write commit messages like a person.** Short subject in plain English, then
  at most two sentences of why. No headers, no bullets, no essay. Never a
  `Claude-Session:` trailer or any other attribution.

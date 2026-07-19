# Milestone 4 — kickoff (build plan & strategy)

Durable plan for building **M4 — Installable open-source beta (polish & packaging)**,
executed **section by section, one fresh context per section**. The authority is
**DESIGN.md §8** (the M4 spec) + **DECISIONS.md "2026-07-19 — Milestone 4 reframed"**
(the reframe rationale, the single-`condotto.toml` config decision, and the build
specifics) + **CLAUDE.md**. This doc holds the *strategy and section roadmap*; each
section has a short paste-in prompt (template at the bottom) that points here.
Everything through M3.8 is committed and pushed to origin/main
(github.com/chadrem/condotto).

## What M4 is

Make Condotto installable, operable, and polished for a **trusted small team** whose
architect self-hosts it (DESIGN.md §1 "Distribution & trust model"). No new authority
machinery — grant + auto-approve (M3.8) already delivers the "empower domain experts"
vision; M4 is packaging + operability. **Cut:** dedicated-box provisioning, session
process isolation, real deploy paths. **Deferred past M4:** read-only Slack audit
channel, symlink-realpath confinement.

## Build strategy (applies to every section)

Sections share hot files (`daemon.ts`, `session-manager.ts`, `store.ts`), so the build
is **sequential, not parallel** — and each section is its own fresh context so diffs
stay reviewable and context stays sharp.

**Per-section loop:**
1. **Read** CLAUDE.md → DESIGN.md (§8 + the sections it names) → this doc → the
   DECISIONS.md reframe entry.
2. **Spike-first** any unknown listed for the section before building (the repo's rule —
   re-run the real primitive, don't trust a write-up).
3. **Implement** the section. Under ultracode, use a workflow for the file-mapping and
   for the review pass.
4. **Verify by actually running it** — beyond `bun test` + the TypeScript check +
   `bun run scripts/check-ports.ts`, boot/drive the affected path and observe it work.
5. **Adversarially review the diff** before committing (this habit has caught real
   invariant bugs here — e.g. the M3.8 config-architect lockout that 34 tests missed).
6. **Log** a short "M4 §N done" note in DECISIONS.md.
7. **Commit** the section to `main` (repo style: `M4 §N: <summary>`) and **push**.
8. **Chain**: produce the next section's short paste-in prompt (template below), copy it
   to the clipboard with `pbcopy`, and tell the operator:
   **"§N is committed and pushed. Clear your context and paste the §N+1 prompt."**

## Section roadmap (dependency order)

**§1 — Config foundation.** Single `condotto.toml` (TOML via `Bun.TOML.parse`) as the
single source of truth, replacing `.env` + `condotto.repos.json` + `condotto.roles.json` +
`CONDOTTO_*`. Schema: `[slack]` tokens, `architects`, `[defaults]`
(model/effort/auto-approve/cost cap), `[paths]` (worktree root, DB), `[[repos]]` (the §5
repo fields: `name`, `path`, `default_branch`, `trusted`, `safe_bash_allowlist`,
`land_cmd`, `deploy_cmd`, `policy_overrides`). Secrets live in the file → ship a tracked,
commented `condotto.example.toml` and `.gitignore` the real one. Discovery `./condotto.toml`
overridable via `--config <path>`/`CONDOTTO_CONFIG`; **boot validation** fails fast on
missing/malformed required fields. **Remove** the legacy readers (single source of truth);
manual cutover of the one live instance (its `condotto.toml` is gitignored). Config
*consolidation, not behavior change* — roles seeding (`clearConfigRoles` reseed), worktree
pathing, and all behavior stay intact. *Touches:* `config.ts`, `types.ts`, `daemon.ts`,
`.gitignore`, `condotto.example.toml`. *Spike:* none (schema is a faithful superset of
current parsing — map `config.ts` first).

**§2 — Binary + schema migrations.** `bun build --compile` binaries (macOS/Linux) + a
minimal CLI (`--config`, `--version`, `--help`) + a release story. Because operators
upgrade a binary in place over a persistent SQLite store, boot runs **ordered
`user_version` migrations** so an upgrade never strands an install. *Touches:* `daemon.ts`,
`store.ts`, `package.json`. *Spike:* confirm `bun build --compile` bundles `bun:sqlite` +
the Agent SDK and runs headless.

**§3 — Worktree cleanup.** Real teardown (`git worktree remove` + branch delete +
`git worktree prune`) + fix the assign-race orphan leak (a worktree created before the
losing DB insert). GC **respects the park-and-resume invariant** (§2 journey 5): never
collect a worktree bound to a live/parked session — only unreferenced ones, or a set
interval after an *explicit* stop. Default `stop` keeps the tree for reactivation
(journey 6); an explicit clean variant removes it. *Touches:* `worktrees.ts`,
`session-manager.ts`, `store.ts`. *Spike:* none; heavy tests around the invariant.

**§4 — Daemon-wide `/condotto status` + slash fixes.** Make `/condotto status` a
**daemon-wide, architect-only** operator view (uptime, active/parked counts,
in-flight-vs-cap, pending approvals, config summary) — this changes today's
channel-scoped status. Fix the two slash gaps: `status` currently posts publicly (make it
ephemeral); `stop` is a no-op (targeting is in-thread `@Condotto stop` mirroring
`@Condotto assign`; channel-level `/condotto stop` lists sessions or points to the thread).
Ship this before the riders. *Touches:* `session-manager.ts`, slack adapter.

**§5 — Riders: env-scrub + background cost/cancel.** (a) **Env-scrub the agent shell** — a
*denylist* through the SDK's `options.env` dropping the daemon's `SLACK_*`/`CONDOTTO_*`
secrets while preserving `PATH`/`HOME` + the repo toolchain env (the policy floor stays as
defense-in-depth). (b) **Background-task cost accounting + cancellation** — background
workflow spend counts against the per-thread runaway cap; a wedged/over-cap workflow is
cancellable (architect `@Condotto cancel` + auto-cancel on breach) instead of silently
spending after the turn parks. *Touches:* claude-code adapter, `session-manager.ts`.
*Spikes (both, before building):* (a) the minimal env the Claude Code CLI needs under
keychain OAuth — `options.env` REPLACES, doesn't merge, so get the keep-list right;
(b) does `q.interrupt()` cancel *detached* background workflow tasks, and can we drain the
final `total_cost_usd`?

**§6 — README/runbook + service unit.** README/runbook: install → create the Slack app
(Appendix C) → copy and fill `condotto.example.toml` → run; how grant + auto-approve lets
the architect empower domain experts; reading the SQLite audit log locally (the audit
channel is deferred). Sample launchd/systemd unit. *Touches:* docs, a sample unit file.

## Section paste-in prompt template

Each section's prompt is short and points here:

> You are implementing **Condotto M4 §N — \<title\>**. Read `CLAUDE.md`, `DESIGN.md` (§8 +
> the sections it names), and **`docs/M4-KICKOFF.md`** (the build strategy, this section's
> scope, and any spikes). Follow the per-section loop in that doc: spike-first → implement
> → verify by actually running it → adversarially review the diff → log "M4 §N done" in
> DECISIONS.md → commit `M4 §N: …` and push to `main` → generate the §N+1 short prompt,
> `pbcopy` it, and tell me: "§N is committed and pushed. Clear your context and paste the
> §N+1 prompt." Do NOT drift into later sections — one section per context.

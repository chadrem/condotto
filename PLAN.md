# PLAN.md — gap audit against Claude Code, and the milestones that close it

Written 2026-07-26. A comparison of Condotto against the coding-agent features
people actually use in Claude Code every day, and a milestone plan for the gaps
worth closing.

The bar this was measured against is **"complete enough to be useful"**, not
parity. Condotto clears that bar today: mechanical gating, worktree isolation,
park-and-resume, cost brakes, plan mode, memory and skills are real and hold up
under probing. What follows is the list of things a team would hit anyway, in the
order they would hit them.

Scope note: this is a findings-and-roadmap document. `DESIGN.md` remains the
authoritative spec, `DECISIONS.md` the chronological log. When an item here is
built, record it there and delete it here.

---

## How this was produced

Eight dimensions of everyday Claude Code use (context lifecycle, session
recovery, input modalities, output visibility, tool surface, extensibility,
steering, VCS/ops) were surveyed against the source, each survey then handed to
an adversarial verifier whose job was to *refute* every claimed gap by finding
the implementation the surveyor missed. 52 claims survived, 24 were refuted as
already-present or terminal-only. The highest-stakes claims were then re-verified
by direct probe against agent-sdk 0.3.220, because the repo rule is spike-first
and two of them contradicted the SDK's own documentation.

The survey agent covering output visibility died mid-response, so that dimension
leans on the others and is the likeliest place for a missed finding.

### Verified by probe

Three probes, all against agent-sdk 0.3.220 on a throwaway fixture directory.

**1. `allowedTools: []` removes tools from the model's context.** This
contradicts `sdk.d.ts:1369-1371` ("List of tool names that are auto-allowed
without prompting... To restrict which tools are available, use the `tools`
option instead"), which is why it was worth proving rather than assuming.
Reading the `tools` array off the init message:

| options | Grep | Glob |
| --- | --- | --- |
| `allowedTools: []`, mode `default` | absent | absent |
| `allowedTools: []`, mode `bypassPermissions` | absent | absent |
| `allowedTools: ["Read","Glob","Grep","TodoWrite"]`, either mode | present | present |
| `allowedTools` omitted entirely | absent | absent |
| `allowedTools: []` + explicit `tools: [...]` | present | present |

`permissionMode` is not the variable. `allowedTools` is — though only
incidentally: a follow-up spike (2026-07-26, `scripts/spike-tools.ts`) showed the
real control is `tools`, and that the `claude_code` preset value is a no-op. Fixed
that day; the row for `allowedTools` omitted/empty is now moot because the adapter
always passes an explicit `tools` allowlist. The follow-up question,
whether the tools are merely *deferred* behind `ToolSearch` rather than gone, was
settled by running a real turn that needed a search: the model called `ToolSearch`
three times, found no match, and answered *"there's no way to search without Bash
in this session."* They are gone, not deferred.

Incidental finding from the same runs: `TodoWrite` is absent in **every**
configuration, including when named in `allowedTools`. Its handling at
`policy.ts:191` is dead code, and no task-list progress can reach a thread.

**2. A `trusted` repo executes its own checked-in hooks.** A fixture
`.claude/settings.json` carrying a `SessionStart` command hook produced no marker
under `settingSources: []` and ran arbitrary shell under `settingSources:
["project"]`, before any tool call, with no `PreToolUse`, no approval and no audit
row.

**3. The fix for (2) does not disable Condotto's own gate.** This had to be
proven before recommending it. With `settings: { disableAllHooks: true }`, the
SDK-passed programmatic `PreToolUse` hook still fired and still denied a `Write`:
the file was unchanged in both the baseline and the pinned run. `disableAllHooks`
governs filesystem hooks only.

### Reported but not independently confirmed

The audit claims the operator's own `~/.claude` skills, commands and agents never
load, because `settingSources` never includes `"user"` (`adapter.ts:761`), while
`enumerateSkills` scans `~/.claude` anyway (`adapter.ts:643-646`) and
`@Condotto skills` advertises them (`session-manager.ts:2097`). If true, every
operator-authored `disable-model-invocation` skill is unreachable and the failure
surfaces only as a daemon console warning. It also implies the "verified live
2026-07-20" note at `adapter.ts:751-760` observed the CLI's bundled skills and
misattributed them to `~/.claude`.

This one needs its own spike before anyone acts on it. Re-spike it with real
fixtures under a `HOME` override rather than the operator's own directory.

---

## Milestone 1 — Give the agent its hands back

Small, mechanical, and the difference between a good session and a frustrating
one. Everything here is adapter-local.

- **Re-enable `WebFetch` and `WebSearch`.** Remove them from `BASE_DISALLOWED`
  (`adapter.ts:118`) **and add them to `BASE_TOOLS`** — since 2026-07-26 the
  adapter passes an explicit `tools` allowlist, so un-disallowing a tool no longer
  supplies it. Behind a daemon-wide or per-repo `web` key if the choice should be
  explicit. The whole gate path is already built and regression-tested
  and currently dead: `NETWORK_TOOLS` (`policy.ts:194`), the gate arm
  (`policy.ts:624`), the `describeCall` arms (`policy.ts:1003-1006`), the URL on
  the approval card (`render.ts:115`), `tests/policy.test.ts:331-333`. The system
  prompt already promises the capability (`session-manager.ts:243`), so today the
  agent proposes a fetch, finds no tool, and falls back to `curl` returning raw
  HTML.

- **Decide `TodoWrite`.** It is unavailable in this runtime regardless of
  configuration — re-confirmed 2026-07-26, absent even when named explicitly in
  `tools`. Either surface an equivalent progress signal or drop the dead
  branch at `policy.ts:191`.

- **A schema'd workflow returns nothing.** `StructuredOutput` — the tool the
  Workflow runtime forces an agent to call when the script passes
  `agent(prompt, {schema})` — was refused upstream of our gate on every observed
  attempt, in both tool postures (2026-07-26, `scripts/spike-workflow-grep.ts`).
  The agents' work succeeds and is then discarded: the main agent reports "the
  agents completed without returning anything" over correct findings. It is absent
  from `BASE_TOOLS` (`adapter.ts:168`), which is the first thing to try — but the
  same refusal appeared with no `tools` option at all, so prove the fix rather than
  assuming it. Schemas are the documented way to get structured results out of a
  workflow, so this quietly caps what the fan-out is good for.

- **Re-verify the `canUseTool` backstop under `bypassPermissions`.** Security, and
  currently a documentation claim with a live contradiction. The SDK emits
  `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` on every workflows-on query — "canUseTool will
  not be invoked: permissionMode 'bypassPermissions' auto-approves every tool call
  (except explicit deny rules) before the callback is consulted" — while DESIGN.md
  §8 and `adapter.ts:859-881` both say the backstop still holds there (spike
  2026-07-18 diag4). One of the two is now wrong. The PreToolUse hook, which is the
  actual boundary, is unaffected either way, so this is about defence in depth, not
  a hole: drive a batched gated call under workflows-on and watch whether
  `canUseTool` fires. Then fix either the code or DESIGN §8 — do not edit DESIGN on
  the strength of the warning alone.

## Milestone 2 — Close the trusted-repo shell hole

A security fix, not a feature. `trusted = true` is sold in the example config as
"loads that repo's CLAUDE.md and skills" and currently also means "runs that
repo's shell, un-gated, at session start."

- **Pin `disableAllHooks: true` and `strictMcpConfig: true`** in the adapter's
  `settings` object, the same tier and the same reasoning as the already-pinned
  `disableSkillShellExecution` (`adapter.ts:854-867`). Proven safe: the
  programmatic gate hook survives.

- **Reintroduce repo hooks and repo MCP as separate, narrower vouches**
  (`hooks = true`, `mcp = true`) if anyone wants them, so loading a repo's
  conventions stops implying running its shell.

- **Pin it with a regression test,** as the credential hard-deny already is.

- **Record it in `DECISIONS.md`.** `DECISIONS.md:521-524` notes that `["project"]`
  also loads a repo's hooks and MCP, so the surface was named, but nothing records
  that it means un-gated startup shell and no test holds the line.

## Milestone 3 — Make Slack a real input surface

Condotto's premise is that the thread is the ticket. Today a large part of what
lands in a thread never reaches the agent.

- **Ingest dropped files.** `slack/adapter.ts:492-497` maps `event.files` to
  `{kind, name}` only; `Attachment.url` (`types.ts:65-69`) is declared and never
  set; the sole consumer (`session-manager.ts:2514-2563`) frames `event.text`
  alone. Download `url_private` with the bot token into a Condotto-owned staging
  directory inside the worktree and append the absolute path to the framed body,
  so the agent opens it with the already-confined `Read`, which handles images and
  PDFs natively. No `TurnInput` change, no new policy rule, no SDK content-block
  work. Text files can ship first under a size cap. Slack turns any long paste
  into a snippet file, so this is not only about screenshots.
  Also add an empty-text guard: a file-only message currently runs a billed turn
  whose framed body is one blank quote line. And flip `imageInput: true`
  (`adapter.ts:1286`) to false until the path exists.

- **Read the thread on assign.** `assign` (`session-manager.ts:844-1010`) never
  fetches `conversations.replies`, so the agent starts cold after twenty messages
  of human debate. Feed prior messages as one framed transcript turn, with each
  message carrying its own verified `user=` header through the existing framing
  contract (`framing.ts:240-247`) so a quoted member cannot inherit an architect's
  authority.

- **Admit bot messages as observer-grade context.** `slack/adapter.ts:483` drops
  every bot-authored message before the subtype check, which is what a self-echo
  guard does when it oversweeps. The CI failure or alert that started the thread
  is exactly what "fix that" refers to. This is not a flag flip: a bot message
  carries no verifiable Principal, so frame it with a distinct header kind and
  deliberately no `user=` field, behind a per-channel or per-repo allowlist of app
  ids.

- **Decode inbound Slack text.** Escaping is done on the way out
  (`render.ts:11`) and never undone on the way in, so `cat a.txt && ./run.sh >
  out` reaches the model as entities and `Map<String, List<Foo>>` is unreadable.
  Add one inbound normalizer in the adapter that decodes the three entities,
  rewrites `<@Uxxx>` through the existing `DisplayNameCache`, and unwraps
  `<url|label>`. It must run **before** `frameMessage`, so a decoded `<` cannot
  reconstruct anything the sentinel defangs watch for.

## Milestone 4 — Make the thread a record of the work

An architect on the default posture sees their own messages, a spinner that
mutates and vanishes, and one paragraph of prose.

- **Stop destroying the tool trace.** `deliverFinal` overwrites the same message
  the progress window was written into (`session-manager.ts:3038-3090`). Post the
  trace as its own durable message, or append a `git diff --stat` footer to the
  reply.

- **Make the trace say something.** Every Bash renders as the literal string
  `preparing to run a command` (`adapter.ts:1219`) with no command text, and
  assistant text blocks are iterated and dropped (`adapter.ts:1046-1054`). Include
  the command, and stream the first sentence of each text block into the existing
  throttled status edit. The escape path is already `renderMrkdwn` → `escapeSlack`.

- **Add `@Condotto diff`.** Reads `git -C <worktree> diff` through
  `command-runner`. No model turn, no gate, no cost.

- **Put a `--stat` summary on the land/deploy approval card,** whose entire
  detail today is the command string (`render.ts:114-118`).

- **Add `@Condotto cost`.** The ledger is complete (`store.sessionCostUsd`,
  `store.ts:843`) and has essentially no read path. The only way to ask what a
  thread has spent is to re-set the cap to its current value and read the reply.
  Pure DB read. Add the per-turn cost footer that today only workflow replies get.

- **Ping the decider on an approval.** `approvalBlocks` (`render.ts:129-172`)
  mentions nobody, so on a member-driven thread the architect is not subscribed
  and never sees the card, while every subsequent message is refused with
  "approve or deny it, then resend." That combination can wedge a thread
  indefinitely with nobody aware.

## Milestone 5 — Recoverability

Two independent things: undoing the agent, and understanding why it stopped.

- **Commit each turn to a hidden ref.** The worktree manager never commits or
  stashes (`worktrees.ts:158-161`), so a session's branch tip equals its base
  commit and the whole thread's work is one uncommitted blob. "Undo the last three
  turns" and "undo everything" are the same destructive operation. Commit to
  `refs/condotto/<session>/turn-N` after each turn, then add `@Condotto undo [n]`
  and per-turn `@Condotto diff [n]`. Do it with git rather than the SDK's
  checkpointing: cheaper, survives `clear`, runs daemon-side through
  `command-runner` so it is audited and needs no gate.
  Minimum viable today: make `stop clean` refuse or loudly warn when `git status
  --porcelain` is non-empty, since it schedules `worktree remove --force` plus
  `branch -D` with no warning that uncommitted work dies with it
  (`session-manager.ts:1307-1311`).

- **Make failures legible.** Three SDK error channels are handed over and
  discarded: `SDKAPIRetryMessage` falls past the only system branch that could
  catch it and vanishes, so a retry window looks like a frozen ticker until the
  10-minute watchdog; `SDKAssistantMessage.error` (carrying `rate_limit`,
  `overloaded`, `billing_error`, `authentication_failed`) is never read; and
  `SDKResultError.errors` and `terminal_reason` are dropped in favour of
  `session turn ended abnormally (<subtype>)` (`adapter.ts:1122-1123`). A bad
  credential, a 429, an overload, a context overflow and a malformed tool use are
  currently indistinguishable, so the human re-sends and re-spends against the
  cap. Give `prompt_too_long` a dedicated message naming `@Condotto clear`, which
  is the one case with a specific remedy. This also subsumes the need for a
  `/doctor` preflight.

- **Fix `@Condotto stop` mid-turn.** It sets status stopped and nulls
  `entry.harness` without calling `interrupt()` (`session-manager.ts:1285-1296`),
  so the in-flight turn keeps running against its own local reference and a
  later reply lands in a thread that reports itself stopped. A follow-up `cancel`
  is then refused twice. `clear` already guards against exactly this
  (`session-manager.ts:1396-1408`); `stop` was not updated.

## Milestone 6 — Reach beyond the worktree

- **Operator-configured MCP.** `mcpServers` is passed nowhere and there is no
  config key; DESIGN.md §8's parenthetical is unimplemented. Add an
  operator-level `[[mcp]]` table in `condotto.toml` passed straight to
  `options.mcpServers`, with `strictMcpConfig: true` from Milestone 2 ensuring
  repo content can never register a server. Operator-vouched, never repo-vouched:
  that is what keeps §4 intact.
  Two downstream facts matter once it exists: an `mcp__server__tool` call lands on
  the unknown-tool catch-all (`policy.ts:627`) which renders no input on the
  approval card, and `evaluateConfined` denies it for every subagent and workflow
  call (`policy.ts:485-492`), so it would be unusable from the fan-out that is the
  shipped posture. Classify `mcp__*` with per-server allow/gate lists and a
  `describeCall` arm.

- **Load `CLAUDE.md` without requiring full trust.** `settingSources` is `[]`
  unless the repo is trusted (`adapter.ts:761`) and the SDK requires `"project"`
  to load `CLAUDE.md` (`sdk.d.ts:1908`), so the single most-used Claude Code
  feature is absent on the default posture, with no per-repo `instructions` key to
  substitute. The settings banner announces trust only in the positive direction
  (`session-manager.ts:614`), so an untrusted thread never learns the agent has
  not read the repo's conventions. Once Milestone 2 separates hooks and MCP from
  trust, `"project"` becomes a much cheaper thing to grant.

- **Resolve the operator-skills question** from the spike above, and make the
  Slack-visible listing and the runtime's dispatchable set derive from one source
  of truth either way.

## Milestone 7 — Everyday friction

Individually small, collectively the difference between tolerable and pleasant.

- **Acknowledge a queued message.** Nothing signals that a mid-turn message was
  received, so people re-send and enqueue a second full-priced turn. Add a
  `react()` capability to the surface port and mark the inbound message the moment
  it is chained. Then hold a bounced message and replay it rather than asking for
  a retype, and debounce a few seconds at the head of the FIFO so three bursty
  messages become one turn instead of three. True mid-turn steering means moving
  `query()` to streaming-input mode, which is large and worth doing only after
  the rest.

- **Let a denial carry a reason.** The domain event has no reason field
  (`types.ts:149-154`) and the Deny button carries only the request id
  (`render.ts:164-170`), so the agent re-proposes something near-identical. Add
  an optional `reason?: string` and a "Deny with note" modal or
  `@Condotto deny <reason>`. Authority is unaffected: the reason rides a payload
  already verified server-side, and it is content, not authority.
  Related and worth fixing in the same change: the deny-resume runs on
  `framedText: ""`, so the model re-plans before any human correction reaches it.

- **Give long-running commands a home.** `BashInput.timeout` caps at 10 minutes
  and auto-backgrounds past 2, recovery needs `TaskOutput` which policy does not
  know, and a defer ends the query so an approved resume re-drives it in a new
  process where the task id no longer exists. Classify `TaskOutput` as read-only
  and `TaskStop` as a gated kill — and note both now also need adding to
  `BASE_TOOLS`, which since 2026-07-26 is what makes a tool reachable at all — and
  add a per-repo `build_cmd` run daemon-side through `CommandRunner` the way land
  and deploy already are.

- **Stop billing a turn for every human message.** The `mentioned` flag is
  computed (`slack/adapter.ts:520`) and consulted only for unassigned threads, so
  two people debating in an assigned thread each pay an Opus-5/xhigh turn and get
  an unwanted interjection.

- **Reduce the approval tax on the verify loop.** The safe allowlist is ten
  read-only git commands plus the repo's single `test_cmd`, so a type-check, a
  linter, `ls` or a second test target all gate. The SDK ships
  `sandbox: { enabled, autoAllowBashIfSandboxed }`, which would retire most of
  this without touching the gate. Evaluate it.

- **Handle batched gated calls.** A batch containing a write is denied wholesale
  and re-issued serially, costing a round trip. Post one approval card for the
  batch, which is the natural Slack shape anyway.

- **Fetch before branching.** Nothing ever contacts a remote, so every new
  session cuts from whatever `main` pointed at the last time a human ran
  `git pull` on that box. Add a periodic fetch on the existing GC tick and an
  `@Condotto sync`.

- **Handle `message_changed`,** which is currently dropped along with every other
  subtype, so an edited message silently diverges from what the agent saw.

- **Route `AskUserQuestion` to `requestChoice`.** Condotto already owns a better
  version of the primitive (`types.ts:190-197`), used only for its own repo picker.
  Re-check the premise first: the 2026-07-26 spike found `AskUserQuestion` in no
  posture's tool list, and naming it in `tools` did not add it, so "the model calls
  it and it renders as raw JSON" may describe a tool this runtime never exposed.

- **Decide whether the tool-surface trim needs a policy floor behind it.** The
  `BASE_TOOLS` allowlist added 2026-07-26 removed `ExitWorktree`, `EnterWorktree`,
  `Cron*`, `ScheduleWakeup`, `RemoteTrigger`, `PushNotification`, `SendMessage`,
  `DesignSync`, `Monitor`, `ReportFindings` and `Task*` from the model's context,
  so none of them is reachable. What is still missing is defence in depth:
  `bashHardDeny` floors `rm -rf`, but nothing in `policy.ts` floors
  `ExitWorktree`, which takes `{action: 'remove', discard_changes?: true}` — so
  the containment rests on one adapter list rather than on the hard-deny floor
  the rest of §4 uses. Cheap to add; decide if the layering is worth it.

- **Notice compaction.** Auto-compaction works for free and the default model is
  1M-context, so nothing breaks; what is missing is knowing. `compact_boundary`
  matches no adapter branch, so a compaction produces no thread notice and no
  audit row. Yield a notice, read `usage` alongside `total_cost_usd`, and add
  `@Condotto compact [focus]` as a first-class command rather than a hole in the
  skill allowlist.

- **Namespaced commands are silently dropped.** `enumerateSkills` does one
  non-recursive `readdirSync` (`adapter.ts:339`), so `commands/frontend/x.md`
  never enumerates and never appears in the `refused` map either, despite
  `SKILL_NAME_RE` already accepting the `namespace:name` form.

- **Pin transcript retention.** `cleanupPeriodDays` is never set and `stop clean`
  deletes the cwd that keys the runtime's session storage, orphaning files with no
  GC on Condotto's side. A thread parked past the retention window self-heals into
  "starting fresh (prior context lost)" with no warning.

---

## Documentation corrections

`DESIGN.md` describes three things that are not built. Fix the text or build the
feature, but do not leave them as-is, because the process rule is that DESIGN.md
gets updated when reality disagrees with it.

- §8 claims daemon-configured MCP via `mcpServers`. Not implemented. Repeated on
  `RepoConfig.trusted` in `types.ts:556-557`.
- DESIGN.md:131 states "the session reads the whole thread as context." It does
  not.
- DESIGN.md:131 says members "drop screenshots", and DESIGN.md:1222-1226 even
  records the exact download recipe. Not implemented. README.md:252 tells
  operators to grant a `files:read` scope the code never uses.

---

## Deliberately not on this list

Recorded so they are not re-litigated. Each was considered and rejected as either
having no Slack shape or already being answered by something Condotto has.

- **TUI affordances** — vim mode, keybindings, Esc-Esc, statusline, terminal
  rendering, IDE extensions. No Slack shape.
- **`@path` file references** — client-side terminal autocomplete, not a runtime
  feature. A headless caller gets no expansion either, and in Slack `@` opens the
  member picker. `Read` and `Glob` cover it in one round trip.
- **`/export`** — the conversation is already in Slack: durable, searchable,
  permalinkable, readable by people with no shell. A better answer to the same
  need.
- **`/doctor`** — boot already validates repo paths, warns on zero architects and
  on an unsupported model or effort, and logs the auth mode. The one real hole, a
  bad credential booting green, is closed by the error-legibility work in
  Milestone 5.
- **Committing and opening a PR** — `git commit`, `git push` and `gh pr create`
  are ordinary gated Bash, `GH_TOKEN` survives the env scrub, and `runShip`
  already pipes command output into the thread so a PR URL surfaces for free. A
  missing README recipe, not a missing capability.
- **`/review`, `/security-review`** — excluding the runtime's growing built-ins
  from the dispatch allowlist is correct, because a denylist over them fails
  *open* on upgrade. A repo's own `review` skill enumerates immediately, and prose
  works today.
- **`/memory`** — `policy.ts:586-616` already auto-allows a main-agent read of
  the memory root and gates writes, so reading and fixing notes both work
  in-thread. A dedicated command is polish over a working path.
- **Approval expiry timers** — pending-until-decided is the right semantics for a
  call paused un-executed. A timer would convert a deliberate wait into a silently
  dropped action. (The real problem there is the missing ping, in Milestone 4.)
- **Cancel being architect-only** — a deliberate authority decision with the
  rationale in-line. Slack channel membership is broad and unverified against the
  repo, so an open cancel is a denial-of-service surface on other people's
  threads. An initiator-scoped self-cancel is a reasonable feature request, not a
  missing Claude Code capability.
- **Output styles** — the Condotto system prompt is re-sent every turn and does
  strictly more, carrying the gate contract, plan-mode rules and memory framing.
- **`settings.local.json`** — the personal gitignored tier of a single-human
  terminal. A daemon's per-operator tier is `condotto.toml`. (The `user` tier is a
  real question; see Milestone 6.)
- **1M context** — already the default; the older beta header would buy nothing.
- **Nothing re-injecting thread history after `clear`** — real `/clear` has
  identical semantics, and the two mechanisms Claude Code offers for cross-reset
  continuity, project instructions and auto-memory, are both present and both
  survive.
- **Audit reading** — the table is complete and correct, a read path is already
  logged as not-yet-built, and Claude Code ships no audit reader either.

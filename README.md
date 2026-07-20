# Condotto

**Empower your whole team to build software with AI, right in Slack.**

Condotto gives any Slack thread its own persistent
[Claude Code](https://claude.com/claude-code) session, running on your own dev
machine with your real repo, your real toolchain, and your real deploy path.
Describe what you want in plain language. The AI writes the code, runs the
tests, and posts progress in the thread. When it reaches for something
consequential, an engineer clicks Approve.

That changes who gets to build. **The people who know what to build can now
build it themselves**, working alongside your engineers instead of waiting on
them. A product manager ships the fix instead of filing a ticket about it. A
support lead chases the root cause instead of waiting for someone to free up.

What teams use it for:

- **Fix the bug you filed.** The PM who reported it drives the fix, tests and
  all, with an engineer approving the changes.
- **Ship a feature from a plain-language spec.** You bring the what and the
  why; the AI implementer handles the code.
- **Debug support issues together.** Read the logs and chase the root cause in
  the open channel, as a team.
- **Ask production a question, safely.** Answers come back as aggregates only
  (counts, rates, yes or no), never raw rows.

**Guardrails that help, not hinder.** Reading and analysis run freely, so the
conversation never stalls. Writes, shell commands, production reads, and
deploys pause until an engineer approves, every action is written to an audit
log, and a hard-deny floor blocks the truly dangerous moves for everyone. The
guardrails are not there to slow your team down. They are what make it safe to
hand real building power to the whole team.

Every session is a three-way collaboration: the domain expert drives the what
and why, the AI implementer writes and tests the code, and the architect (your
engineer with approval authority) signs off on the moves that matter.

**How it's different.** Claude in Slack and Claude Code on the web run in
Anthropic-hosted sandboxes, and the Claude Code CLI is one person at one
terminal. Condotto is your machine, your credentials, and your deploy path,
driven from Slack by your whole team.

Software engineering and product management are evolving fast, and the line
between them is blurring. Condotto is helping define what comes next:
collaborative team coding, where AI does the typing, people make the calls,
and nobody waits in a queue.

Condotto is built for a small, mutually trusting team whose architect
self-hosts it. See the [Security & trust model](#security--trust-model) for
exactly what that means, and what Condotto does and does not defend against.

**Contents**
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install](#install)
- [Create the Slack app](#create-the-slack-app)
- [Configure `condotto.toml`](#configure-condottotoml)
- [Run](#run)
- [Your first session](#your-first-session)
- [Command reference](#command-reference)
- [Development](#development) — *tests and smoke tests*
- [Security & trust model](#security--trust-model) — *how the architect empowers domain experts*
- [Operations (runbook)](#operations-runbook) — *service units, the audit log, upgrades, cost, troubleshooting*
- [Further reading](#further-reading)

---

## How it works

One long-lived daemon runs on your development computer. When a thread is
assigned, the daemon:

1. Creates a fresh **git worktree** off the repo's default branch (the agent only
   ever sees *committed* content — never your working tree, `.env`, or ignored
   files) and starts a persistent Claude Code session in it.
2. Streams the thread's messages into that session, framed so message *content*
   can never impersonate a command.
3. **Mechanically gates every tool call.** Reads and analysis run freely; writes,
   arbitrary shell, network, production-data access, and the deploy path pause
   un-executed until an architect approves (or, for an architect's own turn,
   auto-approve lets them through — see below). A hard-deny floor (escaping the
   worktree, touching credentials, `rm -rf` the box) can't be overridden by anyone.
4. **Parks** the session when idle and **resumes** it — same worktree, same
   history — whenever the thread wakes up. One conversation maps to one session
   for its entire life.
5. **Audits everything** — every tool call, approval, decision, and deploy — to an
   append-only log in the SQLite store.

Slack is the default surface and Claude Code the default harness, but the core is
written against interfaces (a *surface port* and a *harness port*), so other chat
platforms and coding agents can be added later without touching the core.

---

## Requirements

- **A development computer**, macOS or Linux. An always-on box (or a Mac that
  doesn't sleep) is best — a laptop that sleeps kills an *actively-streaming*
  turn (parked sessions survive on disk and resume). See DESIGN.md §3
  "Deployment shapes".
- **Git**, plus whatever toolchain your repos need (Node, Bun, test runners…).
- A **Claude subscription** (e.g. Max) logged in on the machine via the `claude`
  CLI, **or** a `CLAUDE_CODE_OAUTH_TOKEN` for a headless box (see
  [Authenticate Claude](#authenticate-claude)). No `ANTHROPIC_API_KEY` is
  required for this deployment.
- **[Bun](https://bun.sh) 1.2+** — required to run from source; not needed if you
  use a prebuilt binary.
- A **Slack workspace** where you can create an app (you need admin, or an admin
  who'll approve the app).

---

## Install

Two paths. Pick one.

### Option A — from source (Bun)

Condotto is TypeScript run directly by Bun. There is no build step. Run these
four commands.

```sh
curl -fsSL https://bun.sh/install | bash            # install Bun (https://bun.sh)
git clone https://github.com/chadrem/condotto.git
cd condotto
bun install --frozen-lockfile                       # always use the lockfile
```

**Always install with `--frozen-lockfile`.** It gives you the exact dependency
versions Condotto is tested against. Slack Bolt is pinned to v4 on purpose,
because Bolt 5 cannot run on Bun. Never run `bun add @slack/bolt`, which
upgrades you to v5 and produces a daemon that connects and then fails its
heartbeat forever. If that already happened to you, see
[Troubleshooting](#troubleshooting).

Next: [create the Slack app](#create-the-slack-app).

### Option B — prebuilt binary + `claude` sidecar

A release is **two files shipped together**:

- `condotto` — the compiled daemon (a single `bun build --compile` binary), and
- `claude` — the Claude Code native runtime the daemon spawns. It **cannot** be
  embedded in the binary, so it rides alongside.

Keep both files **in the same directory**. At startup the daemon finds `claude`
next to itself (or wherever `CONDOTTO_CLAUDE_CLI` points).

Build the bundle yourself from a clone (produces `dist/<platform>/{condotto,claude}`):

```sh
bun run build                       # host platform
bun run build:linux-x64             # or a specific target
```

> Cross-compiling builds the `condotto` binary for any target, but the `claude`
> sidecar is an OS/CPU-gated package — only the **host's** is on disk. For a
> different target, run the build on that platform (or a matching CI runner), or
> drop that platform's `claude` into the `dist/<platform>/` folder yourself.

### Authenticate Claude

Condotto uses your machine's Claude login — no API key.

- **Desktop / your own machine:** run `claude` once and log in. The SDK reuses
  the keychain OAuth credentials automatically. Nothing else to do.
- **Headless box (no keychain):** mint a token and export it where the daemon can
  read it:
  ```sh
  claude setup-token        # prints a CLAUDE_CODE_OAUTH_TOKEN
  export CLAUDE_CODE_OAUTH_TOKEN=...   # or set it in the service unit's env file
  ```

The daemon scrubs its own `SLACK_*`/`CONDOTTO_*` secrets out of the agent's shell,
but **keeps** the Claude auth the runtime needs.

---

## Create the Slack app

Condotto connects over **Socket Mode** (an outbound WebSocket), so there is **no
public URL to host** — it runs happily behind your firewall or on a laptop.

Create the app at <https://api.slack.com/apps> → **From scratch**, in the
workspace you'll use it in. Then:

1. **Socket Mode** → toggle **on**. This mints an **app-level token** (`xapp-…`)
   with `connections:write`. That's your `app_token`.
2. **OAuth & Permissions → Bot Token Scopes** — add:
   - `chat:write` — post replies and approval buttons.
   - `chat:write.customize` — per-session display names (optional but nice).
   - `commands` — the `/condotto` slash command.
   - `app_mentions:read` — the `@Condotto …` mention path.
   - `channels:history`, `groups:history` — read thread messages (public /
     private channels). Add `im:history` / `mpim:history` only if you support DMs.
   - `files:read`, `files:write` — download screenshots a human drops in, upload
     files the session produces.
   - `users:read` — resolve user IDs ↔ names (needed for `@Condotto grant @user`).
3. **Install to workspace** — this mints the **bot token** (`xoxb-…`). That's your
   `bot_token`.
4. **Event Subscriptions** → on (no URL under Socket Mode). Subscribe to bot
   events: `message.channels`, `message.groups` (+ `.im`/`.mpim` if used), and
   `app_mention`.
5. **Slash Commands** → create `/condotto` (the "Request URL" field can be any
   placeholder — Socket Mode delivers it).
6. **Interactivity & Shortcuts** → **on** (required for the Approve / Deny
   buttons; Socket Mode delivers the clicks).
7. **Invite the bot to your channel**: `/invite @Condotto`. Without this, reads
   fail with `not_in_channel`.

Design notes on the Slack adapter — why Socket Mode is a hard requirement and
how each scope maps to an adapter capability — live in **DESIGN.md Appendix C**.

> **Finding a user's Slack ID** (for `architects` in the config): open their
> profile → **⋯** → **Copy member ID**. It looks like `U0123ABC`; Condotto writes
> it surface-qualified as `slack:U0123ABC`.

---

## Configure `condotto.toml`

Condotto reads **one** file: `condotto.toml`. Copy the tracked, commented template
and fill it in:

```sh
cp condotto.example.toml condotto.toml
$EDITOR condotto.toml
```

`condotto.toml` is **gitignored** because it holds your Slack tokens. The daemon
discovers `./condotto.toml` by default; override with `--config <path>` or
`CONDOTTO_CONFIG`. **Every value can also be set (or overridden) by an environment
variable**, and the env var always wins — so you can keep secrets out of the file
if you prefer.

The daemon **validates at boot** and fails fast with an actionable message on a
missing file, malformed TOML, or a bad required field — never a half-started
daemon.

The one file to know. Read [`condotto.example.toml`](condotto.example.toml) — it's
heavily commented — but at a glance:

```toml
# Surface-qualified principals with command authority (approve, land/deploy,
# grant). WITHOUT at least one, nobody can approve gated actions.
architects = ["slack:U0123ABC"]

[slack]
bot_token = "xoxb-…"   # Bot User OAuth Token   (env: SLACK_BOT_TOKEN)
app_token = "xapp-…"   # App-Level Token         (env: SLACK_APP_TOKEN)

[paths]
db = "condotto.sqlite"                       # audit log, sessions, roles (env: CONDOTTO_DB_PATH)
worktrees_root = "~/tmp/condotto-worktrees"  # per-session git worktrees   (env: CONDOTTO_WORKTREES_ROOT)
memory_root = "~/.condotto/memory"           # durable agent memory        (env: CONDOTTO_MEMORY_ROOT)

[defaults]                 # used when a repo below sets none
model = "opus"             # opus | sonnet | fable          (env: CONDOTTO_DEFAULT_MODEL)
effort = "high"            # low | medium | high | xhigh | max  (env: CONDOTTO_DEFAULT_EFFORT)
auto_approve = true        # architects skip their own Approve click (env: CONDOTTO_AUTO_APPROVE=off)
cost_cap_usd = 10          # per-thread runaway brake       (env: CONDOTTO_COST_CAP_USD)
max_concurrent_turns = 6   # box-wide cap on live turns     (env: CONDOTTO_MAX_CONCURRENT_TURNS)

# A repo Condotto can be pointed at. Assign it with `/condotto assign webapp`.
[[repos]]
name = "webapp"
path = "~/Projects/webapp"        # absolute path to the git repo (required)
default_branch = "main"
trusted = false                   # true loads the repo's own CLAUDE.md/skills/.claude — vouch first
memory = false                    # true gives the agent durable memory for this repo — vouch first
safe_bash_allowlist = ["git status", "bun test"]  # auto-allowed without approval
test_cmd = "bun test"             # auto-run so the agent verifies its own work
land_cmd = "make land"            # architect-ordered `@Condotto land`, run by the daemon (not the agent)
deploy_cmd = "make deploy"        # architect-ordered `@Condotto deploy`, same handling
# cost_cap_usd / default_model / default_effort / auto_approve  # per-repo overrides
```

**At least one `[[repos]]` entry is required.** There is no default repo: Condotto
only works in repos you name, and it refuses to start with none configured.

A monorepo is **one** `[[repos]]` entry — you pick the sub-project when you assign
(`/condotto assign webapp/apps/report`), not here. See [Monorepos](#monorepos) for
what that means for `test_cmd` and `land_cmd`.

For your first session, point an entry at a throwaway clone and leave land/deploy
as no-ops until you've watched the gate work:

```sh
git init ~/tmp/condotto-testbed
(cd ~/tmp/condotto-testbed && git commit --allow-empty -m init)
```

```toml
[[repos]]
name = "testbed"
path = "~/tmp/condotto-testbed"
land_cmd = "echo '[land] no-op'"
deploy_cmd = "echo '[deploy] no-op'"
# test_cmd = "bun test"   # add once the repo actually has tests
```

---

## Run

From source:

```sh
bun start                       # = bun run src/daemon.ts
bun start -- --config /etc/condotto/condotto.toml
```

From a binary bundle:

```sh
./condotto                       # discovers ./condotto.toml
./condotto --config /etc/condotto/condotto.toml
./condotto --version             # -> condotto 0.1.0
./condotto --help
```

A clean boot logs something like:

```
… [daemon] seeded 1 role mapping(s), 1 architect(s)
… [daemon] cost cap $10/thread (default), max 6 concurrent turns, default model opus @ high effort, architect auto-approve ON by default
… [daemon] ready — db=…/condotto.sqlite, sessions on record: 0
```

If you see `WARNING: no architects configured`, gated actions will have no one who
can approve them — set `architects` and restart.

To keep it running across reboots, install a service unit — see
[Running as a service](#running-as-a-service).

---

## Your first session

In a channel the bot has been invited to (you're the architect who set it up, so
you can assign):

1. **Assign a session:** `/condotto assign <repo>` (naming one of your `[[repos]]`)
   Condotto posts an anchor message; its thread is your session. (To assign an
   *existing* thread instead, mention **`@Condotto assign`** inside it — slash
   commands can't run in threads.) Working in a monorepo? Name the sub-project
   too — `/condotto assign <repo>/apps/report`. See [Monorepos](#monorepos).
2. **Talk to it in the thread.** Ask it to explore, explain, or plan — reads run
   without approval. "What does this repo do?" "Add a `/health` endpoint that
   returns 200."
3. **Approve the write.** When it goes to edit a file or run non-allowlisted
   shell, an architect gets an **Approve / Deny** prompt (or, with auto-approve
   on, an architect's own turn just proceeds). Members can watch but can't decide.
4. **Ship it:** `@Condotto land` (and `@Condotto deploy`) run the repo's configured
   command **through the gate** — no-ops until you wire them to something real.
5. **End it:** `@Condotto stop` keeps the worktree for later; `@Condotto stop clean`
   schedules it for teardown.

---

## Command reference

**Slash commands** (channel top level — they can't run inside a thread):

| Command | Who | Does |
|---|---|---|
| `/condotto assign <repo>[/<sub-project>]` | architect | Start a new session in this channel. Omit the repo and Condotto asks which one — there is no default. In a monorepo, add a sub-project to start there. |
| `/condotto status` | architect | Daemon-wide **operator dashboard** (ephemeral): uptime, session counts, turns-in-flight vs. cap, pending approvals, config summary. |
| `/condotto stop` | anyone | Lists this channel's sessions and points you to the in-thread stop. |

**Who can do what.** *Assigning* a session is command authority — **architects
only** (as are approvals, land/deploy, grant, and every setting). **Anyone** can
*converse* in an assigned thread; a member's instructions are acknowledged but
never executed without an architect's approval. To let a domain expert drive
sessions themselves, an architect `@Condotto grant`s them architect rights (see
[the trust model](#empowering-domain-experts--grant--auto-approve)).

**In-thread** (mention `@Condotto` inside a session thread):

| Mention | Who | Does |
|---|---|---|
| `@Condotto assign <repo>[/<sub-project>]` | architect | Assign *this* thread as a session. Omit the repo and Condotto asks which one. See [monorepos](#monorepos). |
| `@Condotto status` | anyone | This channel's sessions + their settings. |
| `@Condotto stop [clean]` | architect | End the session; `clean` also discards the worktree. |
| `@Condotto cancel` | architect | Interrupt the running turn (e.g. a runaway workflow); the session lives on. |
| `@Condotto land` / `@Condotto deploy` | architect | Run the repo's ship path (gated; daemon-run). |
| `@Condotto budget <usd>` | architect | Raise this thread's cost ceiling. |
| `@Condotto model <opus\|sonnet\|fable>` | architect | Set the implementer model. |
| `@Condotto effort <low…max>` | architect | Set reasoning effort. |
| `@Condotto subagents on\|off` | architect | Read-only parallel exploration fan-out. |
| `@Condotto workflows on\|off` | architect | Multi-agent Workflow tool (gated + confined). |
| `@Condotto workflows write on\|off` | architect | Let confined workflow/subagent calls write **in the worktree** without a per-write click (out-of-worktree/credentials still refused). |
| `@Condotto ultra on\|off` | architect | Preset: `xhigh` effort + subagents + workflows. |
| `@Condotto auto-approve on\|off` | architect | Run an architect's own turns without the Approve click (on by default). |
| `@Condotto grant @user architect [everywhere]` | architect | Delegate authority (this channel, or `everywhere`). Persists across restarts. |
| `@Condotto revoke @user [everywhere]` | architect | Remove a runtime grant. |

---

## Monorepos

If a repo holds several apps or services side by side, name the one you want and
Condotto starts there — the same `cd apps/report` you'd do before opening an editor:

```
@Condotto assign monorepo/apps/report
@Condotto assign monorepo apps/report   # same thing, if you prefer a space
@Condotto assign monorepo               # the repo root
```

The agent's working directory becomes that sub-project, so its `CLAUDE.md`, its
scripts, and relative paths all resolve the way a human working there expects.

**The whole worktree stays in scope.** Only the starting point moves — the agent
can still read and edit shared packages, root configuration, and sibling
sub-projects, because real monorepo changes rarely stay in one folder. The
security boundary is unchanged: it is the worktree, and everything outside it is
hard-denied exactly as before.

Two things follow from the cwd being the sub-project:

- **`land_cmd` / `deploy_cmd` run there**, not at the repo root. For a per-app
  Makefile that's what you want. For a root-level runner, write the command to
  step up: `cd ../.. && turbo run deploy`.
- **`test_cmd` runs there too.** Set it to the sub-project's own test command.
  If you'd rather run the root suite, add both `cd ../..` and that command to the
  repo's `safe_bash_allowlist` — otherwise the compound command isn't fully
  allowlisted and the agent's free verify-before-land loop starts asking for
  approval on every run.

A session's sub-project is fixed when it's assigned and can't be changed
afterwards (the agent's conversation history is tied to its working directory).
To work somewhere else, start a new thread.

---

## Security & trust model

This is the heart of the product. The daemon is, by construction, a remote-code-
execution portal — it takes text from Slack and runs an agent with a shell, a
repo, and deploy keys. Two layers keep that honest:

**1. Mechanical tool gating.** A `PreToolUse` hook the agent cannot talk its way
past sorts every tool call into:
- **Auto-allow** — read-only, side-effect-free (`Read`, `Glob`, `Grep`, the repo's
  safe bash allowlist). Analysis never needs a human.
- **Gate** — writes, edits, arbitrary shell, network, production-data, `git push`,
  the deploy path. The call **pauses un-executed** until an architect approves.
- **Hard-deny** — escaping the worktree, credential/secret access, `rm -rf` the
  box. Refused for **everyone**, always. Nothing below can override it.

**2. Role-verified approvals.** A gate is resolved only by an architect, checked
**server-side** against the roles table by verified Slack user ID — never a
display name, never text in a message body (this exact impersonation attack was
found in the prototype). Members can see the prompt; their clicks are rejected.

### Empowering domain experts — grant + auto-approve

The whole product vision is: an architect (expert in the *tech*) empowers domain
experts (expert in the *product*, varied coding depth) to do real engineering in
Slack. Two features make that practical:

- **`@Condotto grant @user architect [everywhere]`** delegates command authority at
  runtime — no config edit, no restart. Default scope is *this channel*; add
  `everywhere` for all channels. Grants are **persisted** and survive restarts
  (while `condotto.toml` stays authoritative for config-defined roles).
  `@Condotto revoke @user` takes it back.
- **`@Condotto auto-approve on|off`** (on by default) lets an **architect's own**
  turns skip the Approve click. When an architect is driving a verified surface,
  a gate-tier call just runs — so the architect can work at speed and step in to
  approve only when a *member's* turn reaches for something gated. The
  **mechanical hard-deny floor still holds** even under auto-approve: out-of-
  worktree access, credential/secret exfiltration, and host-escape commands are
  still refused with no button. Dial it off per thread with `@Condotto auto-approve
  off`, or globally with `CONDOTTO_AUTO_APPROVE=off`.

> **Residual risk, stated plainly (accepted for the trusted-team model):** under
> auto-approve, in-worktree shell on an architect's turn runs without a click, and
> the agent's shell still inherits the Claude OAuth token the runtime needs. The
> disposable worktree, unforgeable framing, verified-surface gating, and full
> audit trail bound the blast radius; the hard-deny floor blocks the sharpest
> credential-exfil and host-escape shapes. This is a deliberate trade for a team
> that already trusts each other, not a claim of isolation.

### What Condotto does **not** defend against

Condotto is for a **small, mutually-trusting team** — a startup's PM plus a couple
of engineers, or a squad inside a larger org — where **everyone with Slack-and-
repo access is trusted**. Enforcing *that* boundary (who's in the channel, who can
reach the box) is **the installer's job**, documented here, not engineered
against. Condotto invests heavily in defense against *mistakes*, *prompt injection
from thread content*, and *accidental blast radius* — but it deliberately does
**not** try to isolate against a hostile insider, and it is **not** multi-tenant
SaaS. Scope the daemon's credentials to itself (its own least-privilege deploy key
and cloud role — never a human's personal keychain). See DESIGN.md §1 and §4.

---

## Operations (runbook)

### Running as a service

Sample units live in [`deploy/`](deploy/); each has step-by-step install comments
at the top. Edit the paths/user to match your install before enabling.

- **Linux (systemd):** [`deploy/condotto.service`](deploy/condotto.service). Runs as
  a dedicated `condotto` user, restarts on failure, reads the Claude token from an
  `EnvironmentFile`, and shuts down cleanly on `SIGTERM`.
  ```sh
  sudo cp deploy/condotto.service /etc/systemd/system/
  sudo systemctl daemon-reload && sudo systemctl enable --now condotto
  journalctl -u condotto -f
  ```
- **macOS (launchd):** [`deploy/com.condotto.daemon.plist`](deploy/com.condotto.daemon.plist).
  Install as a **per-user LaunchAgent** (`~/Library/LaunchAgents/`) so it runs in
  your session and can reach keychain OAuth — no token needed.
  ```sh
  cp deploy/com.condotto.daemon.plist ~/Library/LaunchAgents/
  launchctl load ~/Library/LaunchAgents/com.condotto.daemon.plist
  ```

### Reading the audit log

Every consequential action — tool calls, approval requests, who clicked
Approve/Deny, deploys, session lifecycle — is written to the **`audit_log`** table
in the SQLite store. (A read-only Slack audit *channel* is planned but deferred
past this beta; for now you read the log locally.) The trail is load-bearing: it's
how you reconstruct what the agent did and who approved it.

Query it with any SQLite client — `sqlite3` ships with macOS and most Linux:

```sh
# Recent gated / approval / deploy activity (newest first)
sqlite3 -header -column condotto.sqlite \
  "SELECT ts, actor, event, substr(detail,1,70) AS detail
     FROM audit_log
    WHERE event IN ('tool_call','approval_request','approval_decision','auto_approved','deploy','session_stopped')
    ORDER BY id DESC LIMIT 20;"

# Who approved or denied what
sqlite3 -header -column condotto.sqlite \
  "SELECT ts, actor AS clicker,
          json_extract(detail,'\$.decision') AS decision,
          json_extract(detail,'\$.tool')     AS tool
     FROM audit_log WHERE event='approval_decision'
    ORDER BY id DESC LIMIT 20;"

# Anything that was hard-denied or is still waiting on a click
sqlite3 -header -column condotto.sqlite \
  "SELECT ts, event, json_extract(detail,'\$.decision') AS decision,
          json_extract(detail,'\$.summary') AS summary
     FROM audit_log
    WHERE json_extract(detail,'\$.decision') LIKE 'deny%' OR event='approval_request'
    ORDER BY id DESC LIMIT 20;"

# Full timeline for one session (find its id in the queries above)
sqlite3 -header -column condotto.sqlite \
  "SELECT ts, actor, event FROM audit_log WHERE session_id='<SESSION_ID>' ORDER BY id ASC;"
```

`detail` is JSON, so `json_extract(detail, '$.field')` pulls out fields. Common
events and actors:

| `event` | `actor` | `detail` highlights |
|---|---|---|
| `tool_call` | `agent` | `tool`, `toolUseId`, `decision` (`allow`, `allow(architect-approved)`, `allow(auto-approved)`, `gate`, `deny(…)`) |
| `approval_request` | `agent` (agent tool gate) or the ordering architect's `slack:U…` (land/deploy) | agent: `tool`, `toolUseId`, `summary`, `concern?` (e.g. `production-data`); land/deploy: `tool`, `kind`, `command` |
| `approval_decision` | the clicker's `slack:U…` | `requestId`, `decision`, `tool` |
| `auto_approved` | the architect's `slack:U…` | the auto-approved call |
| `session_assigned` | `slack:U…` | `repo`, `branch`, `worktree` |
| `session_reactivated` / `session_stopped` | `slack:U…` | empty; `stop clean` adds `clean`/`cleanupAt`, reactivation adds `cleanupCancelled` |
| `message_in` / `message_out` | `slack:U…` / `agent` | the conversation trail |
| `role_granted` / `role_revoked` | the granting `slack:U…` | delegation changes |
| `budget_exceeded` / `error` | `system` | runaway-cap trips, failures |

> Query the DB read-only against the live daemon. `sqlite3` in WAL mode reads
> without blocking the writer; if you want a guaranteed-consistent snapshot,
> `sqlite3 condotto.sqlite ".backup snapshot.sqlite"` and query the copy.

### Upgrades & schema migrations

Upgrade in place: stop the daemon, swap the `condotto` binary (keep its `claude`
sidecar in sync), start it. On boot the daemon runs **ordered `user_version`
schema migrations** over your existing SQLite store, so an upgrade never strands
an install. Running an **older** binary against a store a newer one wrote is
refused (downgrades aren't supported) — keep the binary ≥ the store's version.

### Worktrees & cleanup

Per-session worktrees live under `[paths].worktrees_root`. The daemon sweeps
hourly (and once at boot) and reclaims only **unreferenced** trees and those a set
interval after an **explicit `@Condotto stop clean`** — it **never** touches a
worktree bound to a live or parked session, so a parked thread always resumes.
Plain `@Condotto stop` keeps the worktree for reactivation; use `stop clean` when
you're done with a thread for good.

### Cost governance

Each thread has a cost ceiling (`cost_cap_usd`); a runaway thread pauses and pings
the architect, who raises it with `@Condotto budget <usd>`. `@Condotto cancel`
interrupts a wedged or over-spending turn (including a detached background
workflow). Note: on subscription auth the reported `total_cost_usd` is *notional*
API pricing — treat budgets as **usage governance**; the real constraint is your
plan's rate limits.

### Backups

Back up **`condotto.toml`** (your config + secrets) and **`condotto.sqlite`** (the
audit log, sessions, and roles — include the `-wal`/`-shm` files, or checkpoint
first). Worktrees are disposable; their branches live in your real repos.

### Memory

A repo with `memory = true` gets durable agent memory: the agent keeps markdown
notes about the codebase — how it is laid out, conventions, decisions and why, dead
ends worth not repeating — and picks them up again in **later threads**. Without it
every thread starts from zero, which is why a long-running install feels like it
never learns.

Memory is scoped to **(repo, channel)**, not to a thread. Threads in the same
channel share what they learn; another channel starts clean. That mirrors how
authority works — architect grants are channel-scoped too — so memory never carries
knowledge across a line that permissions do not cross.

It is an operator vouch, like `trusted`, and off by default. What one thread writes
is loaded into the *system prompt* of every later thread in that channel, so the
person who owns the install decides once, per repo — not per session, and not the
agent. Worth knowing before you switch it on:

- Writes are **gated** like any other write. On your own turns auto-approve covers
  them silently; a member-driven turn surfaces one Approve click showing the content.
- Memory is **notes, not authority.** The agent is told so explicitly: a memory
  never grants permission and never carries an approval, no matter what it claims.
- The directory is Condotto's, not the repo's. It sits under `[paths].memory_root`,
  never inside a worktree, and it survives `stop clean` — that is the whole point.
- The agent's **shell cannot reach it.** Memory changes only through the file tools,
  so every change is gated and audited.

Storage is one markdown file per fact plus a `MEMORY.md` index. To read what a repo
has learned, or to forget it, look in `[paths].memory_root` — deleting a directory
there is a supported way to reset.

### Troubleshooting

| Symptom | Fix |
|---|---|
| `not_in_channel` on assign | `/invite @Condotto` into the channel. |
| Boot: `WARNING: no architects configured` | Set `architects` in `condotto.toml` (or `CONDOTTO_ARCHITECTS`) and restart. |
| Boot: `Repo "x" missing at …` | Point `[[repos]].path` at a real git repo, or remove the entry. |
| Boot: `No repos configured` | Add at least one `[[repos]]` entry to `condotto.toml` — there is no default repo. The message shows the shape. |
| Boot: `duplicate name "x"` | Two `[[repos]]` entries share a `name`. Names must be unique. |
| `Configuration error: …` at boot | The message names the bad field. Fix `condotto.toml` (compare against `condotto.example.toml`). |
| Binary: "found no `claude` CLI beside it" | Ship `claude` next to the `condotto` binary, or set `CONDOTTO_CLAUDE_CLI` to an installed `claude`. |
| Boot: `default model "x" not in harness models` | Use `opus`, `sonnet`, or `fable` for `[defaults].model`. |
| Approve button does nothing | The clicker isn't an architect. Check `architects` / `@Condotto grant`. |
| Repeating `Failed to send ping to Slack (… undici_1.ping is not a function)` | You have Bolt 5 / `@slack/socket-mode@3`, which Bun can't run. `rm -rf node_modules && bun install --frozen-lockfile`, then confirm with `bun pm ls \| grep -E 'bolt\|socket-mode'`. |

---

## Development

```sh
bun test                # the full unit suite — no config, no network, no auth
bun run check:ports     # guards the port boundaries (no platform imports in core)
```

**Smoke tests** exercise the real Claude Code adapter end to end — a live agent
with a real shell — so they need Claude auth, and they cost tokens. They need no
configuration otherwise: each one provisions its own throwaway git repo, its own
worktrees root, and its own scratch state under `~/.cache/condotto-smoke`
(override with `CONDOTTO_SMOKE_HOME`). They never read your `condotto.toml` and
never touch a repo you care about.

```sh
bun run smoke:gate      # gate a Write -> defer; then smoke:approve resumes and approves it
bun run smoke:create    # a real session + turn; then smoke:resume proves park & resume
bun run smoke:workflows # multi-agent Workflow, gated and confined
bun run smoke:monorepo  # sub-project cwd: project config, cross-package edits, boundary
bun run smoke:reset     # delete the scratch dir; the next run rebuilds it
```

Each run resets the fixture repo to a known state first, so a crashed or
half-finished run never poisons the next one. To point a smoke at one of your own
configured repos instead, set `CONDOTTO_SMOKE_REPO=<name>` — it will say so
loudly, since that runs an agent against a real repo.

---

## Further reading

- **[DESIGN.md](DESIGN.md)** — the authoritative engineering design:
  architecture and the two ports, the security model, the data model, and the
  verified SDK and Slack facts. This README is the overview; DESIGN.md is the
  design underneath it and does not repeat it.
- **[DECISIONS.md](DECISIONS.md)** — the chronological decision & verified-facts
  log.
- **[CLAUDE.md](CLAUDE.md)** — orientation for working in this codebase.

## License

Copyright (C) 2026 Chad Remesch

Condotto is free software, licensed under the **GNU Affero General Public
License, version 3 or later (AGPL-3.0-or-later)** — see [LICENSE](LICENSE) for
the full text. AGPL's §13 network-use clause means anyone who runs a modified
Condotto as a network service must make that modified source available to its
users. Condotto is distributed in the hope that it will be useful, but WITHOUT
ANY WARRANTY; see the license for details.

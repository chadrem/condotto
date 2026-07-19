# Condotto

**Now the person who knows what to build can build it themselves — right there
in Slack.** Assign any thread a dedicated, persistent
[Claude Code](https://claude.com/claude-code) session on your own dev machine —
real repo, real toolchain, real deploy path — and your whole team ships real
work together, every consequential move gated by an engineer and written to an
audit log.

- **Fix the bug you filed** — the PM who reported it drives the fix herself,
  tests and all, instead of waiting in an engineer's queue.
- **Ship a feature or prototype a spec** — describe the *what* and *why* in
  plain language; the AI implementer writes the code, runs the tests, and posts
  progress in the thread.
- **Debug support issues together** — read the logs and chase the root cause in
  the open channel, as a team, instead of pulling an engineer aside.
- **Pull a report from production** — safely, through the gate; only aggregates
  (counts, rates, yes/no) ever come back to the channel, never raw rows.
- **Gated and audited by default** — every write, shell command, production
  read, and deploy pauses un-executed until the architect approves, each one
  logged, with a hard-deny floor no one can override.

Under the hood it's a **three-way working conversation**: the domain expert —
such as a product manager — drives the *what* and *why* in plain language, the
AI implementer writes and tests the code, and the *architect* approves the
consequential moves.

> Condotto is the missing quadrant: **persistent, multi-session coding agents on
> your own computer, with chat threads as the entire user interface.** Claude in
> Slack and Claude Code on the web run in Anthropic-hosted sandboxes; the Claude
> Code CLI is one human at one terminal. Condotto is your machine, your
> credentials, your deploy path — driven from Slack, by a whole team.

It is meant for a **small, mutually-trusting team** whose architect
self-hosts it. See [Security & trust model](#security--trust-model)
for exactly what that means and what Condotto does — and does not — defend against.

**Contents**
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install](#install)
- [Create the Slack app](#create-the-slack-app)
- [Configure `condotto.toml`](#configure-condottotoml)
- [Run](#run)
- [Your first session](#your-first-session)
- [Command reference](#command-reference)
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

Condotto is TypeScript run directly by Bun — no build step.

```sh
# 1. Install Bun (https://bun.sh)
curl -fsSL https://bun.sh/install | bash

# 2. Get the code and its dependencies
git clone https://github.com/chadrem/condotto.git
cd condotto
bun install
```

You'll run it with `bun start` (see [Run](#run)).

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

Full rationale and the exact scope list live in **DESIGN.md Appendix C**.

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
safe_bash_allowlist = ["git status", "bun test"]  # auto-allowed without approval
test_cmd = "bun test"             # auto-run so the agent verifies its own work
land_cmd = "make land"            # architect-ordered `@Condotto land`, run by the daemon (not the agent)
deploy_cmd = "make deploy"        # architect-ordered `@Condotto deploy`, same handling
# cost_cap_usd / default_model / default_effort / auto_approve  # per-repo overrides
```

A throwaway **`testrepo`** (`~/tmp/condotto-testrepo`, override `CONDOTTO_TEST_REPO`)
is registered automatically with echo/no-op land/deploy — the safe target for
your first session. Create it with `git init ~/tmp/condotto-testrepo && (cd
~/tmp/condotto-testrepo && git commit --allow-empty -m init)`, or point a
`[[repos]]` entry named `testrepo` at your own throwaway to override it.

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

1. **Assign a session:** `/condotto assign testrepo`
   Condotto posts an anchor message; its thread is your session. (To assign an
   *existing* thread instead, mention **`@Condotto assign`** inside it — slash
   commands can't run in threads.)
2. **Talk to it in the thread.** Ask it to explore, explain, or plan — reads run
   without approval. "What does this repo do?" "Add a `/health` endpoint that
   returns 200."
3. **Approve the write.** When it goes to edit a file or run non-allowlisted
   shell, an architect gets an **Approve / Deny** prompt (or, with auto-approve
   on, an architect's own turn just proceeds). Members can watch but can't decide.
4. **Ship it:** `@Condotto land` (and `@Condotto deploy`) run the repo's configured
   command **through the gate** — on `testrepo` those are safe no-ops.
5. **End it:** `@Condotto stop` keeps the worktree for later; `@Condotto stop clean`
   schedules it for teardown.

---

## Command reference

**Slash commands** (channel top level — they can't run inside a thread):

| Command | Who | Does |
|---|---|---|
| `/condotto assign [repo]` | architect | Start a new session in this channel (defaults to `testrepo`). |
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
| `@Condotto assign` | architect | Assign *this* thread as a session. |
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

### Troubleshooting

| Symptom | Fix |
|---|---|
| `not_in_channel` on assign | `/invite @Condotto` into the channel. |
| Boot: `WARNING: no architects configured` | Set `architects` in `condotto.toml` (or `CONDOTTO_ARCHITECTS`) and restart. |
| Boot: `Repo "x" missing at …` | Point `[[repos]].path` at a real git repo, or remove the entry. Create the default `~/tmp/condotto-testrepo` or override `CONDOTTO_TEST_REPO`. |
| `Configuration error: …` at boot | The message names the bad field. Fix `condotto.toml` (compare against `condotto.example.toml`). |
| Binary: "found no `claude` CLI beside it" | Ship `claude` next to the `condotto` binary, or set `CONDOTTO_CLAUDE_CLI` to an installed `claude`. |
| Boot: `default model "x" not in harness models` | Use `opus`, `sonnet`, or `fable` for `[defaults].model`. |
| Approve button does nothing | The clicker isn't an architect. Check `architects` / `@Condotto grant`. |

---

## Further reading

- **[DESIGN.md](DESIGN.md)** — the authoritative product & engineering design
  (architecture, the two ports, the security model, the build plan; Appendix C is
  the full Slack app setup).
- **[DECISIONS.md](DECISIONS.md)** — the decision & verified-facts log, milestone
  by milestone.
- **[CLAUDE.md](CLAUDE.md)** — orientation for working in this codebase.

## License

Copyright (C) 2026 Chad Remesch

Condotto is free software, licensed under the **GNU Affero General Public
License, version 3 or later (AGPL-3.0-or-later)** — see [LICENSE](LICENSE) for
the full text. AGPL's §13 network-use clause means anyone who runs a modified
Condotto as a network service must make that modified source available to its
users. Condotto is distributed in the hope that it will be useful, but WITHOUT
ANY WARRANTY; see the license for details.

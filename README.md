# Condotto

**Build software with your whole team, in Slack.**

Condotto gives a Slack thread its own [Claude Code](https://claude.com/claude-code)
session, running on your own machine, in your own repo. Describe what you want.
The agent writes the code, runs the tests, and posts what it did, right there in
the thread.

The point is who gets to be in the room. Your PM writes the requirement and
watches it get built. Your support lead chases the bug they reported. Your
designer checks the fix before it lands. Nobody files a ticket and waits.

You still run the show. Only an architect's message starts the agent working.
Everyone else talks in the thread, and everything they say reaches the agent on
the next turn. It stays one conversation, not a queue.

**Who this is for.** A CTO at a startup with a monorepo or a handful of small
repos, who wants to develop in the open with a team that is not all engineers.
Small, trusted, moving fast.

**How it's different.** Claude in Slack and Claude Code on the web run in
Anthropic's sandbox. The Claude Code CLI is one person at one terminal. Condotto
is your machine, your repo, your team.

**Contents**
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install](#install)
- [Create the Slack app](#create-the-slack-app)
- [Configure `condotto.toml`](#configure-condottotoml)
- [Run](#run)
- [Your first session](#your-first-session)
- [Commands](#commands)
- [Files](#files)
- [Monorepos](#monorepos)
- [What holds the agent in](#what-holds-the-agent-in)
- [Skills](#skills)
- [Memory](#memory)
- [Operations](#operations)
- [Development](#development)
- [License](#license)

---

## How it works

One daemon runs on your development machine. When you assign a thread, it:

1. Cuts a fresh **git worktree** off your default branch. The agent sees committed
   code only, never your working tree, your `.env`, or anything gitignored.
2. Starts a persistent Claude Code session in it and streams the thread's messages
   in, framed so a message can never impersonate a command.
3. **Bounds every tool call.** A hook the agent cannot talk its way past checks
   each one. Inside the worktree, work proceeds. Leaving it, touching credentials,
   or `rm -rf`-ing the box is refused for everyone, always.
4. **Moves files both ways.** What you attach lands in the worktree for the agent
   to open; what it produces comes back into the thread. See [Files](#files).
5. **Parks** the session when the thread goes quiet and **resumes** it, same
   worktree and same memory of the conversation, whenever someone speaks again.
6. **Writes everything down.** Every tool call lands in an audit log you can query.

Slack is the default surface and Claude Code the default engine, but the core is
written against interfaces, so other chat platforms and other coding agents can be
added later.

---

## Requirements

- **A development computer**, macOS or Linux. An always-on box is best. A laptop
  that sleeps will kill a turn in progress, though parked sessions survive and
  resume.
- **Git**, plus whatever your repos need to build and test.
- **An Anthropic API key** from [Claude Console](https://platform.claude.com/).
  That is the right choice whenever more than one person will drive sessions. A
  personal **Claude subscription** works if you are a solo architect running your
  own work. See [Authenticate Claude](#authenticate-claude).
- **[Bun](https://bun.sh) 1.2+**, if you run from source.
- A **Slack workspace** where you can create an app.

---

## Install

Two paths. Pick one.

### Option A: from source

```sh
curl -fsSL https://bun.sh/install | bash
git clone https://github.com/chadrem/condotto.git
cd condotto
bun install --frozen-lockfile
```

**Always use `--frozen-lockfile`.** Slack Bolt is pinned to v4 on purpose, because
Bolt 5 cannot run on Bun. `bun add @slack/bolt` upgrades you to v5 and produces a
daemon that connects and then fails its heartbeat forever. If that already happened,
see [Troubleshooting](#troubleshooting).

### Option B: prebuilt binary

A release is **two files that travel together**: `condotto`, the compiled daemon,
and `claude`, the Claude Code runtime it spawns. Keep them in the same directory.

```sh
bun run build                 # host platform, into dist/<platform>/
bun run build:linux-x64       # or a specific target
```

Cross-compiling builds the `condotto` binary for any target, but the `claude`
sidecar is OS-specific and only the host's is on disk. For another platform, build
on that platform or drop the right `claude` into `dist/<platform>/` yourself.

### Authenticate Claude

Pick by how many people will drive sessions.

**API key.** The default, and the one for teams.

```toml
[auth]
mode = "api_key"    # the key itself goes in ANTHROPIC_API_KEY
```

Get one at [Claude Console](https://platform.claude.com/), then export
`ANTHROPIC_API_KEY` where the daemon can read it. Set a spend cap in Console while
you are there.

**Subscription.** Your own Claude login, for a solo architect.

```toml
[auth]
mode = "subscription"
```

On your own machine, run `claude` once and log in; the SDK reuses the keychain
credentials. On a headless box, run `claude setup-token` and export the
`CLAUDE_CODE_OAUTH_TOKEN` it prints.

Anthropic scopes subscription OAuth to ordinary individual use, so if you run this
mode with several people driving sessions the daemon warns at boot and keeps going.
Your install, your call.

The daemon logs which credential type it found, never the value.

---

## Create the Slack app

Condotto connects over **Socket Mode**, an outbound WebSocket. There is no public
URL to host, no inbound port, no tunnel. It runs behind your firewall.

Create the app at <https://api.slack.com/apps> using **From scratch**. Then:

1. **Socket Mode** on. This mints an app-level token (`xapp-…`). That is your
   `app_token`.
2. **OAuth & Permissions → Bot Token Scopes**:
   - `chat:write`: post replies and buttons
   - `commands`: the `/condotto` slash command
   - `app_mentions:read`: the `@Condotto …` path
   - `channels:history`, `groups:history`: read thread messages. Add
     `im:history` / `mpim:history` only if you want DMs.
   - `files:read`: open files people drop in a thread
   - `files:write`: send files back
   - `users:read`: so the agent calls people by name instead of by user ID

   That is the whole list. Condotto asks for nothing else.
3. **Install to workspace.** This mints the bot token (`xoxb-…`), your `bot_token`.
4. **Event Subscriptions** on. Subscribe to `message.channels`, `message.groups`
   (plus `.im` / `.mpim` if used), and `app_mention`.
5. **Slash Commands**: create `/condotto`. The Request URL field can be any
   placeholder; Socket Mode delivers it.
6. **Interactivity & Shortcuts** on. Socket Mode delivers button clicks.
7. **Invite the bot**: `/invite @Condotto`. Without this, reads fail with
   `not_in_channel`.

> **Finding someone's Slack ID:** open their profile, click **⋯**, then **Copy
> member ID**. It looks like `U0123ABC`. Condotto writes it as `slack:U0123ABC`.

---

## Configure `condotto.toml`

One file. Copy the commented template and fill it in:

```sh
cp condotto.example.toml condotto.toml
$EDITOR condotto.toml
```

It is gitignored, because it holds your Slack tokens. The tokens and the
daemon-wide settings can each come from an environment variable instead
(`SLACK_BOT_TOKEN`, `CONDOTTO_DB_PATH`, `CONDOTTO_COST_CAP_USD`, and so on), and
the env var wins, so you can keep secrets out of the file. Repos and roles are
file-only, and `ANTHROPIC_API_KEY` is the one value the file wins over.

At a glance:

```toml
# Who can drive the agent. Without at least one, nobody can.
architects = ["slack:U0123ABC"]

[slack]
bot_token = "xoxb-…"   # env: SLACK_BOT_TOKEN
app_token = "xapp-…"   # env: SLACK_APP_TOKEN

[auth]
mode = "api_key"       # or "subscription"

[paths]
db = "condotto.sqlite"                       # audit log, sessions, roles
worktrees_root = "~/tmp/condotto-worktrees"  # per-session git worktrees
memory_root = "~/.condotto/memory"           # durable agent memory

[defaults]                 # used when a repo sets none
model = "opus"             # opus (Opus 5) | sonnet | fable
effort = "xhigh"           # low | medium | high | xhigh | max
subagents = true           # parallel exploration
workflows = true           # multi-agent workflows
memory = true              # durable notes per (repo, channel)
cost_cap_usd = 50          # per-thread runaway brake
max_concurrent_turns = 6   # box-wide cap on live turns

[[repos]]
name = "webapp"
path = "~/Projects/webapp"    # absolute path to the git repo
default_branch = "main"
# memory = false             # durable notes are on; this is how you opt out
# cost_cap_usd / default_model / default_effort / subagents / workflows override [defaults]
```

Those defaults are the full-strength posture, so a new thread starts there instead
of waiting for someone to turn it up. It is also the expensive end, which is why
the runaway brake sits at $50. Dial it down here, per repo, or per thread in Slack.

**At least one repo is required.** There is no default repo, and the daemon refuses
to start without one. A monorepo is one entry; you pick the sub-project when you
assign. See [Monorepos](#monorepos).

The daemon validates at boot and fails fast with a message naming the bad field.

For a first run, point it at a throwaway clone:

```sh
git init ~/tmp/condotto-testbed
(cd ~/tmp/condotto-testbed && git commit --allow-empty -m init)
```

---

## Run

```sh
bun start                                    # from source
bun start -- --config /etc/condotto/condotto.toml

./condotto                                   # from a binary
./condotto --config /etc/condotto/condotto.toml
./condotto --version
```

A clean boot looks like:

```
… [daemon] seeded 1 role mapping(s), 1 architect(s)
… [daemon] cost cap $50/thread (default), max 6 concurrent turns, default model opus @ xhigh effort, subagents ON / workflows ON / memory ON
… [daemon] ready — db=…/condotto.sqlite, sessions on record: 0
```

---

## Your first session

In a channel the bot has been invited to:

1. **Assign a thread.** `/condotto assign webapp` posts an anchor message, and its
   thread is your session. To use an existing thread instead, mention
   `@Condotto assign` inside it. Slash commands cannot run in threads.
2. **Say what you want.** "What does this repo do?" "Add a `/health` endpoint that
   returns 200." It explores, edits, runs the tests, and reports back.
3. **Or think first.** `@Condotto plan on` makes the thread read-only. The agent
   investigates and posts a plan, changing nothing. Read it, say what you would
   rather, and when you are happy, `@Condotto plan off` and it builds.
4. **Ship it.** Ask. Committing, pushing and opening a PR are ordinary commands.
   `GH_TOKEN` survives the environment scrub, so the PR URL comes back in the
   thread.
5. **Drop a file in.** Screenshots, logs, CSVs, a PDF spec. Condotto saves what
   you attach into the worktree and tells the agent where it is, so it can just
   open it. Ask for one back and it posts the file into the thread.
6. **Start fresh without losing work.** `@Condotto clear` forgets the conversation
   and nothing else. Same worktree, same branch, same uncommitted changes. Reach
   for it when a long thread has drifted.
7. **End it.** `@Condotto stop` keeps the worktree. `@Condotto stop clean` schedules
   it for teardown.

---

## Commands

**Slash commands**, at the top level of a channel. They cannot run inside a thread.

| Command | Who | Does |
|---|---|---|
| `/condotto assign <repo>[/<sub-project>]` | architect | Start a session in this channel. Omit the repo and Condotto asks which one. Defaults to the repo root. |
| `/condotto status` | architect | Daemon-wide dashboard: uptime, session counts, turns in flight, config. |
| `/condotto stop` | anyone | Lists this channel's sessions and points you to the in-thread stop. |

**In a session thread**, mention `@Condotto`.

| Mention | Who | Default | Does |
|---|---|---|---|
| `@Condotto assign <repo>[/<sub-project>]` | architect | — | Assign *this* thread as a session. |
| `@Condotto status` | anyone | — | This channel's sessions and their settings. |
| `@Condotto stop [clean]` | architect | — | End the session. `clean` also discards the worktree. |
| `@Condotto cancel` | architect | — | Interrupt the running turn. The session lives on. |
| `@Condotto clear` | architect | — | Forget the conversation. Worktree, branch, uncommitted work, settings, memory and spend all survive. |
| `@Condotto plan on\|off` | architect | **off** | Read-only mode. The agent investigates and posts a plan, and changes nothing until you turn it off. |
| `@Condotto budget <usd>` | architect | **$50** | Raise this thread's cost ceiling. From `cost_cap_usd`. |
| `@Condotto model <opus\|sonnet\|fable>` | architect | **`opus`** | Set the model. From `[defaults].model`. |
| `@Condotto effort <low\|medium\|high\|xhigh\|max>` | architect | **`xhigh`** | Set reasoning effort. From `[defaults].effort`. Prefer setting it early; changing it mid-thread drops the prompt cache. |
| `@Condotto subagents on\|off` | architect | **on** | Parallel exploration. From `[defaults].subagents`. |
| `@Condotto workflows on\|off` | architect | **on** | Multi-agent workflows. From `[defaults].workflows`. Turning it on turns subagents on too. |
| `@Condotto /<skill> [args]` | architect | — | Run one of your skills. Mention Condotto first: Slack eats a message that starts with `/`. |
| `@Condotto skills` | architect | — | List the skills this thread can run, and the file each one is. |
| `@Condotto grant @user <architect\|member> [everywhere]` | architect | — | Let someone else drive. The role is required. This channel unless you add `everywhere`. Survives restarts. |
| `@Condotto revoke @user [everywhere]` | architect | — | Take it back. |

Every default above comes from `condotto.toml` and can be changed there, per repo,
or per thread with the command. A thread starts at full strength: `opus` at `xhigh`
with subagents, workflows and memory all on. That is also the expensive end, which
is why the runaway brake sits at $50 — see [Cost](#cost).

**Not in this table because they are not per-thread:** durable memory is on by
default and set per repo (`memory = false` to opt out, see [Memory](#memory)); the
concurrency cap `max_concurrent_turns` (**6**) is daemon-wide; and anyone not
granted a role is a **member**, who talks in the thread without running the agent.

**Who can do what.** Only an architect's message runs the agent. Everyone else can
talk in the thread, and what they say is carried into the next architect turn as
context, so the conversation reaches the agent whole. It just does not spend a turn
on every line of two people talking. Granting someone architect is the whole
decision: hand it to people you would hand a laptop and a git remote to.

---

## Files

**Files you send.** Attach anything to a thread message and the agent can read it.
Condotto downloads it, drops it in the session's worktree, and names the path in
the message the agent sees. It works the same whether you attach it to a message
that starts a turn or just leave it in the thread for later. A screenshot of a
broken page, a failing CI log, a CSV of the rows that look wrong: all just files
the agent opens.

No size or count limit: attach what you want, and the agent gets it. If one does
not come through, Condotto says so in the thread rather than letting the agent
look like it ignored you.

**Files it sends back.** Ask for a diff, a report, a generated chart. Anything the
agent writes to `.condotto/outbox/` in its worktree is uploaded to the thread and
then deleted, so nothing gets posted twice. It is told about this directory, so
"send me that as a file" is enough.

Both directions stay inside the worktree, which means they are bounded by the same
rule as everything else. A symlink left in the outbox is skipped rather than
followed, so the outbox cannot become a way to read your machine.

---

## Monorepos

Declare the repo once. Pick the sub-project when you assign:

```
/condotto assign webapp/apps/report
```

The agent starts in `apps/report`, and **the whole worktree stays in scope**. It
can still read and edit shared packages, root config, and sibling sub-projects,
because real changes rarely stay in one folder. Commands run in the sub-project by
default, and the agent steps up to the root itself when the job needs it.

A session's sub-project is fixed when it is assigned. To work somewhere else, start
a new thread.

---

## What holds the agent in

Condotto runs on your machine, against your repos, driven by people you trust. It
does not ask you to confirm work you just asked for. Three things hold instead, and
none of them interrupts you.

**The worktree.** Every session works in a fresh, throwaway git worktree. A hook
the agent cannot talk its way past resolves every path a tool call names, and
anything outside the worktree is refused. Reads too: reading your machine and
posting the answer into Slack is its own kind of leak.

**A floor nobody crosses.** Credentials (`ANTHROPIC_API_KEY`,
`CLAUDE_CODE_OAUTH_TOKEN`, `~/.ssh`, `~/.aws`), environment dumps, `rm -rf` outside
the tree, and symlinking an outside path in. Refused for everyone, always, with no
override.

**Identity you cannot fake.** Authority comes from the Slack user ID on the event,
checked against the roles table on the server. Never a display name, never text in
a message. Message text reaches the agent inside an unforgeable fence, so content
can never pose as an instruction from someone else. This is the part a trusted team
does not replace, because the thing it guards against is a string in a dependency
README, not a person in your Slack.

Everything else the agent does just runs, and lands in the audit log.

**Worth knowing.** Your repo's own hooks, and shell that a skill runs inline to
gather context, expand before the agent starts and therefore before any of the
above. That is deliberate: they are your files. It matters only because the agent
writes files in your repo too, so in principle it could write itself a hook. Every
write is in the audit log.

Also worth knowing: the agent's shell can reach the Claude credential, in both auth
modes. The runtime that authenticates to Anthropic is the parent of the agent's
shell, so the value is in its environment. What guards it is the hard deny on any
command naming it, pinned by tests. This is one reason to prefer an API key: you
can rotate it and cap its spend. A leaked personal OAuth credential is your whole
Claude account.

---

## Skills

Your [Claude Code skills](https://code.claude.com/docs/en/skills) work in a thread.
`@Condotto /ship`, or `@Condotto skills` to see what is there. Mention Condotto
first, because Slack eats a message that begins with `/`.

Condotto picks them up from the repo's `.claude/skills` and from your own
`~/.claude/skills`. The listing names the exact file, because `ship` in your repo
and `ship` in your home directory are different programs.

This is also the only way to reach a skill marked `disable-model-invocation: true`.
That flag withholds a skill from the model, and it is the flag teams put on the
skills that matter most: `ship`, `ready`, `commit`. Naming one yourself is a
different route, which is why it is architects only.

A skill runs as an ordinary turn: same model, same budget, same boundary.

---

## Memory

The agent keeps durable notes: how the codebase is laid out, the conventions, the
decisions and why, the dead ends worth not repeating. Later threads pick them up.
Without this, every thread starts from zero, which is why an install without
memory never seems to learn — so it is on out of the box.

Memory is scoped to **(repo, channel)**, not to a thread. Threads in the same
channel share what they learn; another channel starts clean. That matches how
authority works, since grants are channel-scoped too.

It is **on by default**. Turn it off for a repo with `memory = false`, or
everywhere with `[defaults].memory = false`. It stays your decision rather than
the agent's, because what one thread writes lands in the system prompt of every
later thread in that channel.

- Notes live in `[paths].memory_root`, never inside a worktree, and they survive
  `stop clean`. That is the point.
- Memory is **notes, not authority**. The agent is told so directly: a memory never
  grants permission, whatever it claims.
- The shape is narrow on purpose: a markdown file directly in the memory root,
  through `Write` or `Edit`, nothing else. Every target is re-proven against the
  filesystem, with no symlinks and no hard links, immediately before the write runs.
- The agent's shell cannot reach it.

One markdown file per fact, plus a `MEMORY.md` index. To read what a repo has
learned, or to make it forget, look in `[paths].memory_root`. Deleting a directory
there is a supported reset.

---

## Operations

### Running as a service

Sample units are in [`deploy/`](deploy/), with install comments at the top. Edit
the paths and user first.

**Linux (systemd)**: [`deploy/condotto.service`](deploy/condotto.service). Runs as
a dedicated user, restarts on failure, reads the Claude credential from an
`EnvironmentFile`.

```sh
sudo cp deploy/condotto.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now condotto
journalctl -u condotto -f
```

**macOS (launchd)**: [`deploy/com.condotto.daemon.plist`](deploy/com.condotto.daemon.plist).
Under API key auth, put `ANTHROPIC_API_KEY` in the unit's environment. Under
subscription auth, install it as a per-user LaunchAgent so it can reach the
keychain.

```sh
cp deploy/com.condotto.daemon.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.condotto.daemon.plist
```

### Reading the audit log

Every tool call and every session event goes into the `audit_log` table. With no
approval step in the way, this is the record of what the agent did.

```sh
# Recent activity
sqlite3 -header -column condotto.sqlite \
  "SELECT ts, actor, event, substr(detail,1,70) AS detail
     FROM audit_log
    WHERE event IN ('tool_call','session_assigned','session_stopped')
    ORDER BY id DESC LIMIT 20;"

# Everything the floor refused
sqlite3 -header -column condotto.sqlite \
  "SELECT ts, json_extract(detail,'\$.tool')     AS tool,
          json_extract(detail,'\$.decision') AS decision,
          json_extract(detail,'\$.reason')   AS reason
     FROM audit_log
    WHERE event='tool_call' AND json_extract(detail,'\$.decision') LIKE 'deny%'
    ORDER BY id DESC LIMIT 20;"

# What one session actually ran
sqlite3 -header -column condotto.sqlite \
  "SELECT ts, json_extract(detail,'\$.tool') AS tool, json_extract(detail,'\$.decision') AS decision
     FROM audit_log
    WHERE event='tool_call' AND session_id='<SESSION_ID>' ORDER BY id ASC;"
```

Common events: `tool_call` (with `tool`, `decision`, and `agentId` when a subagent
made the call), `message_in` / `message_out`, `message_held` for a message kept for
the next architect turn, `attachments_received` / `attachment_sent` /
`attachment_failed`, `session_assigned` / `session_stopped`, `role_granted` /
`role_revoked`, `budget_exceeded`, `error`.

Reading the live database is safe. WAL mode reads without blocking the writer. For
a guaranteed-consistent copy, `sqlite3 condotto.sqlite ".backup snapshot.sqlite"`.

### Upgrades

Stop the daemon, swap the binary (keep its `claude` sidecar in sync), start it. The
daemon runs ordered schema migrations on boot, so an upgrade never strands an
install. Running an older binary against a newer store is refused.

### Worktrees and cleanup

Per-session worktrees live under `[paths].worktrees_root`. The daemon sweeps hourly
and at boot, reclaiming unreferenced trees and those a set interval after an
explicit `@Condotto stop clean`. It never touches a worktree bound to a live or
parked session, so a parked thread always resumes.

### Cost

Each thread has a ceiling. A runaway thread pauses and pings the architect, who
raises it with `@Condotto budget <usd>`. `@Condotto cancel` interrupts a wedged or
over-spending turn, including a detached background workflow.

Under API key auth those numbers are real money, billed per token. Set a spend cap
in Console as the backstop that does not depend on Condotto being correct. Under
subscription auth they are notional; the real constraint is your plan's rate limits.

### Backups

Back up `condotto.toml` and `condotto.sqlite` (include the `-wal` and `-shm` files,
or checkpoint first). Worktrees are disposable and their branches live in your real
repos.

### Troubleshooting

| Symptom | Fix |
|---|---|
| `not_in_channel` on assign | `/invite @Condotto` into the channel. |
| Condotto ignores my messages | Only an architect's message runs the agent. Check `architects`, or ask for `@Condotto grant`. Your message is not lost; it reaches the agent on the next architect turn. |
| Boot: `WARNING: no architects configured` | Set `architects` in `condotto.toml` and restart. |
| Boot: `Repo "x" missing at …` | Point `[[repos]].path` at a real git repo, or remove the entry. |
| Boot: `No repos configured` | Add at least one `[[repos]]` entry. There is no default repo. |
| Boot: `duplicate name "x"` | Two repo entries share a name. Names must be unique. |
| `Configuration error: …` | The message names the bad field. Compare against `condotto.example.toml`. |
| Binary: "found no `claude` CLI beside it" | Ship `claude` next to the binary, or set `CONDOTTO_CLAUDE_CLI`. |
| Boot: `default model "x" not in harness models` | Use `opus`, `sonnet`, or `fable`. |
| Repeating `Failed to send ping to Slack (… undici_1.ping is not a function)` | You have Bolt 5, which Bun cannot run. `rm -rf node_modules && bun install --frozen-lockfile`. |

---

## Development

```sh
bun test                # the full unit suite: no config, no network, no auth
bun run check:ports     # guards the port boundaries
```

**Smoke tests** drive the real Claude Code adapter end to end, with a live agent and
a real shell. They need Claude auth and they cost tokens. They need nothing else:
each one builds its own throwaway git repo and scratch state under
`~/.cache/condotto-smoke`. They never read your `condotto.toml` and never touch a
repo you care about.

```sh
bun run smoke:create    # a real session and turn; smoke:resume proves park and resume
bun run smoke:workflows # multi-agent workflows fan out, and the boundary holds
bun run smoke:plan      # plan mode: reads run, writes do not, the plan reaches the thread
bun run smoke:monorepo  # sub-project cwd, cross-package edits, the boundary
bun run smoke:attachments # the agent opens a file it was handed and sends one back
bun run smoke:reset     # delete the scratch dir; the next run rebuilds it
```

To point one at a repo of your own, set `CONDOTTO_SMOKE_REPO=<name>`. It says so
loudly, because that runs an agent against a real repo.

**[CLAUDE.md](CLAUDE.md)** is the orientation for working in this codebase: the two
ports, the invariants, and the Agent SDK gotchas worth knowing before you touch the
harness adapter.

---

## License

Copyright (C) 2026 Chad Remesch

Condotto is free software under the **GNU Affero General Public License, version 3
or later** (see [LICENSE](LICENSE)). AGPL's network-use clause means anyone running
a modified Condotto as a network service must make that modified source available
to its users. Distributed in the hope that it will be useful, but without any
warranty; see the license for details.

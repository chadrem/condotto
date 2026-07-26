# Condotto

**Empower your whole team to build software with AI, right in Slack.**

Condotto gives any Slack thread its own persistent
[Claude Code](https://claude.com/claude-code) session, running on your own dev
machine with your real repo, your real toolchain, and your real deploy path.
Describe what you want in plain language. The AI writes the code, runs the
tests, and posts progress in the thread.

That changes who gets to build. **The people who know what to build can now
build it themselves**, working alongside your engineers instead of waiting on
them. A product manager ships the fix instead of filing a ticket about it. A
support lead chases the root cause instead of waiting for someone to free up.

What teams use it for:

- **Fix the bug you filed.** The PM who reported it drives the fix, tests and
  all, with an engineer driving.
- **Ship a feature from a plain-language spec.** You bring the what and the
  why; the AI implementer handles the code.
- **Debug support issues together.** Read the logs and chase the root cause in
  the open channel, as a team.
- **Ask production a question, safely.** Answers come back as aggregates only
  (counts, rates, yes or no), never raw rows.

**Guardrails that hold, without getting in the way.** The agent works at full
speed — it writes, runs commands, and reaches the network without stopping to ask
permission. What it cannot do is leave: every file it touches is inside a
throwaway git worktree, credentials and host-escaping commands are refused
outright for everyone, and every action lands in an audit log. The boundary is
mechanical rather than procedural, which is what makes it safe to leave the agent
alone with the work.

Every session is a collaboration: your architect drives the agent, the domain
expert says what needs to be true, and the AI writes and tests the code. Anyone
can talk in the thread — an architect's message is what sets the agent going.

**How it's different.** Claude in Slack and Claude Code on the web run in
Anthropic-hosted sandboxes, and the Claude Code CLI is one person at one
terminal. Condotto is your machine, your repo, and your deploy path, driven from
Slack by your whole team.

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
3. **Mechanically bounds every tool call.** A `PreToolUse` hook the agent cannot
   talk its way past answers every call before it runs. Work inside the worktree
   proceeds; escaping it, touching credentials, or `rm -rf`-ing the box is refused
   for everyone, always, with no way to override.
4. **Parks** the session when idle and **resumes** it — same worktree, same
   history — whenever the thread wakes up. One conversation maps to one session
   for its entire life.
5. **Audits everything** — every tool call and every decision — to an
   append-only log in the SQLite store.

Slack is the default surface and Claude Code the default harness, but the core is
written against interfaces (a *surface port* and a *harness port*), so other chat
platforms and coding agents can be added later without touching the core.

---

## Requirements

- **A development computer**, macOS or Linux. An always-on box (or a Mac that
  doesn't sleep) is best — a laptop that sleeps kills an *actively-streaming*
  turn (parked sessions survive on disk and resume).
- **Git**, plus whatever toolchain your repos need (Node, Bun, test runners…).
- **An Anthropic API key** from [Claude Console](https://platform.claude.com/) —
  the documented default, and what you want whenever more than one person will
  drive sessions. A personal **Claude subscription** works instead when you are a
  solo architect driving your own sessions. See
  [Authenticate Claude](#authenticate-claude).
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

Condotto has two auth modes. Pick by **how many people will drive sessions**.

#### API key — the default, and the one for teams

An API key from [Claude Console](https://platform.claude.com/). Use this whenever
more than one person will drive sessions, which is what Condotto is for.

```sh
export ANTHROPIC_API_KEY=sk-ant-...   # or set it in the service unit's env file
```

```toml
[auth]
mode = "api_key"      # the key itself stays in the environment
```

As with the Slack tokens, the key **never has to sit in `condotto.toml`** — the
environment variable alone is a complete configuration. You *can* put it in the
file as `[auth].api_key` if your setup needs that; the file value wins over the
environment. If `mode = "api_key"` and no key is available, the daemon refuses to
start and tells you how to fix it.

The key is billed per token against your Console account, which means you get the
two things a personal credential can't give you: you can **rotate** it, and you
can set a **spend cap** in Console.

#### Subscription — a solo architect, their own sessions

Your machine's Claude login. Anthropic scopes subscription OAuth to ordinary
individual use of Claude Code and the Agent SDK, so this mode is for one operator
driving their own work — not a team on one person's plan.

```toml
[auth]
mode = "subscription"
```

- **Desktop / your own machine:** run `claude` once and log in. The SDK reuses
  the keychain OAuth credentials automatically. Nothing else to do.
- **Headless box (no keychain):** mint a token and export it where the daemon can
  read it:
  ```sh
  claude setup-token        # prints a CLAUDE_CODE_OAUTH_TOKEN
  export CLAUDE_CODE_OAUTH_TOKEN=...   # or set it in the service unit's env file
  ```

If you run this mode with more than one principal able to drive sessions, the
daemon logs a warning at boot pointing here, and then **keeps going**. It is your
install and your call; Condotto will not make that decision for you.

For what each credential is intended for, see Anthropic's
[Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
page and the [Agent SDK docs](https://code.claude.com/docs/en/agent-sdk/overview).

#### Which mode is running

The daemon logs the credential **type** at boot — never the value:

```
auth: Anthropic API key (Claude Console)
auth: Claude subscription login (single-operator path)
```

The daemon scrubs its own `SLACK_*`/`CONDOTTO_*` secrets out of the agent's shell,
and **keeps** the Claude credential the runtime needs — see
[Security & trust model](#security--trust-model) for what that means and what
guards it.

---

## Create the Slack app

Condotto connects over **Socket Mode** (an outbound WebSocket), so there is **no
public URL to host** — it runs happily behind your firewall or on a laptop.

Create the app at <https://api.slack.com/apps> → **From scratch**, in the
workspace you'll use it in. Then:

1. **Socket Mode** → toggle **on**. This mints an **app-level token** (`xapp-…`)
   with `connections:write`. That's your `app_token`.
2. **OAuth & Permissions → Bot Token Scopes** — add:
   - `chat:write` — post replies and buttons.
   - `chat:write.customize` — per-session display names (optional but nice).
   - `commands` — the `/condotto` slash command.
   - `app_mentions:read` — the `@Condotto …` mention path.
   - `channels:history`, `groups:history` — read thread messages (public /
     private channels). Add `im:history` / `mpim:history` only if you support DMs.
   - `files:read`, `files:write` — download screenshots a human drops in, upload
     files the session produces.
   - `users:read` — look up display names, so the agent refers to people by name
     instead of by raw user ID.
3. **Install to workspace** — this mints the **bot token** (`xoxb-…`). That's your
   `bot_token`.
4. **Event Subscriptions** → on (no URL under Socket Mode). Subscribe to bot
   events: `message.channels`, `message.groups` (+ `.im`/`.mpim` if used), and
   `app_mention`.
5. **Slash Commands** → create `/condotto` (the "Request URL" field can be any
   placeholder — Socket Mode delivers it).
6. **Interactivity & Shortcuts** → **on** (required for the guided-choice
   buttons; Socket Mode delivers the clicks).
7. **Invite the bot to your channel**: `/invite @Condotto`. Without this, reads
   fail with `not_in_channel`.

Socket Mode is a hard requirement, not a preference: Condotto connects outbound
to Slack, so it needs no public URL, no inbound port and no tunnel. That is what
lets it run on a box behind a firewall.

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
if you prefer. (One deliberate exception: `[auth].api_key` outranks
`ANTHROPIC_API_KEY`, so a stray key in a shell profile can't silently displace the
one you configured. The key is never *required* in the file either way.)

The daemon **validates at boot** and fails fast with an actionable message on a
missing file, malformed TOML, or a bad required field — never a half-started
daemon.

The one file to know. Read [`condotto.example.toml`](condotto.example.toml) — it's
heavily commented — but at a glance:

```toml
# Surface-qualified principals with command authority. Only an architect's
# message runs the agent. WITHOUT at least one, nobody can drive it.
architects = ["slack:U0123ABC"]

[slack]
bot_token = "xoxb-…"   # Bot User OAuth Token   (env: SLACK_BOT_TOKEN)
app_token = "xapp-…"   # App-Level Token         (env: SLACK_APP_TOKEN)

[auth]
# "api_key" (default for team use) or "subscription" (one operator, own sessions).
# The key itself belongs in ANTHROPIC_API_KEY, not here.
mode = "api_key"

[paths]
db = "condotto.sqlite"                       # audit log, sessions, roles (env: CONDOTTO_DB_PATH)
worktrees_root = "~/tmp/condotto-worktrees"  # per-session git worktrees   (env: CONDOTTO_WORKTREES_ROOT)
memory_root = "~/.condotto/memory"           # durable agent memory        (env: CONDOTTO_MEMORY_ROOT)

[defaults]                 # used when a repo below sets none
model = "opus"             # opus (= Opus 5) | sonnet | fable  (env: CONDOTTO_DEFAULT_MODEL)
effort = "xhigh"           # low | medium | high | xhigh | max  (env: CONDOTTO_DEFAULT_EFFORT)
subagents = true           # parallel read-only subagents    (env: CONDOTTO_SUBAGENTS=off)
workflows = true           # multi-agent workflows, gated    (env: CONDOTTO_WORKFLOWS=off)
cost_cap_usd = 50          # per-thread runaway brake       (env: CONDOTTO_COST_CAP_USD)
max_concurrent_turns = 6   # box-wide cap on live turns     (env: CONDOTTO_MAX_CONCURRENT_TURNS)

# A repo Condotto can be pointed at. Assign it with `/condotto assign webapp`.
[[repos]]
name = "webapp"
path = "~/Projects/webapp"        # absolute path to the git repo (required)
default_branch = "main"
trusted = false                   # true loads the repo's own CLAUDE.md/skills/.claude — vouch first
memory = false                    # true gives the agent durable memory for this repo — vouch first
# cost_cap_usd / default_model / default_effort / subagents / workflows  # per-repo overrides
```

Those `[defaults]` are the **ultra** posture — `xhigh` effort plus subagents plus
workflows is exactly what `@Condotto ultra on` sets, so a new thread starts at full
strength instead of waiting for someone to raise it. That is the expensive end of the
dial: `xhigh` spends meaningfully more than `high`, which is why the runaway brake sits
at $50 rather than $10. Dial it down daemon-wide here, per-repo below, or per-thread in
Slack. Omitting `subagents`/`workflows` on a repo inherits the daemon default — which is
not the same as setting them to `false`.

**At least one `[[repos]]` entry is required.** There is no default repo: Condotto
only works in repos you name, and it refuses to start with none configured.

A monorepo is **one** `[[repos]]` entry — you pick the sub-project when you assign
(`/condotto assign webapp/apps/report`), not here. See [Monorepos](#monorepos).

For your first session, point an entry at a throwaway clone and watch the gate
work before you aim it at anything you care about:

```sh
git init ~/tmp/condotto-testbed
(cd ~/tmp/condotto-testbed && git commit --allow-empty -m init)
```

```toml
[[repos]]
name = "testbed"
path = "~/tmp/condotto-testbed"
```

> **Retired keys.** `test_cmd`, `land_cmd` and `deploy_cmd` are gone as of
> 2026-07-26. Running the tests, landing and deploying are ordinary commands the
> agent runs itself; a second, daemon-side way to run a command existed only
> because the agent's shell used to need an approval click for everything. An old
> config that still declares them boots fine — the keys are ignored.

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
… [daemon] cost cap $50/thread (default), max 6 concurrent turns, default model opus @ xhigh effort, subagents ON / workflows ON
… [daemon] ready — db=…/condotto.sqlite, sessions on record: 0
```

If you see `WARNING: no architects configured`, gated actions will have no one who
can drive the agent — set `architects` and restart.

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
2. **Tell it what you want.** "What does this repo do?" "Add a `/health` endpoint
   that returns 200." It explores, edits, and runs the tests, and posts what it
   did. Anyone can talk in the thread; an architect's message is what starts a
   turn, and everyone else's is carried into the next one as context.
3. **Or agree the shape first:** `@Condotto plan on`. The thread goes read-only —
   the agent investigates and posts a plan, and changes nothing. Read it, say what
   you'd rather, and when you're happy, `@Condotto plan off` and it implements.
4. **Ship it:** ask for it. Committing, pushing and opening a PR are ordinary
   commands the agent runs through the gate, and `GH_TOKEN` survives the
   environment scrub, so a PR URL comes back in the thread.
5. **Start over without losing the work:** `@Condotto clear` forgets the
   conversation and nothing else. Same worktree, same branch, same uncommitted
   changes, same settings. Reach for it when a long thread has drifted, or when
   the agent is stuck on an idea it won't let go of.
6. **End it:** `@Condotto stop` keeps the worktree for later; `@Condotto stop clean`
   schedules it for teardown.

---

## Command reference

**Slash commands** (channel top level — they can't run inside a thread):

| Command | Who | Does |
|---|---|---|
| `/condotto assign <repo>[/<sub-project>]` | architect | Start a new session in this channel. Omit the repo and Condotto asks which one — there is no default. In a monorepo, add a sub-project to start there. |
| `/condotto status` | architect | Daemon-wide **operator dashboard** (ephemeral): uptime, session counts, turns-in-flight vs. cap, config summary. |
| `/condotto stop` | anyone | Lists this channel's sessions and points you to the in-thread stop. |

**Who can do what.** **Only an architect's message runs the agent.** Everyone
else can talk in the thread, and what they say is kept and carried into the next
architect turn as context — so the conversation reaches the agent whole, it just
doesn't spend a turn on every line of it. Assigning, stopping and every setting
are architect-only too. To let a domain expert drive sessions themselves, an
architect `@Condotto grant`s them architect rights (see
[the trust model](#empowering-domain-experts--grant)).

**In-thread** (mention `@Condotto` inside a session thread):

| Mention | Who | Does |
|---|---|---|
| `@Condotto assign <repo>[/<sub-project>]` | architect | Assign *this* thread as a session. Omit the repo and Condotto asks which one. See [monorepos](#monorepos). |
| `@Condotto status` | anyone | This channel's sessions + their settings. |
| `@Condotto stop [clean]` | architect | End the session; `clean` also discards the worktree. |
| `@Condotto cancel` | architect | Interrupt the running turn (e.g. a runaway workflow); the session lives on. |
| `@Condotto clear` (or `/clear`) | architect | Forget the thread's conversation and start the agent fresh. The worktree, branch, uncommitted work, settings, memory and spend all survive. Refused while a turn is running — `cancel` first. |
| `@Condotto budget <usd>` | architect | Raise this thread's cost ceiling. |
| `@Condotto model <opus\|sonnet\|fable>` | architect | Set the implementer model (`opus` = Opus 5). |
| `@Condotto effort <low…max>` | architect | Set reasoning effort. Changing it mid-thread drops the prompt cache, so prefer setting it early. |
| `@Condotto subagents on\|off` | architect | Parallel exploration fan-out (on by default). Subagents are confined to the worktree exactly as the main agent is. |
| `@Condotto workflows on\|off` | architect | Multi-agent Workflow tool (on by default). |
| `@Condotto plan on\|off` | architect | Research first. I investigate and post a plan, and nothing is written or run — not even the test suite — while it's on. Turn it off when you're happy and I implement. |
| `@Condotto ultra on\|off` | architect | Preset: `xhigh` effort + subagents + workflows — the shipped default, so this is mainly how you get back after dialing down. `off` drops subagents/workflows; set effort separately. |
| `@Condotto /<skill> [args]` | architect | Run one of the harness's skills — including one marked `disable-model-invocation`, which the agent itself cannot invoke. Mention me first: a message that *begins* with `/` is eaten by Slack. |
| `@Condotto skills` | architect | List the skills this thread can run, and which file each one is. |
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

One thing follows from the cwd being the sub-project: **commands run there**, not
at the repo root. The agent runs the sub-project's own test command by default;
ask it for the root suite and it steps up itself.

A session's sub-project is fixed when it's assigned and can't be changed
afterwards (the agent's conversation history is tied to its working directory).
To work somewhere else, start a new thread.

---

## Security & trust model

This is the heart of the product. The daemon is, by construction, a remote-code-
execution portal — it takes text from Slack and runs an agent with a shell and a
repo. Condotto is built for a small, mutually trusting team on a machine they own,
and the model is shaped by that: it does not ask a human to confirm work they just
asked for. Three things hold instead, and none of them ever interrupts you.

**1. Worktree containment.** Every session works inside a fresh, throwaway git
worktree. A `PreToolUse` hook the agent cannot talk its way past resolves every
path a tool call names, and anything outside the worktree is refused — reads
included, because reading the box and posting the answer into Slack is its own
kind of leak.

**2. A hard-deny floor.** Credentials (`ANTHROPIC_API_KEY`,
`CLAUDE_CODE_OAUTH_TOKEN`, `~/.ssh`, `~/.aws`), environment dumps, `rm -rf`
escaping the tree, and symlinking an outside path in. Refused for **everyone**,
always, with no override and no button.

**3. Unforgeable identity.** Only an architect's message runs the agent, checked
**server-side** against the roles table by verified Slack user ID — never a
display name, never text in a message body (this exact impersonation attack was
found in the prototype). Message text reaches the agent inside an unforgeable
random-nonce fence, so content can never pose as an instruction from someone
else. This is the control a trusted team does *not* replace: the attacker it
guards against is a string in a dependency README, not a person in your Slack.

Everything else the agent does — writing, editing, running commands, reaching the
network — just runs, and lands in the audit log.

### Empowering domain experts — grant

The whole product vision is: an architect (expert in the *tech*) empowers domain
experts (expert in the *product*, varied coding depth) to do real engineering in
Slack.

**`@Condotto grant @user architect [everywhere]`** delegates that authority at
runtime — no config edit, no restart. Default scope is *this channel*; add
`everywhere` for all channels. Grants are **persisted** and survive restarts
(while `condotto.toml` stays authoritative for config-defined roles).
`@Condotto revoke @user` takes it back.

Granting is the whole decision. There is no per-action approval to click
afterwards, which is deliberate: a permission you grant once and mean is more
honest than thirty prompts nobody reads. Hand it to people you would hand a
laptop and a git remote to.

### Running your skills

Claude Code skills work in a thread: `@Condotto /ship`, `@Condotto skills` to see
what's there. Mention Condotto first — a Slack message that *begins* with `/` gets
eaten by Slack before it ever reaches the daemon.

This is the only way to reach a skill marked `disable-model-invocation: true`.
That flag deliberately withholds a skill from the model, so the agent can't invoke
it no matter how you ask — and it's the flag teams put on exactly the skills that
matter: `ship`, `ready`, `commit`. Naming one yourself is a different route
entirely, which is why it's architects-only.

A skill runs as an ordinary turn: same model, same budget, same boundary.

Two things Condotto refuses, and it's worth knowing why. **Arguments are limited to
plain text** — letters, digits, and ordinary punctuation. A skill's text is expanded
*before* the agent runs, so `` !`…` `` in an argument would execute ahead of every
check Condotto makes; there's no way to gate it after the fact, so it's refused up
front and you're told which character was the problem. And **Condotto lists only
skills it found itself**, in your repo (if it's marked `trusted`) or in your own
`~/.claude/skills` — never the harness's built-in commands, and never a name two
files both claim. The listing shows you the exact file, because `ship` in your repo
and `ship` in your home directory are different programs.

One behaviour worth knowing about: a skill can gather context by running shell
inline (`` !`git status` `` in its own text). Condotto disables that — it would run
before anything could gate it — so such a skill still works, but without that
context. You'll see a note saying so before it starts.

> **Residual risk, stated plainly (accepted for the trusted-team model):** an
> architect's turn runs shell in the worktree with nobody watching. That is the
> trade the model makes, not an oversight.
>
> **The agent's shell can reach the Claude credential.** This is true in **both**
> auth modes and is worth understanding rather than glossing. The runtime the agent
> runs inside is what authenticates to Anthropic, so the credential rides that
> process's environment — the SDK's documented mechanism. The agent's `Bash` tool
> is a child of that process, so the value is in principle readable. What guards it
> is **not** the credential's absence: it is the hard-deny on any command naming
> `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, with no override of any kind.
> It is pinned by tests. One exception: under subscription auth on a desktop,
> the credential lives in the OS keychain rather than the environment, so there is
> nothing there to read.
>
> This is where the two modes genuinely differ, and it favours the API key: **an
> API key is rotatable and spend-cappable in Console; a personal subscription
> credential is neither.** If a key does leak, you revoke it and the cap bounds the
> damage in the meantime. A leaked personal OAuth credential is your Claude
> account, with no equivalent lever.
>
> The disposable worktree, unforgeable framing, verified-surface gating, and full
> audit trail bound the rest of the blast radius; the hard-deny floor blocks the
> sharpest credential-exfil and host-escape shapes. This is a deliberate trade for
> a team that already trusts each other, not a claim of isolation.

### What Condotto does **not** defend against

Condotto is for a **small, mutually-trusting team** — a startup's PM plus a couple
of engineers, or a squad inside a larger org — where **everyone with Slack-and-
repo access is trusted**. Enforcing *that* boundary (who's in the channel, who can
reach the box) is **the installer's job**, documented here, not engineered
against. Condotto invests heavily in defense against *mistakes*, *prompt injection
from thread content*, and *accidental blast radius* — but it deliberately does
**not** try to isolate against a hostile insider, and it is **not** multi-tenant
SaaS. Scope the daemon's credentials to itself (its own least-privilege deploy key
and cloud role — never a human's personal keychain).

---

## Operations (runbook)

### Running as a service

Sample units live in [`deploy/`](deploy/); each has step-by-step install comments
at the top. Edit the paths/user to match your install before enabling.

- **Linux (systemd):** [`deploy/condotto.service`](deploy/condotto.service). Runs as
  a dedicated `condotto` user, restarts on failure, reads the Claude credential
  (`ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` under subscription auth) from
  an `EnvironmentFile`, and shuts down cleanly on `SIGTERM`.
  ```sh
  sudo cp deploy/condotto.service /etc/systemd/system/
  sudo systemctl daemon-reload && sudo systemctl enable --now condotto
  journalctl -u condotto -f
  ```
- **macOS (launchd):** [`deploy/com.condotto.daemon.plist`](deploy/com.condotto.daemon.plist).
  Under API key auth, put `ANTHROPIC_API_KEY` in the unit's environment. Under
  subscription auth, install it as a **per-user LaunchAgent**
  (`~/Library/LaunchAgents/`) so it runs in your session and can reach keychain
  OAuth — no token needed.
  ```sh
  cp deploy/com.condotto.daemon.plist ~/Library/LaunchAgents/
  launchctl load ~/Library/LaunchAgents/com.condotto.daemon.plist
  ```

### Reading the audit log

Every tool call and every session-lifecycle event is written to the **`audit_log`**
table in the SQLite store. (A read-only Slack audit *channel* is planned but
deferred past this beta; for now you read the log locally.) With no approval step
in the way, this trail is how you reconstruct what the agent actually did — it is
the record, not a supplement to one.

Query it with any SQLite client — `sqlite3` ships with macOS and most Linux:

```sh
# Recent activity (newest first)
sqlite3 -header -column condotto.sqlite \
  "SELECT ts, actor, event, substr(detail,1,70) AS detail
     FROM audit_log
    WHERE event IN ('tool_call','session_assigned','session_stopped')
    ORDER BY id DESC LIMIT 20;"

# Everything the floor refused — the one place a refusal shows up
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

# Full timeline for one session (find its id in the queries above)
sqlite3 -header -column condotto.sqlite \
  "SELECT ts, actor, event FROM audit_log WHERE session_id='<SESSION_ID>' ORDER BY id ASC;"
```

`detail` is JSON, so `json_extract(detail, '$.field')` pulls out fields. Common
events and actors:

| `event` | `actor` | `detail` highlights |
|---|---|---|
| `tool_call` | `agent` | `tool`, `toolUseId`, `decision` (`allow`, `deny`, `deny(plan-mode)`, `deny(memory-unproven)`), plus `agentId`/`escaped` when the call came from a subagent or the backstop path |
| `message_held` | the member's `slack:U…` | a message kept for the next architect turn |
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
workflow).

What `total_cost_usd` means depends on your auth mode:

- **API key** — real spend, billed per token against your Console account. Budgets
  govern actual money. Set a spend cap in Console as the backstop that does not
  depend on Condotto being correct.
- **Subscription** — *notional* API pricing; nothing is billed per token. Treat
  budgets as **usage governance**; the real constraint is your plan's rate limits.

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

- Writes go through the same boundary as any other write, and every one is
  audited. The shape rules are narrow on purpose: a markdown file directly in the
  memory root, through `Write` or `Edit`, and nothing else.
- Memory is **notes, not authority.** The agent is told so explicitly: a memory
  never grants permission and never carries an approval, no matter what it claims.
- The directory is Condotto's, not the repo's. It sits under `[paths].memory_root`,
  never inside a worktree, and it survives `stop clean` — that is the whole point.
- The agent's **shell cannot reach it.** Memory changes only through the file
  tools, so every change is audited, and every target is re-proven against the
  filesystem (no symlinks, no hard links) immediately before the call runs.

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
| Condotto ignores my messages | Only an architect's message runs the agent. Check `architects` / `@Condotto grant`. Your message is kept, not lost — it reaches the agent on the next architect turn. |
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
bun run smoke:create    # a real session + turn; then smoke:resume proves park & resume
bun run smoke:workflows # multi-agent Workflow: it fans out, and the boundary holds
bun run smoke:plan      # plan mode: reads run, writes don't, the plan reaches the thread
bun run smoke:monorepo  # sub-project cwd: project config, cross-package edits, boundary
bun run smoke:reset     # delete the scratch dir; the next run rebuilds it
```

Each run resets the fixture repo to a known state first, so a crashed or
half-finished run never poisons the next one. To point a smoke at one of your own
configured repos instead, set `CONDOTTO_SMOKE_REPO=<name>` — it will say so
loudly, since that runs an agent against a real repo.

---

## Further reading

- **[CLAUDE.md](CLAUDE.md)** — orientation for working in this codebase: the two
  ports, what the security model actually consists of, the invariants, and the
  Agent SDK gotchas worth knowing before you touch the harness adapter.

## License

Copyright (C) 2026 Chad Remesch

Condotto is free software, licensed under the **GNU Affero General Public
License, version 3 or later (AGPL-3.0-or-later)** — see [LICENSE](LICENSE) for
the full text. AGPL's §13 network-use clause means anyone who runs a modified
Condotto as a network service must make that modified source available to its
users. Condotto is distributed in the hope that it will be useful, but WITHOUT
ANY WARRANTY; see the license for details.

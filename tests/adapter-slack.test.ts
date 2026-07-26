import { describe, expect, test } from "bun:test";
import { SlackAdapter, parseMentionCommand, resolveUserMention, slashEphemeralText } from "../src/adapters/slack/adapter";
import type { OperatorConsole, SurfaceAuthority } from "../src/adapters/slack/adapter";
import { DisplayNameCache } from "../src/adapters/slack/users";
import type { InboundEvent, Principal } from "../src/core/types";

// The Slack mention parser is a pure module-level function, so it can be unit
// tested without a live Bolt App. `BOT` stands in for the bot's own user id.
const BOT = "UBOT123";
const parse = (text: string) => parseMentionCommand(`<@${BOT}> ${text}`, BOT);

describe("resolveUserMention", () => {
  test("a linkified mention resolves to a principal key; the id case is preserved", () => {
    expect(resolveUserMention("<@U0ABBY>", BOT)).toBe("slack:U0ABBY");
    expect(resolveUserMention("<@U0ABBY|abby>", BOT)).toBe("slack:U0ABBY"); // label ignored
  });

  test("plain text, malformed tokens, and the bot itself do not resolve", () => {
    expect(resolveUserMention("@abby", BOT)).toBeNull(); // not linkified
    expect(resolveUserMention("abby", BOT)).toBeNull();
    expect(resolveUserMention("<@U0ABBY", BOT)).toBeNull(); // malformed
    expect(resolveUserMention(`<@${BOT}>`, BOT)).toBeNull(); // never target Condotto
  });
});

describe("parseMentionCommand — assign", () => {
  test("bare, repo-only, and both sub-project spellings all parse", () => {
    expect(parse("assign")).toEqual({ name: "assign", args: "" });
    expect(parse("take this")).toEqual({ name: "assign", args: "" });
    expect(parse("assign monorepo")).toEqual({ name: "assign", args: "monorepo" });
    // The slash form is one token; the space form is two. Without the 3-word rule
    // the latter would match nothing and be silently swallowed as conversation,
    // leaving the architect with no error at all.
    expect(parse("assign monorepo/apps/report")).toEqual({ name: "assign", args: "monorepo/apps/report" });
    expect(parse("assign monorepo apps/report")).toEqual({ name: "assign", args: "monorepo apps/report" });
  });

  test("case is preserved — repo names and paths are case-sensitive", () => {
    expect(parse("assign MyRepo/apps/Report")).toEqual({ name: "assign", args: "MyRepo/apps/Report" });
  });

  test("beyond three words it is conversation, not a malformed command", () => {
    expect(parse("assign this ticket to someone")).toBeNull();
  });
});

describe("parseMentionCommand — grant/revoke", () => {
  test("grant resolves the target and lowercases the role, preserving the id case", () => {
    expect(parse("grant <@U0ABBY> architect")).toEqual({ name: "grant", args: "slack:U0ABBY architect" });
    expect(parse("grant <@U0ABBY> Architect")).toEqual({ name: "grant", args: "slack:U0ABBY architect" });
    expect(parse("grant <@U0ABBY|abby> architect everywhere")).toEqual({
      name: "grant",
      args: "slack:U0ABBY architect everywhere",
    });
  });

  test("an unlinkified target becomes the sentinel '?' so the core can error precisely", () => {
    expect(parse("grant @abby architect")).toEqual({ name: "grant", args: "? architect" });
    expect(parse(`grant <@${BOT}> architect`)).toEqual({ name: "grant", args: "? architect" }); // bot rejected
  });

  test("revoke resolves the target, with an optional scope modifier", () => {
    expect(parse("revoke <@U0ABBY>")).toEqual({ name: "revoke", args: "slack:U0ABBY" });
    expect(parse("revoke <@U0ABBY> everywhere")).toEqual({ name: "revoke", args: "slack:U0ABBY everywhere" });
  });

});

describe("slashEphemeralText — /condotto console routing", () => {
  const author: Principal = { surface: "slack", externalId: "U1" };
  const op: OperatorConsole = {
    operatorStatus: (a, ch) => `OPS ${a.externalId}@${ch}`,
    channelStopGuidance: (ch) => `STOPHELP@${ch}`,
  };

  test("status → operator dashboard, stop → channel stop guidance (case-insensitive)", () => {
    expect(slashEphemeralText("status", author, "C1", op)).toBe("OPS U1@C1");
    expect(slashEphemeralText("STATUS", author, "C1", op)).toBe("OPS U1@C1");
    expect(slashEphemeralText("stop", author, "C1", op)).toBe("STOPHELP@C1");
    expect(slashEphemeralText("  Stop ", author, "C2", op)).toBe("STOPHELP@C2");
  });

  test("assign, unknown, and empty subcommands are not ephemeral queries (null → caller handles)", () => {
    expect(slashEphemeralText("assign", author, "C1", op)).toBeNull();
    expect(slashEphemeralText("bogus", author, "C1", op)).toBeNull();
    expect(slashEphemeralText("", author, "C1", op)).toBeNull();
  });
});

describe("parseMentionCommand — existing forms still parse (regression)", () => {
  test("controls are unchanged", () => {
    expect(parse("model opus")).toEqual({ name: "model", args: "opus" });
    expect(parse("subagents on")).toEqual({ name: "subagents", args: "on" });
    expect(parse("stop")).toEqual({ name: "stop", args: "" });
  });

  test("`stop clean` parses to the clean variant; a stray arg stays conversation", () => {
    expect(parse("stop clean")).toEqual({ name: "stop", args: "clean" });
    expect(parse("stop please")).toBeNull(); // not a command → conversation
    expect(parse("stop clean now")).toBeNull(); // over-arity → conversation
  });

  test("`cancel` parses; a stray arg stays conversation", () => {
    expect(parse("cancel")).toEqual({ name: "cancel", args: "" });
    expect(parse("cancel the workflow")).toBeNull(); // over-arity → conversation, not a command
  });

  test("ordinary prose and a missing bot id are not commands", () => {
    expect(parse("take a look at src/x.ts please")).toBeNull();
    expect(parseMentionCommand("grant <@U0ABBY> architect", null)).toBeNull(); // no bot id yet
    expect(parseMentionCommand("hello world", BOT)).toBeNull(); // not a mention of the bot
  });
});

// -- the async name-resolution chain in handleMessage -------------------------
//
// `handleMessage` runs its sync guards, then hops through the display-name cache
// before emitting. These tests drive the private method directly with raw Slack
// event shapes, using the constructor's `names` test seam.
//
// No Slack transport is touched: the adapter passes `deferInitialization` to Bolt,
// so constructing one performs no network call and needs no stubbing.

const TOKENS = { botToken: "xoxb-test", appToken: "xapp-test" };
const AUTHORITY: SurfaceAuthority = { isArchitect: () => true };
const OPERATOR: OperatorConsole = { operatorStatus: () => "", channelStopGuidance: () => "" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A Slack message event that passes every sync guard, overridable per test. */
function messageEvent(over: Record<string, any> = {}): Record<string, any> {
  return { user: "U0ABBY", channel: "C1", ts: "1700000001.000100", thread_ts: "1700000000.000100", text: "hi", ...over };
}

/** An adapter wired for `handleMessage` without a live client: `start()` normally
 *  sets `botUserId` and `emit`, so we set them here. */
function testAdapter(names?: DisplayNameCache) {
  const emitted: InboundEvent[] = [];
  const adapter = new SlackAdapter(TOKENS, AUTHORITY, OPERATOR, () => {}, names);
  (adapter as any).botUserId = BOT;
  (adapter as any).emit = (e: InboundEvent) => emitted.push(e);
  const deliver = (event: Record<string, any>) => (adapter as any).handleMessage(event);
  const tails = () => (adapter as any).nameTail as Map<string, Promise<void>>;
  /** Wait for every in-flight name chain to settle (the chain self-clears). */
  const settle = async (budgetMs = 2000) => {
    const deadline = Date.now() + budgetMs;
    while (tails().size > 0 && Date.now() < deadline) await sleep(5);
    await sleep(5);
  };
  return { adapter, emitted, deliver, tails, settle };
}

describe("SlackAdapter.handleMessage — name resolution", () => {
  test("the resolved display name reaches the emitted event as authorDisplayName", async () => {
    const names = new DisplayNameCache(async () => "Abby");
    const { emitted, deliver, settle } = testAdapter(names);
    deliver(messageEvent());
    await settle();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ kind: "message", text: "hi", authorDisplayName: "Abby" });
  });

  test("two messages in one conversation emit in ARRIVAL order even when the first name is slow", async () => {
    const names = new DisplayNameCache(async (id) => {
      if (id === "USLOW") await sleep(50);
      return id === "USLOW" ? "Slow Sam" : "Quick Quinn";
    });
    const { emitted, deliver, settle } = testAdapter(names);
    deliver(messageEvent({ user: "USLOW", ts: "1700000001.000100", text: "first" }));
    deliver(messageEvent({ user: "UFAST", ts: "1700000002.000100", text: "second" }));
    await settle();
    // Without the per-conversation chain the instant lookup would overtake the
    // slow one and the transcript would read backwards.
    expect(emitted.map((e: any) => e.text)).toEqual(["first", "second"]);
    expect(emitted.map((e: any) => e.authorDisplayName)).toEqual(["Slow Sam", "Quick Quinn"]);
  });

  test("ordering is PER-CONVERSATION — a slow lookup in one thread does not delay another", async () => {
    const names = new DisplayNameCache(async (id) => {
      if (id === "USLOW") await sleep(50);
      return id;
    });
    const { emitted, deliver, settle } = testAdapter(names);
    deliver(messageEvent({ user: "USLOW", thread_ts: "1700000000.000100", ts: "1700000001.000100", text: "thread A" }));
    deliver(messageEvent({ user: "UFAST", thread_ts: "1700000009.000100", ts: "1700000002.000100", text: "thread B" }));
    await settle();
    expect(emitted.map((e: any) => e.text)).toEqual(["thread B", "thread A"]);
  });

  test("the nameTail entry is released once a conversation settles (no per-thread leak)", async () => {
    const names = new DisplayNameCache(async (id) => id);
    const { deliver, tails, settle } = testAdapter(names);
    for (let i = 1; i <= 3; i++) {
      deliver(messageEvent({ ts: `170000000${i}.000100`, thread_ts: "1700000000.000100" }));
    }
    deliver(messageEvent({ ts: "1700000009.000100", thread_ts: "1700000008.000100" }));
    expect(tails().size).toBe(2); // both conversations in flight
    await settle();
    // The cleanup compares the map entry against the tail's OWN promise; comparing
    // against the pre-cleanup promise never matches and leaks an entry per thread.
    expect(tails().size).toBe(0);
  });

  test("a name source that REJECTS still emits the message, nameless", async () => {
    const names = new DisplayNameCache(async () => {
      throw new Error("users.info exploded");
    });
    const { emitted, deliver, settle } = testAdapter(names);
    deliver(messageEvent());
    await settle();
    expect(emitted).toHaveLength(1);
    expect((emitted[0] as any).authorDisplayName).toBeUndefined();
  });

  test("a name lookup that REJECTS outright still emits — the .catch is load-bearing", async () => {
    const { emitted, deliver, settle } = testAdapter({
      get: async () => {
        throw new Error("cache exploded");
      },
    } as unknown as DisplayNameCache);
    deliver(messageEvent());
    await settle();
    expect(emitted).toHaveLength(1);
    expect((emitted[0] as any).authorDisplayName).toBeUndefined();
  });

  test("a name source that HANGS past the timeout still emits, nameless", async () => {
    const names = new DisplayNameCache(() => new Promise<string | null>(() => {}), { timeoutMs: 25 });
    const { emitted, deliver, settle } = testAdapter(names);
    deliver(messageEvent());
    expect(emitted).toHaveLength(0); // still waiting on the lookup
    await settle();
    expect(emitted).toHaveLength(1);
    expect((emitted[0] as any).authorDisplayName).toBeUndefined();
  });

  test("an adapter that never started (no name cache) still emits, nameless", async () => {
    const { adapter, emitted, deliver, settle } = testAdapter();
    expect((adapter as any).names).toBeNull();
    deliver(messageEvent());
    await settle();
    expect(emitted).toHaveLength(1);
    expect((emitted[0] as any).authorDisplayName).toBeUndefined();
  });
});

describe("SlackAdapter.handleMessage — sync guards run ahead of the async hop", () => {
  test("a duplicate ts is dropped even while the first message's name lookup is in flight", async () => {
    const names = new DisplayNameCache(async (id) => {
      await sleep(40);
      return id;
    });
    const { emitted, deliver, settle } = testAdapter(names);
    const event = messageEvent({ ts: "1700000001.000100" });
    deliver(event);
    deliver({ ...event }); // Slack redelivery, arriving before the first resolves
    await settle();
    // Dedup is synchronous and first-seen-wins, so the await cannot defeat it.
    expect(emitted).toHaveLength(1);
  });

  test("bot messages and thread-less chatter return before any name lookup happens", async () => {
    let lookups = 0;
    const names = new DisplayNameCache(async (id) => {
      lookups++;
      return id;
    });
    const { emitted, deliver, tails, settle } = testAdapter(names);
    deliver(messageEvent({ bot_id: "B999", ts: "1700000001.000100" }));
    deliver(messageEvent({ user: BOT, ts: "1700000002.000100" }));
    deliver(messageEvent({ user: undefined, ts: "1700000003.000100" }));
    deliver(messageEvent({ thread_ts: undefined, ts: "1700000004.000100" })); // top-level chatter
    deliver(messageEvent({ subtype: "channel_join", ts: "1700000005.000100" }));
    expect(tails().size).toBe(0); // no chain was ever started
    await settle();
    expect(emitted).toHaveLength(0);
    expect(lookups).toBe(0);
  });

  test("a command mention and a bare/help mention are left to app_mention, unlooked-up", async () => {
    let lookups = 0;
    const names = new DisplayNameCache(async (id) => {
      lookups++;
      return id;
    });
    const { emitted, deliver, tails, settle } = testAdapter(names);
    deliver(messageEvent({ text: `<@${BOT}> stop`, ts: "1700000001.000100" }));
    deliver(messageEvent({ text: `<@${BOT}> help`, ts: "1700000002.000100" }));
    expect(tails().size).toBe(0);
    await settle();
    expect(emitted).toHaveLength(0);
    expect(lookups).toBe(0);
  });
});

describe("parseMentionCommand — clear", () => {
  test("`clear` and `/clear` are the same command, and case doesn't matter", () => {
    // `/clear` is accepted because that is how Claude Code spells it, and it is what
    // an operator's fingers will type.
    expect(parse("clear")).toEqual({ name: "clear", args: "" });
    expect(parse("/clear")).toEqual({ name: "clear", args: "" });
    expect(parse("Clear")).toEqual({ name: "clear", args: "" });
    expect(parse("/CLEAR")).toEqual({ name: "clear", args: "" });
  });

  test("the `/`-prefix skill catch-all no longer swallows `/clear` — but still owns every other built-in", () => {
    // The alias sits ABOVE the catch-all. Everything else slash-prefixed keeps
    // routing to the skill dispatcher, whose allowlist deliberately excludes the
    // runtime's built-ins. That boundary is deliberate: `/clear` earned an alias
    // because the core owns a mechanism for it, and `/compact` and `/rewind` do not.
    expect(parse("/clear")).toEqual({ name: "clear", args: "" });
    expect(parse("/compact")).toEqual({ name: "skill", args: "compact" });
    expect(parse("/rewind")).toEqual({ name: "skill", args: "rewind" });
  });

  test("a stray argument keeps `clear` as conversation, not a command", () => {
    // Strict arity, like every other verb in the ladder — otherwise an ordinary
    // instruction would silently wipe the thread's context.
    expect(parse("clear the cache in foo.ts")).toBeNull();
    expect(parse("clear all")).toBeNull();
    expect(parse("/clear everything")).toEqual({ name: "skill", args: "clear everything" });
  });

  test("a mention that does not LEAD the message mints no command", () => {
    // Authority attaches to a verified leading mention only. Repo content, tool
    // output and agent replies never traverse InboundEvent at all, but this pins the
    // position rule that makes quoting the command inside a sentence inert.
    expect(parseMentionCommand(`please ask <@${BOT}> clear when you're done`, BOT)).toBeNull();
    expect(parseMentionCommand(`> <@${BOT}> clear`, BOT)).toBeNull();
  });
});

describe("parseMentionCommand — plan", () => {
  test("`plan on` / `plan off` parse, case-insensitively", () => {
    expect(parse("plan on")).toEqual({ name: "plan", args: "on" });
    expect(parse("plan off")).toEqual({ name: "plan", args: "off" });
    expect(parse("Plan ON")).toEqual({ name: "plan", args: "ON" });
  });

  test("`plan` used as an ordinary English verb stays conversation", () => {
    // The reason this verb needs stricter care than the others: "plan" leads a
    // perfectly normal sentence, and mis-parsing one would silently put the thread
    // into a mode where nothing it is asked to do will run.
    expect(parse("plan the migration with me")).toBeNull();
    expect(parse("plan out how you'd do this")).toBeNull();
    expect(parse("plan")).toBeNull();
    expect(parse("plan on off")).toBeNull();
  });

  test("`/plan` still belongs to the skill catch-all — no alias", () => {
    // Unlike `/clear`, the core owns no runtime `/plan`, so there is nothing to
    // alias to. Pinned so "let's alias them all" meets a red test.
    expect(parse("/plan")).toEqual({ name: "skill", args: "plan" });
  });

  test("a mention that does not LEAD the message mints no plan command", () => {
    expect(parseMentionCommand(`should we ask <@${BOT}> plan on first?`, BOT)).toBeNull();
  });
});

describe("parseMentionCommand — skills", () => {
  // The mention-first spelling is not cosmetic. Slack intercepts a message that
  // BEGINS with `/` as one of its own commands, and custom slash commands cannot
  // run inside a thread at all — so the `/` has to sit
  // behind the mention, where it is ordinary text.
  test("`/name` becomes a skill command with the slash stripped", () => {
    expect(parse("/ship")).toEqual({ name: "skill", args: "ship" });
    expect(parse("/code-review")).toEqual({ name: "skill", args: "code-review" });
    // Plugin-qualified names carry a colon.
    expect(parse("/frontend:design")).toEqual({ name: "skill", args: "frontend:design" });
  });

  test("arguments keep their case and internal spacing", () => {
    // A commit message and a path are both case-sensitive; lowercasing the whole
    // line (as the control verbs do) would corrupt them.
    expect(parse("/ship Fix the Widget sync")).toEqual({ name: "skill", args: "ship Fix the Widget sync" });
    expect(parse("/review apps/Report/Main.tsx")).toEqual({ name: "skill", args: "review apps/Report/Main.tsx" });
  });

  test("`skills` lists; a stray arg stays conversation", () => {
    expect(parse("skills")).toEqual({ name: "skills", args: "" });
    expect(parse("skills please")).toBeNull();
  });

  test("a bare slash is not a command", () => {
    expect(parse("/")).toBeNull();
    expect(parse("/ ship")).toBeNull(); // the slash must lead the first WORD
  });

  test("a slash inside prose is still conversation, not a skill", () => {
    // The rule keys on the first word only, so paths and URLs mentioned in passing
    // never trigger a dispatch.
    expect(parse("take a look at /etc/hosts")).toBeNull();
    expect(parse("what does src/core/policy.ts do?")).toBeNull();
    // And an existing verb is not shadowed by a slash-shaped argument.
    expect(parse("stop")).toEqual({ name: "stop", args: "" });
  });
});

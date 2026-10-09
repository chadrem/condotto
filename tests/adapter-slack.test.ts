import { describe, expect, test } from "bun:test";
import { join } from "node:path";
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

describe("parseMentionCommand — thread members", () => {
  test("member @user adds; several at once; the friendly spellings all work", () => {
    expect(parse("member <@U0DAVE>")).toEqual({ name: "members", args: "add slack:U0DAVE" });
    expect(parse("member <@U0DAVE|dave> <@U0ABBY>")).toEqual({ name: "members", args: "add slack:U0DAVE slack:U0ABBY" });
    expect(parse("add <@U0DAVE>")).toEqual({ name: "members", args: "add slack:U0DAVE" });
    expect(parse("member add <@U0DAVE>")).toEqual({ name: "members", args: "add slack:U0DAVE" });
    expect(parse("Member <@U0DAVE>")).toEqual({ name: "members", args: "add slack:U0DAVE" });
  });

  test("remove and list", () => {
    expect(parse("remove <@U0DAVE>")).toEqual({ name: "members", args: "remove slack:U0DAVE" });
    expect(parse("member remove <@U0DAVE>")).toEqual({ name: "members", args: "remove slack:U0DAVE" });
    expect(parse("members")).toEqual({ name: "members", args: "list" });
    expect(parse("member")).toEqual({ name: "members", args: "list" });
  });

  test("a plain-text name is a command with an unresolved target, never conversation", () => {
    // so the architect gets a usage reply instead of the agent getting the line
    expect(parse("member @dave")).toEqual({ name: "members", args: "add ?" });
    expect(parse(`member <@${BOT}>`)).toEqual({ name: "members", args: "add ?" });
  });

  test("member list, and a verb with no target, are commands", () => {
    expect(parse("member list")).toEqual({ name: "members", args: "list" });
    expect(parse("members list")).toEqual({ name: "members", args: "list" });
    expect(parse("member remove")).toEqual({ name: "members", args: "remove" });
  });

  test("prose that opens with member/members stays conversation", () => {
    expect(parse("members of QA reported the export is broken")).toBeNull();
    expect(parse("member signups dropped last week")).toBeNull();
    expect(parse("member <@U0DAVE> keeps hitting this bug")).toBeNull();
  });

  test("add/remove in prose stay conversation", () => {
    expect(parse("add a test for the parser")).toBeNull();
    expect(parse("remove the dead code")).toBeNull();
    expect(parse("add <@U0DAVE> as a reviewer")).toBeNull();
    expect(parse("add <@U0DAVE>'s fix")).toBeNull();
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

describe("SlackAdapter.handleMention — threads only", () => {
  // Condotto only works in threads. A top-level mention, command or not, gets a
  // private note and never reaches the core.
  function wired(
    postEphemeral?: (args: Record<string, any>) => Promise<unknown>,
    authority: SurfaceAuthority = AUTHORITY,
  ) {
    const logs: string[] = [];
    const emitted: InboundEvent[] = [];
    const ephemerals: Record<string, any>[] = [];
    const posts: Record<string, any>[] = [];
    const adapter = new SlackAdapter(TOKENS, authority, OPERATOR, (m) => logs.push(m), undefined, {
      repoNames: ["webapp", "api"],
    });
    (adapter as any).botUserId = BOT;
    (adapter as any).emit = (e: InboundEvent) => emitted.push(e);
    (adapter as any).app = {
      client: {
        chat: {
          postEphemeral:
            postEphemeral ??
            (async (args: Record<string, any>) => {
              ephemerals.push(args);
              return {};
            }),
          postMessage: async (args: Record<string, any>) => {
            posts.push(args);
            return { ts: "1700000009.000100" };
          },
        },
      },
    };
    const mention = (over: Record<string, any>) =>
      (adapter as any).handleMention({ user: "U0ABBY", channel: "C1", ts: "1700000001.000100", ...over });
    const slash = async (text: string) => {
      const replies: Record<string, any>[] = [];
      await (adapter as any).handleSlashCommand({ text, user_id: "U0ABBY", channel_id: "C1" }, async (r: any) => {
        replies.push(r);
      });
      return replies;
    };
    return { emitted, ephemerals, logs, posts, mention, slash };
  }
  const NOT_ARCHITECT: SurfaceAuthority = { isArchitect: () => false };

  test("a top-level command mention emits nothing and tells only the sender", async () => {
    const { emitted, ephemerals, mention } = wired();
    await mention({ text: `<@${BOT}> assign webapp` });
    expect(emitted).toHaveLength(0);
    expect(ephemerals).toHaveLength(1);
    expect(ephemerals[0]).toMatchObject({ channel: "C1", user: "U0ABBY" });
    expect(ephemerals[0]!.thread_ts).toBeUndefined();
    expect(ephemerals[0]!.text).toContain("only work in threads");
    expect(ephemerals[0]!.text).toContain("/condotto assign");
    expect(ephemerals[0]!.text).toContain("`webapp`, `api`");
  });

  test("a non-architect's note does not point at /condotto assign, which would refuse them", async () => {
    const { ephemerals, mention } = wired(undefined, NOT_ARCHITECT);
    await mention({ text: `<@${BOT}> assign webapp` });
    expect(ephemerals).toHaveLength(1);
    expect(ephemerals[0]!.text).toContain("only work in threads");
    expect(ephemerals[0]!.text).not.toContain("/condotto assign");
    expect(ephemerals[0]!.text).not.toContain("webapp");
  });

  test("top-level bare and conversational mentions get the same note instead of help", async () => {
    const { emitted, ephemerals, mention } = wired();
    await mention({ text: `<@${BOT}>` });
    await mention({ text: `<@${BOT}> what does this repo do?`, ts: "1700000002.000100" });
    expect(emitted).toHaveLength(0);
    expect(ephemerals).toHaveLength(2);
  });

  test("inside a thread, commands and help still reach the core", async () => {
    const { emitted, ephemerals, mention } = wired();
    await mention({ text: `<@${BOT}> assign webapp`, thread_ts: "1700000000.000100" });
    await mention({ text: `<@${BOT}> help`, thread_ts: "1700000000.000100", ts: "1700000002.000100" });
    expect(ephemerals).toHaveLength(0);
    expect(emitted).toEqual([
      expect.objectContaining({ kind: "command", name: "assign", args: "webapp" }),
      expect.objectContaining({ kind: "command", name: "help" }),
    ]);
    for (const e of emitted) expect((e as any).conv.conversationId).toBe("C1:1700000000.000100");
  });

  test("a failed note is logged, not thrown", async () => {
    const { emitted, logs, mention } = wired(async () => {
      throw new Error("not_in_channel");
    });
    await mention({ text: `<@${BOT}> assign webapp` });
    expect(emitted).toHaveLength(0);
    expect(logs.some((l) => l.includes("not_in_channel"))).toBe(true);
  });

  test("/condotto assign from a non-architect posts no public anchor", async () => {
    const { emitted, posts, slash } = wired(undefined, NOT_ARCHITECT);
    const replies = await slash("assign webapp");
    expect(posts).toHaveLength(0);
    expect(emitted).toHaveLength(0);
    expect(replies).toEqual([{ response_type: "ephemeral", text: "Only architects can assign sessions." }]);
  });

  test("/condotto assign with no repo lists the configured repos", async () => {
    const { posts, slash } = wired();
    const replies = await slash("assign");
    expect(posts).toHaveLength(0);
    expect(replies[0]!.text).toContain("`webapp`, `api`");
  });

  test("/condotto assign from an architect still posts the anchor and emits assign", async () => {
    const { emitted, posts, slash } = wired();
    await slash("assign webapp");
    expect(posts).toHaveLength(1);
    expect(emitted).toEqual([expect.objectContaining({ kind: "command", name: "assign", args: "webapp" })]);
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

describe("parseMentionCommand — remote-control", () => {
  test("both spellings parse, case-insensitively", () => {
    expect(parse("remote-control on")).toEqual({ name: "remote_control", args: "on" });
    expect(parse("remote-control off")).toEqual({ name: "remote_control", args: "off" });
    // The short spelling exists because it is what fingers type.
    expect(parse("remote on")).toEqual({ name: "remote_control", args: "on" });
    expect(parse("Remote-Control OFF")).toEqual({ name: "remote_control", args: "OFF" });
  });

  test("the hyphen survives tokenizing, which is why the command is not two words", () => {
    // `split(/\s+/)` keeps `remote-control` as ONE token. A `remote control on`
    // spelling would need arity-3 handling for no gain; pinned so nobody re-spells it.
    expect(parse("remote-control on")).not.toBeNull();
    expect(parse("remote control on")).toBeNull();
  });

  test("wrong arity and prose fall through to conversation", () => {
    expect(parse("remote-control")).toBeNull();
    expect(parse("remote")).toBeNull();
    expect(parse("remote-control on off")).toBeNull();
    // "remote" leads ordinary sentences, so strict arity earns its keep here too.
    expect(parse("remote work is fine by me")).toBeNull();
    expect(parse("remote debugging this would help")).toBeNull();
  });

  test("a mention that does not LEAD the message mints no command", () => {
    expect(parseMentionCommand(`can <@${BOT}> remote-control on?`, BOT)).toBeNull();
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

describe("SlackAdapter — no unfurls", () => {
  // An unfurl makes Slack's servers fetch an agent-chosen URL: exfiltration to any
  // host with no network access needed on our side. Every message we post or edit
  // must turn both kinds off.
  function wired() {
    const calls: { method: string; args: Record<string, any> }[] = [];
    const record = (method: string) => async (args: Record<string, any>) => {
      calls.push({ method, args });
      return { ts: "1700000009.000100" };
    };
    const { adapter } = testAdapter();
    (adapter as any).app = {
      client: { chat: { postMessage: record("chat.postMessage"), update: record("chat.update") } },
    };
    return { adapter, calls, record };
  }
  const conv = { surfaceId: "slack", channelId: "C1", conversationId: "C1:1700000000.000100" };

  test("post, update and requestChoice all set unfurl_links and unfurl_media to false", async () => {
    const { adapter, calls } = wired();
    const ref = await adapter.post(conv, { text: "see https://evil.example/?d=secret" });
    await adapter.update(ref, { text: "edited https://evil.example/?d=secret" });
    await adapter.requestChoice(conv, { choiceId: "assign_repo", text: "Which repo?", options: [{ label: "a", value: "a" }] });
    expect(calls.map((c) => c.method)).toEqual(["chat.postMessage", "chat.update", "chat.postMessage"]);
    for (const c of calls) expect(c.args).toMatchObject({ unfurl_links: false, unfurl_media: false });
  });

  test("resolving a choice message (chat.update from the action handler) sets them too", async () => {
    const { adapter, calls, record } = wired();
    await (adapter as any).handleChoiceAction({
      body: {
        user: { id: "U0ABBY" },
        channel: { id: "C1" },
        message: { ts: "1700000001.000100", thread_ts: "1700000000.000100", blocks: [] },
        actions: [{ value: "a", block_id: "condotto_choice:assign_repo:0", text: { text: "a" } }],
      },
      client: { chat: { update: record("chat.update") } },
      respond: async () => {},
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toMatchObject({ unfurl_links: false, unfurl_media: false });
  });

  test("a reply with a table posts a table block, and a refused block falls back to text", async () => {
    const { adapter, calls } = wired();
    const md = "| a | b |\n|---|---|\n| 1 | 2 |";
    await adapter.post(conv, { text: md });
    expect(calls[0]!.args.blocks.map((b: any) => b.type)).toEqual(["table"]);
    expect(calls[0]!.args).toMatchObject({ unfurl_links: false, unfurl_media: false });

    calls.length = 0;
    (adapter as any).app.client.chat.update = async (args: Record<string, any>) => {
      calls.push({ method: "chat.update", args });
      if (args.blocks) throw Object.assign(new Error("msg_blocks_too_long"), { data: { ok: false, error: "msg_blocks_too_long" } });
      return { ok: true };
    };
    await adapter.update({ conv, messageId: "1700000009.000100" }, { text: md });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args.blocks).toBeUndefined();
    expect(calls[1]!.args.text).toContain("```");
    expect(calls[1]!.args).toMatchObject({ unfurl_links: false, unfurl_media: false });
  });

  test("only a block error falls back to text; any other failure is not retried", async () => {
    const { adapter, calls } = wired();
    (adapter as any).app.client.chat.postMessage = async (args: Record<string, any>) => {
      calls.push({ method: "chat.postMessage", args });
      throw Object.assign(new Error("request timed out"), { data: { ok: false, error: "timeout" } });
    };
    await expect(adapter.post(conv, { text: "| a |\n|---|\n| 1 |" })).rejects.toThrow("request timed out");
    expect(calls).toHaveLength(1);
  });

  test("every chat.postMessage / chat.update call site in the adapter spreads NO_UNFURL", async () => {
    // The anchor message posted by `/condotto assign` lives inside a Bolt handler
    // that needs a live app to reach, so pin the source instead: one NO_UNFURL per
    // call site, so a new call without it fails here.
    const src = await Bun.file(join(import.meta.dir, "..", "src", "adapters", "slack", "adapter.ts")).text();
    const sites = (src.match(/chat\s*\.(?:postMessage|update)\(/g) ?? []).length;
    const pinned = (src.match(/\.\.\.NO_UNFURL/g) ?? []).length;
    expect(sites).toBe(5);
    expect(pinned).toBe(sites);
  });
});

describe("SlackAdapter — working indicator", () => {
  const conv = { surfaceId: "slack", channelId: "C1", conversationId: "C1:1700000000.000100" };
  const slackError = (code: string) => Object.assign(new Error(code), { data: { ok: false, error: code } });

  /** An adapter whose client records calls; `fail` decides which methods throw what. */
  function wired(fail: { status?: string; reactions?: string } = {}) {
    const calls: { method: string; args: Record<string, any> }[] = [];
    const logs: string[] = [];
    const adapter = new SlackAdapter(TOKENS, AUTHORITY, OPERATOR, (m) => logs.push(m));
    (adapter as any).app = {
      client: {
        apiCall: async (method: string, args: Record<string, any>) => {
          calls.push({ method, args });
          if (fail.status) throw slackError(fail.status);
          return { ok: true };
        },
        reactions: {
          add: async (args: Record<string, any>) => {
            calls.push({ method: "reactions.add", args });
            if (fail.reactions) throw slackError(fail.reactions);
            return { ok: true };
          },
          remove: async (args: Record<string, any>) => {
            calls.push({ method: "reactions.remove", args });
            return { ok: true };
          },
        },
      },
    };
    return { adapter, calls, logs };
  }

  test("uses Slack's native thread status with rotating loading messages, and clears it when done", async () => {
    const { adapter, calls } = wired();
    const working = await adapter.showWorking(conv, { replyTo: "1700000001.000100" });
    expect(working).not.toBeNull();
    expect(working!.animated).toBe(true);
    expect(calls[0]).toMatchObject({
      method: "assistant.threads.setStatus",
      args: { channel_id: "C1", thread_ts: "1700000000.000100" },
    });
    expect(calls[0]!.args.loading_messages.length).toBeGreaterThan(1);
    await working!.done("ok");
    expect(calls.at(-1)).toMatchObject({ method: "assistant.threads.setStatus", args: { status: "" } });
    expect(calls.some((c) => c.method.startsWith("reactions."))).toBe(false); // native worked: no reaction
  });

  test("where Slack refuses the native status, it falls back to 👀 then ✅, and gives up on the channel after a second refusal", async () => {
    const { adapter, calls, logs } = wired({ status: "channel_type_not_supported" });
    const working = await adapter.showWorking(conv, { replyTo: "1700000001.000100" });
    expect(calls.map((c) => c.method)).toEqual(["assistant.threads.setStatus", "reactions.add"]);
    expect(calls[1]!.args).toMatchObject({ timestamp: "1700000001.000100", name: "eyes" });
    expect(working!.animated).toBe(false); // a reaction isn't an animation: the glyph stays
    await working!.done("ok");
    expect(calls.slice(2).map((c) => `${c.method}:${c.args.name}`)).toEqual(["reactions.remove:eyes", "reactions.add:white_check_mark"]);
    expect(logs.filter((l) => l.includes("native")).length).toBe(0); // one refusal could be about one thread

    // A second refusal in the channel gives up on it, logged once...
    calls.length = 0;
    await adapter.showWorking(conv, { replyTo: "1700000002.000100" });
    expect(calls.map((c) => c.method)).toEqual(["assistant.threads.setStatus", "reactions.add"]);
    expect(logs.filter((l) => l.includes("native")).length).toBe(1);
    // ...and later turns there go straight to the reaction.
    calls.length = 0;
    await adapter.showWorking(conv, { replyTo: "1700000003.000100" });
    expect(calls.map((c) => c.method)).toEqual(["reactions.add"]);
  });

  test("a refusal about the app itself turns the native status off in every channel, logged once", async () => {
    const { adapter, calls, logs } = wired({ status: "missing_scope" });
    await adapter.showWorking(conv, { replyTo: "1700000001.000100" });
    calls.length = 0;
    const other = { surfaceId: "slack", channelId: "C2", conversationId: "C2:1700000000.000200" };
    await adapter.showWorking(other, { replyTo: "1700000004.000100" });
    expect(calls.map((c) => c.method)).toEqual(["reactions.add"]);
    expect(logs.filter((l) => l.includes("native")).length).toBe(1);
  });

  test("a failed turn just removes the 👀, with no ✅", async () => {
    const { adapter, calls } = wired({ status: "not_allowed" });
    const working = await adapter.showWorking(conv, { replyTo: "1700000001.000100" });
    calls.length = 0;
    await working!.done("failed");
    expect(calls.map((c) => `${c.method}:${c.args.name}`)).toEqual(["reactions.remove:eyes"]);
  });

  test("a transient error is not taken as 'unsupported'", async () => {
    const { adapter, calls } = wired({ status: "ratelimited" });
    await adapter.showWorking(conv, { replyTo: "1700000001.000100" });
    calls.length = 0;
    await adapter.showWorking(conv, { replyTo: "1700000002.000100" });
    expect(calls[0]!.method).toBe("assistant.threads.setStatus"); // asked again
  });

  test("with neither the native status nor reactions:write, there is no indicator, and it stops trying", async () => {
    const { adapter, calls, logs } = wired({ status: "missing_scope", reactions: "missing_scope" });
    expect(await adapter.showWorking(conv, { replyTo: "1700000001.000100" })).toBeNull();
    expect(logs.some((l) => l.includes("reactions:write"))).toBe(true);
    calls.length = 0;
    expect(await adapter.showWorking(conv, { replyTo: "1700000002.000100" })).toBeNull();
    expect(calls).toEqual([]);
  });

  test("the status glyph is the configured emoji, else ⏳", () => {
    expect(new SlackAdapter(TOKENS, AUTHORITY, OPERATOR, () => {}).workingGlyph).toBe("⏳");
    expect(
      new SlackAdapter(TOKENS, AUTHORITY, OPERATOR, () => {}, undefined, { workingEmoji: "condotto-thinking" }).workingGlyph,
    ).toBe(":condotto-thinking:");
  });

  test("an inbound message carries its ts as messageId, for the reaction to point at", async () => {
    const { emitted, deliver, settle } = testAdapter();
    deliver(messageEvent({ ts: "1700000005.000500" }));
    await settle();
    expect((emitted[0] as any).messageId).toBe("1700000005.000500");
  });
});

import { describe, expect, test } from "bun:test";
import { parseMentionCommand, resolveUserMention } from "../src/adapters/slack/adapter";

// The Slack mention parser is a pure module-level function, so it can be unit
// tested without a live Bolt App. `BOT` stands in for the bot's own user id.
const BOT = "UBOT123";
const parse = (text: string) => parseMentionCommand(`<@${BOT}> ${text}`, BOT);

describe("resolveUserMention (M3.8)", () => {
  test("a linkified mention resolves to a principal key; the id case is preserved", () => {
    expect(resolveUserMention("<@U0ABBY>", BOT)).toBe("slack:U0ABBY");
    expect(resolveUserMention("<@U0ABBY|abby>", BOT)).toBe("slack:U0ABBY"); // label ignored
  });

  test("plain text, malformed tokens, and the bot itself do not resolve", () => {
    expect(resolveUserMention("@abby", BOT)).toBeNull(); // not linkified
    expect(resolveUserMention("abby", BOT)).toBeNull();
    expect(resolveUserMention("<@U0ABBY", BOT)).toBeNull(); // malformed
    expect(resolveUserMention(`<@${BOT}>`, BOT)).toBeNull(); // never target Conduit
  });
});

describe("parseMentionCommand — grant/revoke/auto-approve (M3.8)", () => {
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

  test("auto-approve on|off parses; a bare auto-approve is not a command", () => {
    expect(parse("auto-approve on")).toEqual({ name: "auto-approve", args: "on" });
    expect(parse("auto-approve off")).toEqual({ name: "auto-approve", args: "off" });
    expect(parse("auto-approve")).toBeNull(); // falls through to conversation/help
  });
});

describe("parseMentionCommand — existing forms still parse (regression)", () => {
  test("M3.5/M3.6 controls are unchanged", () => {
    expect(parse("model opus")).toEqual({ name: "model", args: "opus" });
    expect(parse("subagents on")).toEqual({ name: "subagents", args: "on" });
    expect(parse("workflows write on")).toEqual({ name: "workflows", args: "write on" });
    expect(parse("stop")).toEqual({ name: "stop", args: "" });
  });

  test("ordinary prose and a missing bot id are not commands", () => {
    expect(parse("take a look at src/x.ts please")).toBeNull();
    expect(parseMentionCommand("grant <@U0ABBY> architect", null)).toBeNull(); // no bot id yet
    expect(parseMentionCommand("hello world", BOT)).toBeNull(); // not a mention of the bot
  });
});

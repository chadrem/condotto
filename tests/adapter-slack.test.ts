import { describe, expect, test } from "bun:test";
import { parseMentionCommand, resolveUserMention, slashEphemeralText } from "../src/adapters/slack/adapter";
import type { OperatorConsole } from "../src/adapters/slack/adapter";
import type { Principal } from "../src/core/types";

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

describe("parseMentionCommand — grant/revoke/auto-approve", () => {
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
    expect(parse("workflows write on")).toEqual({ name: "workflows", args: "write on" });
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

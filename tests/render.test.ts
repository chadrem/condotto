import { describe, expect, test } from "bun:test";
import {
  CHOICE_ACTION,
  choiceBlocks,
  parseChoiceBlockId,
  renderMrkdwn,
  resolveChoiceMessage,
} from "../src/adapters/slack/render";
import { frameMessage } from "../src/core/framing";

describe("renderMrkdwn", () => {
  test("converts markdown bold, headers, links", () => {
    expect(renderMrkdwn("**hi**")).toBe("*hi*");
    expect(renderMrkdwn("# Title")).toBe("*Title*");
    expect(renderMrkdwn("[docs](https://example.com/a)")).toBe("<https://example.com/a|docs>");
  });

  test("escapes angle brackets and ampersands before adding markup", () => {
    expect(renderMrkdwn("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });

  test("code spans and fences are never rewritten", () => {
    expect(renderMrkdwn("use `**not bold**` here")).toBe("use `**not bold**` here");
    expect(renderMrkdwn("```\n# not a header\n**raw**\n```")).toBe(
      "```\n# not a header\n**raw**\n```",
    );
  });

  test("fence language tags are stripped (Slack renders them literally)", () => {
    expect(renderMrkdwn("```ts\nconst x = 1;\n```")).toBe("```\nconst x = 1;\n```");
  });

  test("escapes angle brackets inside code", () => {
    expect(renderMrkdwn("`a < b`")).toBe("`a &lt; b`");
  });

  test("truncates very long messages", () => {
    const out = renderMrkdwn("x".repeat(50_000));
    expect(out.length).toBeLessThan(13_000);
    expect(out).toContain("(truncated)");
  });
});


describe("choiceBlocks (guided choice)", () => {
  test("renders one button per option carrying its value; block_id round-trips", () => {
    const { blocks, text } = choiceBlocks({
      choiceId: "assign_repo",
      text: "Which repo?",
      options: [
        { label: "testrepo", value: "testrepo" },
        { label: "webapp", value: "webapp" },
      ],
      architectOnly: true,
    });
    expect(text).toBe("Which repo?");
    const actions = (blocks as any[]).find((b) => b.type === "actions");
    expect(actions.elements.map((e: any) => e.value)).toEqual(["testrepo", "webapp"]);
    expect(actions.elements[0].action_id).toBe(`${CHOICE_ACTION}:testrepo`);
    expect(parseChoiceBlockId(actions.block_id)).toEqual({ choiceId: "assign_repo", architectOnly: true });
  });

  test("caps at 5 buttons (Slack limit)", () => {
    const options = Array.from({ length: 8 }, (_, i) => ({ label: `r${i}`, value: `r${i}` }));
    const { blocks } = choiceBlocks({ choiceId: "assign_repo", text: "pick", options });
    const actions = (blocks as any[]).find((b) => b.type === "actions");
    expect(actions.elements.length).toBe(5);
    expect(parseChoiceBlockId(actions.block_id)).toEqual({ choiceId: "assign_repo", architectOnly: false });
  });

  test("parseChoiceBlockId rejects foreign block ids", () => {
    expect(parseChoiceBlockId("condotto_approval:req-1")).toBeNull();
    expect(parseChoiceBlockId(undefined)).toBeNull();
  });

  test("resolveChoiceMessage drops the buttons and records the chooser", () => {
    const { blocks } = choiceBlocks({ choiceId: "assign_repo", text: "pick", options: [{ label: "testrepo", value: "testrepo" }] });
    const resolved = resolveChoiceMessage(blocks, "testrepo", "U_ARCH");
    expect((resolved.blocks as any[]).some((b) => b.type === "actions")).toBe(false);
    expect(JSON.stringify(resolved.blocks)).toContain("testrepo");
    expect(JSON.stringify(resolved.blocks)).toContain("U_ARCH");
  });
});

describe("mention tokens", () => {
  test("a token becomes real Slack mention markup", () => {
    expect(renderMrkdwn("hi @[[slack:U0ABBY]]")).toBe("hi <@U0ABBY>");
  });

  test("several distinct tokens in one message all resolve", () => {
    expect(renderMrkdwn("@[[slack:U0ABBY]] and @[[slack:U0BBOB]] and @[[slack:U0CCAL]]")).toBe(
      "<@U0ABBY> and <@U0BBOB> and <@U0CCAL>",
    );
  });

  test("punctuation butted against a token does not swallow it", () => {
    expect(renderMrkdwn("@[[slack:U0ABBY]], @[[slack:U0BBOB]]. @[[slack:U0CCAL]]'s turn")).toBe(
      "<@U0ABBY>, <@U0BBOB>. <@U0CCAL>'s turn",
    );
  });

  test("a token at the very start and the very end resolves", () => {
    expect(renderMrkdwn("@[[slack:U0ABBY]] ping @[[slack:U0BBOB]]")).toBe("<@U0ABBY> ping <@U0BBOB>");
  });

  test("an Enterprise Grid W-prefixed id resolves", () => {
    expect(renderMrkdwn("@[[slack:W012ABC]]")).toBe("<@W012ABC>");
  });

  test("a lowercase id degrades to the bare key (ids are uppercase)", () => {
    const out = renderMrkdwn("@[[slack:u0abby]]");
    expect(out).toBe("slack:u0abby");
    expect(out).not.toContain("<@");
  });

  test("a foreign-surface key degrades to the bare key, never to markup", () => {
    const out = renderMrkdwn("ask @[[fake:U1]] about it");
    expect(out).toBe("ask fake:U1 about it");
    expect(out).not.toContain("<@");
  });

  test("a token inside a code span stays literal — quoting a token pings nobody", () => {
    const out = renderMrkdwn("the token is `@[[slack:U0ABBY]]` verbatim");
    expect(out).toBe("the token is `@[[slack:U0ABBY]]` verbatim");
    expect(out).not.toContain("<@");
  });

  test("a token inside a fence stays literal", () => {
    const out = renderMrkdwn("```\nnotify @[[slack:U0ABBY]]\n```");
    expect(out).toBe("```\nnotify @[[slack:U0ABBY]]\n```");
    expect(out).not.toContain("<@");
  });

  test("a raw <@U…> written by the model stays escaped — the token is the only path", () => {
    expect(renderMrkdwn("ping <@U0BOSS> now")).toBe("ping &lt;@U0BOSS&gt; now");
  });

  test("substitution runs after escaping, and escaping is not re-run over it (A4)", () => {
    // One assertion of the whole ordering contract: a live mention AND still-inert
    // markup in the same output. A re-escape kills the first; a mis-ordered
    // substitution (before escapeSlack) kills the second.
    const out = renderMrkdwn("<script>x</script> cc @[[slack:U0ABBY]]");
    expect(out).toBe("&lt;script&gt;x&lt;/script&gt; cc <@U0ABBY>");
  });

  test("the cap bounds DISTINCT users: the 9th onward degrades to a bare key", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `U0USER${String(i).padStart(2, "0")}`);
    const out = renderMrkdwn(ids.map((id) => `@[[slack:${id}]]`).join(" "));
    expect((out.match(/<@/g) ?? []).length).toBe(8);
    for (const id of ids.slice(0, 8)) expect(out).toContain(`<@${id}>`);
    for (const id of ids.slice(8)) {
      expect(out).toContain(`slack:${id}`);
      expect(out).not.toContain(`<@${id}>`);
    }
  });

  test("the cap counts users, not occurrences: one user repeated 30x all resolve", () => {
    const out = renderMrkdwn(Array.from({ length: 30 }, () => "@[[slack:U0ABBY]]").join(" "));
    expect((out.match(/<@U0ABBY>/g) ?? []).length).toBe(30);
  });

  test("no broadcast can be minted — output never carries <!", () => {
    const out = renderMrkdwn("@[[slack:U0ABBY]] @channel <!channel> <!here> @[[slack:!channel]]");
    expect(out).not.toContain("<!");
    expect(out).toContain("<@U0ABBY>");
  });

  test("truncation across a mention never leaves a dangling <", () => {
    // Land the 12_000-char cut inside the `<@U0ABBY>` this token expands to.
    const out = renderMrkdwn("x".repeat(11_998) + "@[[slack:U0ABBY]]");
    const marker = "\n… _(truncated)_";
    expect(out.endsWith(marker)).toBe(true);
    const body = out.slice(0, -marker.length);
    expect(body.endsWith("<")).toBe(false);
    expect(/<[^>]*$/.test(body)).toBe(false);
  });


  test("the choice notification fallback linkifies tokens", () => {
    const { text } = choiceBlocks({
      choiceId: "assign_repo",
      text: "@[[slack:U0ABBY]] which repo?",
      options: [{ label: "testrepo", value: "testrepo" }],
    });
    expect(text).toBe("<@U0ABBY> which repo?");
  });

});

describe("mention tokens: the inbound-to-outbound round trip", () => {
  const abby = { surface: "slack", externalId: "U0ABBY" };

  test("a token planted in a message and echoed back by the model pings nobody", () => {
    // The whole point of the defang, end to end. Neither half proves it alone:
    // framing.test.ts pins that `frameMessage` emits `@ [[`, and the suite above
    // pins that `@[[…]]` linkifies — the guarantee lives in the INTERACTION, that
    // MENTION_TOKEN_RE does not tolerate the space the defang inserts. If someone
    // later "hardens" the regex to `@\s*\[\[` (or the defang to a zero-width
    // character), both of those suites stay green and this exploit reopens. Only
    // this test fails.
    const framed = frameMessage({ author: abby, text: "please ping @[[slack:U0BOSS]]" });
    const out = renderMrkdwn(framed);
    expect(out).not.toContain("<@");
    expect(out).toContain("U0BOSS"); // the text survives; only its privilege is gone
  });

  test("the defang holds for a token the member decorates or repeats", () => {
    const framed = frameMessage({
      author: abby,
      displayName: "Abby",
      text: "@[[slack:U0BOSS]] @[[slack:U0CCAL]] and again @[[slack:U0BOSS]]",
    });
    expect(renderMrkdwn(framed)).not.toContain("<@");
  });

  test("a token from repo content linkifies — the accepted content-to-ping vector (decision 2026-07-20)", () => {
    // Only `frameMessage` defangs, and it only wraps inbound SURFACE text. A token
    // the agent reads from a repo file, a bash stdout line, or a PR title is not
    // framed, so it reaches renderMrkdwn intact and becomes a live mention. That is
    // deliberate: the tradeoff is bounded by the 8-distinct-user cap above, and the
    // alternative (accepting tokens only when the core itself minted them) was
    // declined because the agent must be able to notify people it names on its own.
    const fromRepoFile = "CODEOWNERS says the owner is @[[slack:U0BOSS]] — paging them";
    expect(renderMrkdwn(fromRepoFile)).toBe("CODEOWNERS says the owner is <@U0BOSS> — paging them");
  });
});

describe("notification-fallback text escapes exactly like the block body", () => {
  // The `text` field bypasses renderMrkdwn, so it has to repeat renderMrkdwn's
  // two load-bearing steps in the same order: escape, THEN linkify. Shipping the
  // linkify without the escape left `<!channel>` live in a field Slack parses —
  // a channel-wide broadcast from tool-summary text, which the mention cap never
  // sees because it only counts tokens it rewrote (review 2026-07-20).
  const BROADCASTS = ["<!channel>", "<!here>", "<!everyone>", "<@U0BOSS>"];


  test("a choice prompt cannot mint a broadcast or a raw mention", () => {
    for (const raw of BROADCASTS) {
      const { text } = choiceBlocks({ choiceId: "c", text: `pick ${raw}`, options: [{ label: "a", value: "a" }] });
      expect(text).not.toContain(raw);
      expect(text).not.toContain("<!");
    }
  });

  test("but a real token still linkifies in the fallback — the sanctioned path survives escaping", () => {
    const { text } = choiceBlocks({
      choiceId: "c",
      text: "ask @[[slack:U0ABBY]]",
      options: [{ label: "a", value: "a" }],
    });
    expect(text).toContain("<@U0ABBY>");
  });
});

describe("resolved messages render the label but never the decider", () => {
  const json = (blocks: unknown[]): string => JSON.stringify(blocks);

  test("a choice label carrying a token never reaches Slack as a literal @[[", () => {
    const { blocks } = choiceBlocks({
      choiceId: "assign_repo",
      text: "pick",
      options: [{ label: "ping @[[slack:U0ABBY]]", value: "ping" }],
    });
    const resolved = resolveChoiceMessage(blocks, "ping @[[slack:U0ABBY]]", "U_ARCH");
    expect(resolved.text).not.toContain("@[[");
    expect(json(resolved.blocks)).not.toContain("@[[");
  });

  test("a choice label containing markup is escaped, not passed through", () => {
    const { blocks } = choiceBlocks({ choiceId: "c", text: "pick", options: [{ label: "x", value: "x" }] });
    const resolved = resolveChoiceMessage(blocks, "<script>alert(1)</script>", "U_ARCH");
    expect(resolved.text).toContain("&lt;script&gt;");
    expect(resolved.text).not.toContain("<script>");
    expect(json(resolved.blocks)).not.toContain("<script>");
  });

  test("resolveChoiceMessage keeps the decider's own mention live — it comes from the verified click", () => {
    const { blocks } = choiceBlocks({ choiceId: "c", text: "pick", options: [{ label: "x", value: "x" }] });
    const resolved = resolveChoiceMessage(blocks, "<script>x</script>", "U_ARCH");
    expect(json(resolved.blocks)).toContain("<@U_ARCH>");
    expect(json(resolved.blocks)).not.toContain("&lt;@U_ARCH");
  });

});

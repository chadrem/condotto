import { describe, expect, test } from "bun:test";
import { renderMrkdwn } from "../src/adapters/slack/render";

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

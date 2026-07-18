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

  test("truncates very long messages", () => {
    const out = renderMrkdwn("x".repeat(50_000));
    expect(out.length).toBeLessThan(13_000);
    expect(out).toContain("(truncated)");
  });
});

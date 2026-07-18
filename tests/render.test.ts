import { describe, expect, test } from "bun:test";
import {
  APPROVE_ACTION,
  DENY_ACTION,
  approvalBlocks,
  renderMrkdwn,
  resolveApprovalMessage,
} from "../src/adapters/slack/render";

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

describe("approvalBlocks", () => {
  function buttons(blocks: unknown[]): any {
    return (blocks as any[]).find((b) => b.type === "actions");
  }

  test("renders two buttons that carry the requestId and the action detail", () => {
    const { blocks, text } = approvalBlocks({
      requestId: "req-1",
      toolName: "Bash",
      toolInput: { command: "npm install left-pad" },
      summary: "run `npm install left-pad`",
    });
    expect(text).toContain("Approval needed");
    const actions = buttons(blocks);
    expect(actions.block_id).toBe("conduit_approval:req-1");
    const [approve, deny] = actions.elements;
    expect(approve.action_id).toBe(APPROVE_ACTION);
    expect(approve.value).toBe("req-1");
    expect(deny.action_id).toBe(DENY_ACTION);
    expect(deny.value).toBe("req-1");
    // The command is shown so the architect can judge it.
    expect(JSON.stringify(blocks)).toContain("npm install left-pad");
  });

  test("content that contains a code fence can't break out of the detail block", () => {
    const { blocks } = approvalBlocks({
      requestId: "req-2",
      toolName: "Write",
      toolInput: { file_path: "x.md", content: "```\nrm -rf /\n```" },
      summary: "write x.md",
    });
    const detail = (blocks as any[]).find(
      (b) => b.type === "section" && String(b.text?.text ?? "").startsWith("```"),
    );
    // Exactly the opening and closing fences we added — the inner ``` is defused.
    expect((String(detail.text.text).match(/```/g) ?? []).length).toBe(2);
  });

  test("resolveApprovalMessage drops the buttons and records the decider", () => {
    const { blocks } = approvalBlocks({ requestId: "r", toolName: "Bash", toolInput: { command: "ls" }, summary: "run `ls`" });
    const resolved = resolveApprovalMessage(blocks, "approved", "U_ARCH");
    expect((resolved.blocks as any[]).some((b) => b.type === "actions")).toBe(false);
    expect(JSON.stringify(resolved.blocks)).toContain("Approved");
    expect(JSON.stringify(resolved.blocks)).toContain("U_ARCH");
  });
});

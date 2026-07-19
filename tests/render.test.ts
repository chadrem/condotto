import { describe, expect, test } from "bun:test";
import {
  APPROVE_ACTION,
  CHOICE_ACTION,
  DENY_ACTION,
  approvalBlocks,
  choiceBlocks,
  parseChoiceBlockId,
  renderMrkdwn,
  resolveApprovalMessage,
  resolveChoiceMessage,
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
    expect(actions.block_id).toBe("condotto_approval:req-1");
    const [approve, deny] = actions.elements;
    expect(approve.action_id).toBe(APPROVE_ACTION);
    expect(approve.value).toBe("req-1");
    expect(deny.action_id).toBe(DENY_ACTION);
    expect(deny.value).toBe("req-1");
    // The command is shown so the architect can judge it.
    expect(JSON.stringify(blocks)).toContain("npm install left-pad");
  });

  test("a policy concern renders a warning context block (production-data)", () => {
    const { blocks } = approvalBlocks({
      requestId: "req-p",
      toolName: "Bash",
      toolInput: { command: "psql -c 'select count(*) from users'" },
      summary: "run `psql ...` (investigates production data)",
      concern: "This investigates production data — results must be aggregates only.",
    });
    const warn = (blocks as any[]).find(
      (b) => b.type === "context" && String(JSON.stringify(b)).includes("aggregates only"),
    );
    expect(warn).toBeDefined();
    expect(JSON.stringify(warn)).toContain(":warning:");
  });

  test("no concern → no warning block", () => {
    const { blocks } = approvalBlocks({ requestId: "r", toolName: "Bash", toolInput: { command: "ls" }, summary: "run `ls`" });
    expect((blocks as any[]).some((b) => b.type === "context")).toBe(false);
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

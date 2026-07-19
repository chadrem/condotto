// Minimal model-markdown -> Slack mrkdwn rendering. Slack does not speak
// GitHub markdown: bold is *text*, links are <url|text>, headers don't exist.
// Escaping happens BEFORE link/mention markup is substituted (Appendix A4).

import type { ApprovalPrompt, ChoicePrompt } from "../../core/types";

const MAX_MESSAGE_CHARS = 12_000; // chat-scale ceiling well under Slack's 40k hard cap

function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderMrkdwn(markdown: string): string {
  // Protect code (fenced blocks AND inline spans) from any rewriting. The
  // placeholder is delimited with NUL bytes, which cannot collide with model
  // output text because any pre-existing NULs are stripped first.
  const code: string[] = [];
  const protect = (m: string): string => {
    code.push(m);
    return "\u0000" + (code.length - 1) + "\u0000";
  };
  let text = markdown
    .replace(/\u0000/g, "")
    .replace(/```[\s\S]*?```/g, protect)
    .replace(/`[^`\n]+`/g, protect);

  text = escapeSlack(text);
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "*$1*"); // headers -> bold lines
  text = text.replace(/\*\*(.+?)\*\*/g, "*$1*"); // **bold** -> *bold*
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "<$2|$1>"); // [t](url) -> <url|t>

  text = text.replace(/\u0000(\d+)\u0000/g, (_, i) => {
    // Slack has no fence language tags — they'd render as literal first-line text.
    const block = code[Number(i)]!.replace(/^```[a-zA-Z0-9_+-]+\n/, "```\n");
    return escapeSlack(block);
  });

  if (text.length > MAX_MESSAGE_CHARS) {
    text = `${text.slice(0, MAX_MESSAGE_CHARS)}\n… _(truncated)_`;
  }
  return text;
}

// -- approval rendering (Block Kit) -----------------------------------------

export const APPROVE_ACTION = "condotto_approve";
export const DENY_ACTION = "condotto_deny";

const MAX_DETAIL_CHARS = 2_500; // well under Slack's 3000-char section text limit

/** A safe fenced code block: no NULs, no fence-breaking backticks, bounded. */
function codeBlock(raw: string): string {
  // Strip NULs and defuse any ``` in the content (insert a zero-width space) so
  // it can't terminate our fence early.
  let s = raw.replace(/\u0000/g, "").replace(/```/g, "``\u200b`");
  if (s.length > MAX_DETAIL_CHARS) s = s.slice(0, MAX_DETAIL_CHARS) + "\n... (truncated)";
  return "```\n" + s + "\n```";
}

/** The consequential detail an architect needs to judge a gated call. */
function approvalDetail(toolName: string, input: unknown): string | null {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string =>
    typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v);
  switch (toolName) {
    case "Bash":
      return str(i.command) || null;
    case "Write":
      return `${str(i.file_path)}\n\n${str(i.content)}`.trim() || null;
    case "Edit":
      return `${str(i.file_path)}\n\n- ${str(i.old_string)}\n+ ${str(i.new_string)}`.trim() || null;
    case "MultiEdit":
    case "NotebookEdit":
      return str(i.file_path || i.notebook_path) || null;
    case "WebFetch":
      return str(i.url) || null;
    case "condotto:land":
    case "condotto:deploy":
      // Show the exact repo command the architect is approving to run.
      return str(i.command) || null;
    default: {
      const j = str(i);
      return j && j !== "{}" ? j : null;
    }
  }
}

/**
 * The approval message: a headline, the exact action detail, and Approve/Deny
 * buttons carrying the requestId. The buttons are the only authoritative signal
 * — the daemon re-checks the clicker's role server-side (never trusts this).
 */
export function approvalBlocks(req: ApprovalPrompt): { text: string; blocks: unknown[] } {
  const detail = approvalDetail(req.toolName, req.toolInput);
  const blocks: unknown[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `:lock: *Approval needed* — I want to ${renderMrkdwn(req.summary)}` },
    },
  ];
  if (detail) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: codeBlock(detail) } });
  }
  if (req.concern) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `:warning: ${renderMrkdwn(req.concern)}` }],
    });
  }
  blocks.push({
    type: "actions",
    block_id: `condotto_approval:${req.requestId}`,
    elements: [
      {
        type: "button",
        action_id: APPROVE_ACTION,
        text: { type: "plain_text", text: "Approve" },
        style: "primary",
        value: req.requestId,
      },
      {
        type: "button",
        action_id: DENY_ACTION,
        text: { type: "plain_text", text: "Deny" },
        style: "danger",
        value: req.requestId,
      },
    ],
  });
  return { text: `Approval needed: ${req.summary}`, blocks };
}

/**
 * Given the blocks of a posted approval message, produce the resolved version:
 * the original detail preserved, the Approve/Deny actions removed, and a context
 * line recording who decided. Falls back to a single line if blocks are absent.
 */
export function resolveApprovalMessage(
  originalBlocks: unknown[] | undefined,
  outcome: "approved" | "denied",
  deciderUserId: string,
): { text: string; blocks: unknown[] } {
  const mark = outcome === "approved" ? ":white_check_mark:" : ":no_entry:";
  const verb = outcome === "approved" ? "Approved" : "Denied";
  const kept = (Array.isArray(originalBlocks) ? originalBlocks : []).filter(
    (b) => !(b && typeof b === "object" && (b as { type?: string }).type === "actions"),
  );
  kept.push({ type: "context", elements: [{ type: "mrkdwn", text: `${mark} *${verb}* by <@${deciderUserId}>` }] });
  return { text: `${verb} by <@${deciderUserId}>`, blocks: kept };
}

// -- guided choice rendering (M3.1) -----------------------------------------

export const CHOICE_ACTION = "condotto_choice";

/**
 * A guided choice as a question plus one button per option. `block_id` carries
 * the choiceId and the architect-only flag so the click handler can route and
 * pre-check authority; each button's `value` is the option's value.
 */
export function choiceBlocks(prompt: ChoicePrompt): { text: string; blocks: unknown[] } {
  const options = prompt.options.slice(0, 5); // Slack caps buttons per actions block
  return {
    text: prompt.text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: renderMrkdwn(prompt.text) } },
      {
        type: "actions",
        block_id: `${CHOICE_ACTION}:${prompt.choiceId}:${prompt.architectOnly ? 1 : 0}`,
        elements: options.map((o) => ({
          type: "button",
          action_id: `${CHOICE_ACTION}:${o.value}`,
          text: { type: "plain_text", text: o.label.slice(0, 75) },
          value: o.value,
        })),
      },
    ],
  };
}

/** Parse a choice message's block_id back into {choiceId, architectOnly}. */
export function parseChoiceBlockId(blockId: string | undefined): { choiceId: string; architectOnly: boolean } | null {
  if (!blockId || !blockId.startsWith(CHOICE_ACTION + ":")) return null;
  const rest = blockId.slice(CHOICE_ACTION.length + 1);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon === -1) return null;
  return { choiceId: rest.slice(0, lastColon), architectOnly: rest.slice(lastColon + 1) === "1" };
}

/** Resolved version of a choice message: buttons dropped, selection recorded. */
export function resolveChoiceMessage(
  originalBlocks: unknown[] | undefined,
  selectedLabel: string,
  deciderUserId: string,
): { text: string; blocks: unknown[] } {
  const kept = (Array.isArray(originalBlocks) ? originalBlocks : []).filter(
    (b) => !(b && typeof b === "object" && (b as { type?: string }).type === "actions"),
  );
  kept.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `:point_right: <@${deciderUserId}> chose *${selectedLabel}*` }],
  });
  return { text: `Selected ${selectedLabel}`, blocks: kept };
}

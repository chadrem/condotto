// Minimal model-markdown -> Slack mrkdwn rendering. Slack does not speak
// GitHub markdown: bold is *text*, links are <url|text>, headers don't exist.
// Escaping happens BEFORE link/mention markup is substituted (Appendix A4).

import type { ChoicePrompt } from "../../core/types";
import { MENTION_TOKEN_RE } from "../../core/types";

const MAX_MESSAGE_CHARS = 12_000; // chat-scale ceiling well under Slack's 40k hard cap

function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Slack member ids: `U…` for a normal member, `W…` on Enterprise Grid. Anchored
// to those two prefixes so the pattern matches its own documentation — a looser
// `[A-Z]` also accepted channel (`C…`), bot (`B…`) and usergroup (`S…`) ids, none
// of which are a person and none of which `<@…>` renders correctly.
const SLACK_ID_RE = /^slack:([UW][A-Z0-9]{1,31})$/;
const MAX_MENTIONS_PER_MESSAGE = 8; // bounded blast radius, counted per DISTINCT user

/**
 * The core's surface-neutral mention token -> real Slack mention markup. This is
 * the ONE place in the daemon that mints a mention in message text.
 *
 * Ordering matters (Appendix A4): this runs AFTER `escapeSlack`, so the `<@…>` it
 * emits is not escaped back into literal text, and WHILE code is still held in
 * placeholders, so a token inside backticks or a fence stays literal — quoting a
 * token must never ping anyone.
 *
 * Bounded at MAX_MENTIONS_PER_MESSAGE distinct users: model output can echo
 * tokens, and overflow degrades to the bare key. Visibly wrong beats a mass ping.
 * A foreign-surface or malformed key degrades to the bare key, never to broken
 * markup. A raw `<@U…>` written by the model was already escaped above and stays
 * escaped — the token is the only sanctioned path to a notification.
 */
function linkifyMentions(text: string): string {
  const seen = new Set<string>();
  return text.replace(MENTION_TOKEN_RE, (_whole, key: string) => {
    const m = key.match(SLACK_ID_RE);
    if (!m) return key;
    const id = m[1]!;
    if (!seen.has(id)) {
      if (seen.size >= MAX_MENTIONS_PER_MESSAGE) return key;
      seen.add(id);
    }
    return `<@${id}>`;
  });
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
  text = linkifyMentions(text); // after escaping, before code is restored (A4)
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "*$1*"); // headers -> bold lines
  text = text.replace(/\*\*(.+?)\*\*/g, "*$1*"); // **bold** -> *bold*
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "<$2|$1>"); // [t](url) -> <url|t>

  text = text.replace(/\u0000(\d+)\u0000/g, (_, i) => {
    // Slack has no fence language tags — they'd render as literal first-line text.
    const block = code[Number(i)]!.replace(/^```[a-zA-Z0-9_+-]+\n/, "```\n");
    return escapeSlack(block);
  });

  if (text.length > MAX_MESSAGE_CHARS) {
    // Never leave a half-written `<@U…>` or `<url|text>` at the cut — Slack
    // renders the remnant as literal junk.
    text = `${text.slice(0, MAX_MESSAGE_CHARS).replace(/<[^>]*$/, "")}\n… _(truncated)_`;
  }
  return text;
}

// -- guided choice rendering (Block Kit) ------------------------------------
//
// The only interactive control Condotto still posts. Approve/Deny buttons lived
// here until 2026-07-26; the repo picker is what remains, and it is a question
// rather than a permission.

export const CHOICE_ACTION = "condotto_choice";

export function choiceBlocks(prompt: ChoicePrompt): { text: string; blocks: unknown[] } {
  const options = prompt.options.slice(0, 5); // Slack caps buttons per actions block
  return {
    // Notification fallback: bypasses renderMrkdwn, so escape then linkify (A4).
    text: linkifyMentions(escapeSlack(prompt.text)),
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
  // The label is interpolated into a mrkdwn element, so render it rather than
  // pasting it raw — it is the one outbound path that otherwise neither escapes
  // nor linkifies. `<@deciderUserId>` is appended AFTER, from the verified click
  // payload, so it is never subject to escaping.
  const label = renderMrkdwn(selectedLabel);
  kept.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `:point_right: <@${deciderUserId}> chose *${label}*` }],
  });
  return { text: `Selected ${label}`, blocks: kept };
}

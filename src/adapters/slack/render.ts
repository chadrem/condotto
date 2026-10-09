// Minimal model-markdown -> Slack mrkdwn rendering. Slack does not speak
// GitHub markdown: bold is *text*, links are <url|text>, headers don't exist.
// Escaping happens BEFORE link/mention markup is substituted.

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
 * Ordering matters: this runs AFTER `escapeSlack`, so the `<@…>` it
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
function linkifyMentions(text: string, seen: Set<string> = new Set()): string {
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
  return renderMrkdwnSharing(markdown, new Set());
}

// `seen` is the mention budget. One message rendered in several pieces shares a
// single set, so the cap still holds for the whole message.
function renderMrkdwnSharing(markdown: string, seen: Set<string>): string {
  // Protect code (fenced blocks AND inline spans) from any rewriting. The
  // placeholder is delimited with NUL bytes, which cannot collide with model
  // output text because any pre-existing NULs are stripped first.
  const code: string[] = [];
  const protect = (m: string): string => {
    code.push(m);
    return `\u0000${code.length - 1}\u0000`;
  };
  let text = tablesToFences(markdown.replace(/\u0000/g, ""))
    .replace(/```[\s\S]*?```/g, protect)
    .replace(/`[^`\n]+`/g, protect);

  text = escapeSlack(text);
  text = linkifyMentions(text, seen); // after escaping, before code is restored (A4)
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

// -- tables -------------------------------------------------------------------
//
// mrkdwn has no tables, so a GitHub pipe table would arrive as literal pipes and
// dashes. One table per message becomes a native `table` block. Every other table,
// and any table over the block's limits, becomes an aligned monospace fence, which
// still reads as a table on every client and in notifications.

type Align = "left" | "center" | "right" | null;
interface PipeTable {
  header: string[];
  aligns: Align[];
  rows: string[][];
}
type Segment = { raw: string; table?: PipeTable };

// Slack's table block limits. It allows one table per message.
const TABLE_MAX_ROWS = 100; // header included
const TABLE_MAX_COLS = 20;
const TABLE_MAX_CHARS = 10_000; // across every cell in the message
const SECTION_MAX_CHARS = 3_000; // a section block's mrkdwn text
const MAX_BLOCKS = 50;

const DELIMITER_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** Cells of one pipe row. `\|` is a literal pipe, not a separator. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function alignOf(cell: string): Align {
  const l = cell.startsWith(":");
  const r = cell.endsWith(":");
  return l && r ? "center" : r ? "right" : l ? "left" : null;
}

/**
 * Cut markdown into prose and pipe tables. A table is a header row, a delimiter
 * row with the same cell count, then every following line that has a pipe. Lines
 * inside a ``` fence are never tables, so quoted markdown stays literal.
 */
function splitTables(markdown: string): Segment[] {
  const lines = markdown.split("\n");
  const out: Segment[] = [];
  let prose: string[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimStart().startsWith("```")) inFence = !inFence;
    const next = lines[i + 1];
    if (!inFence && line.includes("|") && next?.includes("|") && DELIMITER_RE.test(next)) {
      const header = splitRow(line);
      const delims = splitRow(next);
      if (header.length === delims.length) {
        const rows: string[][] = [];
        let j = i + 2;
        while (j < lines.length && lines[j]!.includes("|") && lines[j]!.trim() !== "") {
          const cells = splitRow(lines[j]!).slice(0, header.length);
          while (cells.length < header.length) cells.push("");
          rows.push(cells);
          j++;
        }
        if (prose.length) out.push({ raw: prose.join("\n") });
        prose = [];
        out.push({ raw: lines.slice(i, j).join("\n"), table: { header, aligns: delims.map(alignOf), rows } });
        i = j - 1;
        continue;
      }
    }
    prose.push(line);
  }
  if (prose.length) out.push({ raw: prose.join("\n") });
  return out;
}

/** A cell as plain text: emphasis and code markers dropped, links kept readable. */
function plainCell(cell: string): string {
  return cell
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`/g, "");
}

function fenceTable(t: PipeTable): string {
  const all = [t.header, ...t.rows].map((r) => r.map(plainCell));
  const widths = t.header.map((_, c) => Math.max(...all.map((r) => r[c]!.length)));
  const pad = (s: string, c: number): string => {
    const gap = widths[c]! - s.length;
    if (t.aligns[c] === "right") return " ".repeat(gap) + s;
    if (t.aligns[c] === "center") return " ".repeat(gap >> 1) + s + " ".repeat(gap - (gap >> 1));
    return s + " ".repeat(gap);
  };
  const line = (r: string[]): string => r.map(pad).join("  ").trimEnd();
  const rule = widths.map((w) => "-".repeat(w)).join("  ");
  return ["```", line(all[0]!), rule, ...all.slice(1).map(line), "```"].join("\n");
}

function tablesToFences(markdown: string): string {
  if (!markdown.includes("|")) return markdown;
  return splitTables(markdown)
    .map((s) => (s.table ? fenceTable(s.table) : s.raw))
    .join("\n");
}

function fitsTableBlock(t: PipeTable): boolean {
  const cells = [t.header, ...t.rows];
  const chars = cells.reduce((n, r) => n + r.reduce((m, c) => m + c.length, 0), 0);
  return cells.length <= TABLE_MAX_ROWS && t.header.length <= TABLE_MAX_COLS && chars <= TABLE_MAX_CHARS;
}

const CELL_TOKEN_RE = new RegExp(
  [
    /\*\*(.+?)\*\*/.source, // 1: bold
    /`([^`]+)`/.source, // 2: code
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/.source, // 3, 4: link
    MENTION_TOKEN_RE.source, // 5: mention token
  ].join("|"),
  "gi",
);

/**
 * One cell as rich text. rich_text elements are literal, so nothing is escaped,
 * and a mention token degrades to its bare key: a cell never pings anyone.
 */
function richCell(cell: string, bold: boolean): unknown {
  const elements: unknown[] = [];
  const text = (t: string, style: Record<string, boolean> = {}): void => {
    if (!t) return;
    const s = bold ? { ...style, bold: true } : style;
    elements.push(Object.keys(s).length ? { type: "text", text: t, style: s } : { type: "text", text: t });
  };
  let last = 0;
  for (const m of cell.matchAll(CELL_TOKEN_RE)) {
    text(cell.slice(last, m.index));
    if (m[1] !== undefined) text(m[1], { bold: true });
    else if (m[2] !== undefined) text(m[2], { code: true });
    else if (m[3] !== undefined) elements.push({ type: "link", url: m[4], text: m[3] });
    else text(m[5]!);
    last = m.index + m[0].length;
  }
  text(cell.slice(last));
  // An empty cell still needs an element; a lone space renders as blank.
  if (!elements.length) elements.push({ type: "text", text: " " });
  return { type: "rich_text", elements: [{ type: "rich_text_section", elements }] };
}

function tableBlock(t: PipeTable): unknown {
  const block: Record<string, unknown> = {
    type: "table",
    rows: [t.header.map((c) => richCell(c, true)), ...t.rows.map((r) => r.map((c) => richCell(c, false)))],
  };
  if (t.aligns.some((a) => a)) block.column_settings = t.aligns.map((a) => (a ? { align: a } : null));
  return block;
}

/**
 * Rendered mrkdwn cut into section-sized pieces at line breaks. A fence open at
 * a cut is closed there and reopened in the next piece, so code stays code.
 */
function sections(mrkdwn: string): unknown[] {
  const limit = SECTION_MAX_CHARS - 8; // room to close and reopen a fence
  const pieces: string[] = [];
  let rest = mrkdwn.trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = limit;
    let piece = rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\n/, "");
    if (cut === limit) piece = piece.replace(/<[^>]*$/, ""); // never a half-written link
    if ((piece.match(/```/g) ?? []).length % 2) {
      piece += "\n```";
      rest = `\`\`\`\n${rest}`;
    }
    pieces.push(piece);
  }
  if (rest) pieces.push(rest);
  return pieces.map((p) => ({ type: "section", text: { type: "mrkdwn", text: p } }));
}

/**
 * A whole outbound message. Without a table this is exactly `renderMrkdwn`. With
 * one, the first table that fits becomes a `table` block between mrkdwn sections,
 * and `text` (every table fenced) is what notifications show.
 */
export function renderMessage(markdown: string): { text: string; blocks?: unknown[] } {
  const seen = new Set<string>();
  const text = renderMrkdwnSharing(markdown, seen);
  if (!markdown.includes("|")) return { text };
  const segs = splitTables(markdown.replace(/\u0000/g, ""));
  const at = segs.findIndex((s) => s.table && fitsTableBlock(s.table));
  if (at === -1) return { text };
  const raw = (ss: Segment[]): string => ss.map((s) => s.raw).join("\n");
  const blocks = [
    ...sections(renderMrkdwnSharing(raw(segs.slice(0, at)), seen)),
    tableBlock(segs[at]!.table!),
    ...sections(renderMrkdwnSharing(raw(segs.slice(at + 1)), seen)),
  ];
  return blocks.length > MAX_BLOCKS ? { text } : { text, blocks };
}

// -- guided choice rendering (Block Kit) ------------------------------------
//
// The only interactive control Condotto posts: a repo picker. It asks a question;
// it never grants a permission.

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
  if (!blockId?.startsWith(`${CHOICE_ACTION}:`)) return null;
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

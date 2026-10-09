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
function linkifyMentions(text: string, seen: Set<string>): string {
  return text.replace(MENTION_TOKEN_RE, (_whole, key: string) => {
    const id = mentionId(key, seen);
    return id ? `<@${id}>` : key;
  });
}

/**
 * The Slack id a mention token may ping, or null when it must degrade to its bare
 * key. Every mention Condotto mints, in text or in a table cell, is decided here,
 * against one `seen` budget per message.
 */
function mentionId(key: string, seen: Set<string>): string | null {
  const id = key.match(SLACK_ID_RE)?.[1];
  if (!id) return null;
  if (!seen.has(id)) {
    if (seen.size >= MAX_MENTIONS_PER_MESSAGE) return null;
    seen.add(id);
  }
  return id;
}

// The markdown we rewrite, shared by prose and table cells so the two can't drift.
const BOLD_RE = /\*\*(.+?)\*\*/;
const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/;
const INLINE_CODE_RE = /`([^`\n]+)`/;
const all = (re: RegExp): RegExp => new RegExp(re.source, "g");

export function renderMrkdwn(markdown: string): string {
  return truncate(renderPieces(parse(markdown), new Set()).join("\n"));
}

// -- parsing --------------------------------------------------------------------
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
type Segment = { prose: string } | { table: PipeTable };
interface Parsed {
  segs: Segment[];
  code: string[];
}

/**
 * Protect fences, cut the rest into prose and pipe tables, then protect inline
 * code in the prose. Protected code becomes NUL-delimited placeholders, which
 * cannot collide with model text because any pre-existing NULs are stripped.
 *
 * Fences go first, so "inside a code block" is decided once: a table quoted in one
 * is never seen as a table, and an unclosed fence (a reply cut off mid-block) is
 * code to the end and is closed when restored. Inline code goes after the table
 * split because, as on GitHub, a pipe inside `code` on a table row still separates
 * cells; cells handle their own backticks.
 */
function parse(markdown: string): Parsed {
  const code: string[] = [];
  const protect = (m: string): string => {
    code.push(m);
    return `\u0000${code.length - 1}\u0000`;
  };
  const text = markdown
    .replace(/\u0000/g, "")
    .replace(/```[\s\S]*?```/g, protect)
    .replace(/```[\s\S]*$/, (m) => protect(`${m.trimEnd()}\n\`\`\``));
  const segs = splitTables(text).map((s) =>
    "prose" in s ? { prose: s.prose.replace(all(INLINE_CODE_RE), protect) } : s,
  );
  return { segs, code };
}

/**
 * A cell's own text, with any fence placeholder on its row put back as one line
 * of inline code, so a multi-line block can't break the row apart.
 */
const cellText = (cell: string, code: string[]): string =>
  cell.replace(/\u0000(\d+)\u0000/g, (_, i) => {
    const body = code[Number(i)]!
      .replace(/^```(?:[a-zA-Z0-9_+-]*\n)?/, "") // a language tag only when a line break follows
      .replace(/```$/, "")
      .trim()
      .replace(/\s*\n\s*/g, " ");
    return body ? `\`${body}\`` : "";
  });

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
 * A table is a header row, a delimiter row with the same cell count, then every
 * following line that has a pipe. Short rows are padded and long ones trimmed to
 * the header.
 */
function splitTables(text: string): Segment[] {
  const lines = text.split("\n");
  const out: Segment[] = [];
  let prose: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = lines[i + 1];
    if (line.includes("|") && next?.includes("|") && DELIMITER_RE.test(next)) {
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
        if (prose.length) out.push({ prose: prose.join("\n") });
        prose = [];
        out.push({ table: { header, aligns: delims.map(alignOf), rows } });
        i = j - 1;
        continue;
      }
    }
    prose.push(line);
  }
  if (prose.length) out.push({ prose: prose.join("\n") });
  return out;
}

// -- rendering ------------------------------------------------------------------

// A link longer than this stays readable text rather than `<url|text>` markup, so
// a section cut can never fall inside one.
const MAX_LINK_CHARS = 1_000;

/** Prose as Slack mrkdwn. Escaping happens BEFORE link and mention markup. */
function renderProse(prose: string, code: string[], seen: Set<string>): string {
  let text = escapeSlack(prose);
  text = linkifyMentions(text, seen); // after escaping, before code is restored (A4)
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "*$1*"); // headers -> bold lines
  text = text.replace(all(BOLD_RE), "*$1*"); // **bold** -> *bold*
  text = text.replace(all(LINK_RE), (m, t, url) => (m.length > MAX_LINK_CHARS ? `${t} (${url})` : `<${url}|${t}>`));
  return text.replace(/\u0000(\d+)\u0000/g, (_, i) => {
    // Slack has no fence language tags — they'd render as literal first-line text.
    const block = code[Number(i)]!.replace(/^```[a-zA-Z0-9_+-]+\n/, "```\n");
    return escapeSlack(block);
  });
}

/**
 * A cell as plain text for a monospace fence: emphasis and code markers dropped,
 * links kept readable, and a mention token shown as its bare key, since nothing
 * inside a fence can ping.
 */
function plainCell(cell: string, code: string[]): string {
  return cellText(cell, code)
    .replace(all(LINK_RE), "$1 ($2)")
    .replace(all(BOLD_RE), "$1")
    .replace(MENTION_TOKEN_RE, "$1")
    .replace(/`/g, "");
}

function fenceTable(t: PipeTable, code: string[]): string {
  const rows = [t.header, ...t.rows].map((r) => r.map((c) => plainCell(c, code)));
  const widths = t.header.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
  const pad = (s: string, c: number): string => {
    const gap = widths[c]! - s.length;
    if (t.aligns[c] === "right") return " ".repeat(gap) + s;
    if (t.aligns[c] === "center") return " ".repeat(gap >> 1) + s + " ".repeat(gap - (gap >> 1));
    return s + " ".repeat(gap);
  };
  const line = (r: string[]): string => r.map(pad).join("  ").trimEnd();
  const rule = widths.map((w) => "-".repeat(w)).join("  ");
  return escapeSlack(["```", line(rows[0]!), rule, ...rows.slice(1).map(line), "```"].join("\n"));
}

/** Every segment rendered once, tables as fences. */
function renderPieces({ segs, code }: Parsed, seen: Set<string>): string[] {
  return segs.map((s) => ("prose" in s ? renderProse(s.prose, code, seen) : fenceTable(s.table, code)));
}

function truncate(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  return `${text.slice(0, safeCut(text, MAX_MESSAGE_CHARS))}\n… _(truncated)_`;
}

/**
 * Pull a cut point back so it never lands inside `<url|text>` or `<@U…>`, inside
 * an entity like `&amp;`, or between the halves of a surrogate pair. Slack shows
 * any of those remnants as literal junk.
 */
function safeCut(s: string, cut: number): number {
  const lt = s.lastIndexOf("<", cut - 1);
  if (lt > s.lastIndexOf(">", cut - 1)) cut = lt;
  const amp = s.lastIndexOf("&", cut - 1);
  if (amp > s.lastIndexOf(";", cut - 1)) cut = amp;
  const c = s.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut--;
  return cut;
}

// -- table blocks ---------------------------------------------------------------

// Slack's table block limits. It allows one table per message.
const TABLE_MAX_ROWS = 100; // header included
const TABLE_MAX_COLS = 20;
const TABLE_MAX_CHARS = 10_000; // across every cell in the message
const SECTION_MAX_CHARS = 3_000; // a section block's mrkdwn text
const MAX_BLOCKS = 50;

function fitsTableBlock(t: PipeTable, code: string[]): boolean {
  const rows = [t.header, ...t.rows];
  const chars = rows.reduce((n, r) => n + r.reduce((m, c) => m + cellText(c, code).length, 0), 0);
  return rows.length <= TABLE_MAX_ROWS && t.header.length <= TABLE_MAX_COLS && chars <= TABLE_MAX_CHARS;
}

const CELL_TOKEN_RE = new RegExp(
  [BOLD_RE.source, INLINE_CODE_RE.source, LINK_RE.source, MENTION_TOKEN_RE.source].join("|"),
  "gi",
);

type Style = { bold?: boolean; code?: boolean };

/**
 * One cell as rich text. rich_text elements are literal, so nothing is escaped. A
 * mention token becomes a `user` element within the message's mention budget and
 * its bare key past it, exactly as in prose, including inside bold. Link text is
 * plain, so a token there shows its bare key.
 */
function richCell(cell: string, code: string[], header: boolean, seen: Set<string>): unknown {
  const elements: unknown[] = [];
  const text = (t: string, style: Style): void => {
    if (!t) return;
    elements.push(Object.keys(style).length ? { type: "text", text: t, style } : { type: "text", text: t });
  };
  const emit = (raw: string, style: Style): void => {
    let last = 0;
    for (const m of raw.matchAll(CELL_TOKEN_RE)) {
      text(raw.slice(last, m.index), style);
      if (m[1] !== undefined) emit(m[1], { ...style, bold: true });
      else if (m[2] !== undefined) text(m[2], { ...style, code: true });
      else if (m[3] !== undefined) {
        const link = { type: "link", url: m[4], text: m[3].replace(MENTION_TOKEN_RE, "$1") };
        elements.push(style.bold ? { ...link, style: { bold: true } } : link);
      } else {
        const id = mentionId(m[5]!, seen);
        if (id) elements.push({ type: "user", user_id: id });
        else text(m[5]!, style);
      }
      last = m.index + m[0].length;
    }
    text(raw.slice(last), style);
  };
  emit(cellText(cell, code), header ? { bold: true } : {});
  // An empty cell still needs an element; a lone space renders as blank.
  if (!elements.length) elements.push({ type: "text", text: " " });
  return { type: "rich_text", elements: [{ type: "rich_text_section", elements }] };
}

function tableBlock(t: PipeTable, code: string[], seen: Set<string>): unknown {
  const block: Record<string, unknown> = {
    type: "table",
    rows: [
      t.header.map((c) => richCell(c, code, true, seen)),
      ...t.rows.map((r) => r.map((c) => richCell(c, code, false, seen))),
    ],
  };
  if (t.aligns.some((a) => a)) block.column_settings = t.aligns.map((a) => (a ? { align: a } : null));
  return block;
}

/**
 * Rendered mrkdwn cut into section-sized pieces. Nothing is dropped or altered at
 * a cut, and a fence open at one is closed there and reopened in the next piece,
 * so code stays code. Prose breaks at a line break in the back half, else a space.
 * Inside a fence only a line break will do, at any distance, since cutting at a
 * space would change the code; a single code line longer than a section is the
 * one thing that still has to be split mid-line.
 */
function sections(mrkdwn: string): unknown[] {
  const limit = SECTION_MAX_CHARS - 8; // room to close and reopen a fence
  const pieces: string[] = [];
  let rest = mrkdwn.trim();
  while (rest.length > limit) {
    // A piece must hold more than a reopened fence marker, or a code line longer
    // than a section would be cut at that marker forever.
    const floor = rest.startsWith("```\n") ? 4 : 0;
    const inFence = (rest.slice(0, limit).match(/```/g) ?? []).length % 2 === 1;
    const nl = rest.lastIndexOf("\n", limit);
    const sp = inFence ? -1 : rest.lastIndexOf(" ", limit);
    let cut: number;
    let skip = 1; // the line break or space at the cut is dropped
    if (nl >= limit / 2 || (inFence && nl > floor)) cut = nl;
    else if (sp >= limit / 2 && safeCut(rest, sp) === sp) cut = sp;
    else {
      cut = safeCut(rest, limit);
      if (cut <= floor) cut = limit;
      skip = 0;
    }
    let piece = rest.slice(0, cut);
    rest = rest.slice(cut + skip);
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
 * A whole outbound message. `text` is exactly `renderMrkdwn`. When there is a table
 * that fits, the first one becomes a `table` block between mrkdwn sections, and
 * `text` (every table fenced) is what notifications show.
 */
export function renderMessage(markdown: string): { text: string; blocks?: unknown[] } {
  const parsed = parse(markdown);
  const seen = new Set<string>();
  const pieces = renderPieces(parsed, seen);
  const whole = pieces.join("\n");
  const text = truncate(whole);
  const { segs, code } = parsed;
  const at = segs.findIndex((s) => "table" in s && fitsTableBlock(s.table, code));
  // Blocks have no truncation marker of their own, so a message too long to send
  // whole goes as `text`, which says where it was cut.
  if (at === -1 || text !== whole) return { text };
  const table = (segs[at] as { table: PipeTable }).table;
  const blocks = [
    ...sections(pieces.slice(0, at).join("\n")),
    tableBlock(table, code, seen),
    ...sections(pieces.slice(at + 1).join("\n")),
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
    text: linkifyMentions(escapeSlack(prompt.text), new Set()),
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

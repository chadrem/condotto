import { App, type RespondFn } from "@slack/bolt";
import type {
  ApprovalPrompt,
  Attachment,
  ChoicePrompt,
  CommandName,
  ConversationRef,
  InboundEvent,
  OutboundMessage,
  PostedRef,
  Principal,
  SurfaceAdapter,
  SurfaceCapabilities,
} from "../../core/types";
import { principalKey } from "../../core/types";
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
} from "./render";
import { DisplayNameCache, slackUserSource } from "./users";

/**
 * Authority the adapter consults for the ephemeral "architects only" response
 * on a button click. Domain-typed and core-provided (composition root wires it
 * to the roles table); the daemon ALSO re-checks server-side when it processes
 * the emitted decision — this is UX, not the security boundary.
 */
export interface SurfaceAuthority {
  isArchitect(principal: Principal, channelId: string): boolean;
}

/**
 * Core-provided operator queries for the `/condotto` slash console. Both
 * are synchronous, read-only text renderers the core owns — the adapter only
 * decides HOW to deliver them (an ephemeral `respond`, so a channel is never
 * spammed). Same injection shape as `SurfaceAuthority`: the composition root wires
 * these to the SessionManager, and no core type leaks into Slack transport.
 */
export interface OperatorConsole {
  /** Daemon-wide operator dashboard; returns the refusal line for non-architects
   *  (authority is decided in the core, not trusted from here). */
  operatorStatus(author: Principal, channelId: string): string;
  /** This channel's live sessions + how to stop one in-thread (`/condotto stop`). */
  channelStopGuidance(channelId: string): string;
}

/**
 * The ephemeral text a `/condotto <sub>` slash command should `respond` with, or
 * null when the sub-command is NOT an ephemeral console query (assign, unknown) and
 * the caller handles it. Pure and module-level so the console routing is unit-
 * testable without a live Bolt App.
 */
export function slashEphemeralText(
  sub: string,
  author: Principal,
  channelId: string,
  operator: OperatorConsole,
): string | null {
  switch (sub.trim().toLowerCase()) {
    case "status":
      return operator.operatorStatus(author, channelId);
    case "stop":
      return operator.channelStopGuidance(channelId);
    default:
      return null;
  }
}

// Slack surface adapter: Bolt over Socket Mode (outbound WebSocket, no public
// URL — hard requirement, DESIGN.md §3). All Slack shapes (thread_ts, channel
// ids, Bolt payloads) stay inside this directory.
//
// Slack `ts` values are strings with significant leading zeros in the
// fractional part. They are NEVER parsed as numbers here.
//
// Conversation identity: a Slack thread_ts is only unique **within a channel**,
// so the domain `conversationId` is the pair encoded as "<channel>:<ts>". The
// encoding is private to this adapter (decoded again in post/update); the core
// treats conversation ids as opaque strings.
//
// Verified live-doc fact (2026-07-18, contradicts DESIGN.md journey 1; logged
// in DECISIONS.md): custom slash commands CANNOT be invoked inside a message
// thread — the client only offers them at top level, and the payload carries
// no thread context. So:
//   /condotto assign        -> creates a NEW conversation: we post an anchor
//                             message and its ts becomes the thread root.
//   @Condotto assign        -> assigns the EXISTING thread the mention is in
//                             (app_mention events do carry thread_ts).
//   @Condotto stop|status   -> thread-scoped commands.

const SURFACE_ID = "slack";

type Emit = (e: InboundEvent) => void;

function encodeConversationId(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`;
}

/** The thread root ts for an encoded conversation id ("" -> no thread). */
function threadTsOf(conv: ConversationRef): string | undefined {
  if (!conv.conversationId) return undefined;
  const idx = conv.conversationId.indexOf(":");
  return idx === -1 ? conv.conversationId : conv.conversationId.slice(idx + 1);
}

/**
 * Resolve a linkified Slack user mention ("<@U0ABBY>" or "<@U0ABBY|abby>") to a
 * domain principal key ("slack:U0ABBY"). Returns null for plain text, a malformed
 * token, or a mention of the bot itself — so no raw Slack id shape ever crosses the
 * port, and a `grant` can never target Condotto. Built via `principalKey` so the key
 * format stays in lockstep with the core. Pure (no `this`) for unit testing.
 */
export function resolveUserMention(token: string, botUserId: string | null): string | null {
  const m = token.match(/^<@([A-Z0-9]+)(?:\|[^>]*)?>$/);
  if (!m) return null;
  if (botUserId && m[1] === botUserId) return null;
  return principalKey({ surface: SURFACE_ID, externalId: m[1]! });
}

/**
 * Parse an `@Condotto …` mention into a command (or null = conversation/help).
 * Pure and module-level (no `this`) so it is unit-testable without a live Bolt App.
 * Deliberately strict, arity-checked word forms so ordinary prose ("@Condotto take a
 * look at x.ts") is treated as conversation, not a command. The target of a
 * grant/revoke is a Slack `<@U…>` mention — read from the ORIGINAL-case `words`
 * (Slack ids are uppercase; `first/second/third` are lowercased) and resolved to a
 * principal key here, emitting the sentinel "?" when unresolved so the core can post
 * a precise error.
 */
export function parseMentionCommand(
  text: string,
  botUserId: string | null,
): { name: CommandName; args: string } | null {
  if (!botUserId) return null;
  const m = text.match(new RegExp(`^\\s*<@${botUserId}(?:\\|[^>]*)?>\\s*(.*)$`, "s"));
  if (!m) return null;
  const words = m[1]!.trim().split(/\s+/).filter(Boolean);
  const [first = "", second = "", third] = words.map((w) => w.toLowerCase());
  // `assign <repo>`, `assign <repo>/<sub-project>`, and the two-token
  // `assign <repo> <sub-project>` — people type both, and without the 3-word form
  // the mention would match no rule and be silently swallowed as conversation,
  // leaving the architect with no error at all. Original case is preserved (paths
  // and repo names are case-sensitive); the core splits repo from sub-project.
  if (first === "assign" && words.length <= 3) {
    return { name: "assign", args: words.slice(1).join(" ") };
  }
  if (first === "take" && second === "this" && third === undefined) return { name: "assign", args: "" };
  if (first === "stop" && words.length === 1) return { name: "stop", args: "" };
  if (first === "stop" && second === "clean" && words.length === 2) return { name: "stop", args: "clean" };
  // Interrupt the in-flight turn (e.g. a runaway workflow); the session lives on.
  if (first === "cancel" && words.length === 1) return { name: "cancel", args: "" };
  if (first === "status" && words.length === 1) return { name: "status", args: "" };
  if (first === "land" && words.length === 1) return { name: "land", args: "" };
  if (first === "deploy" && words.length === 1) return { name: "deploy", args: "" };
  if (first === "budget" && words.length === 2) return { name: "budget", args: words[1]! };
  if (first === "model" && words.length === 2) return { name: "model", args: words[1]! };
  if (first === "effort" && words.length === 2) return { name: "effort", args: words[1]! };
  if (first === "subagents" && words.length === 2) return { name: "subagents", args: words[1]! };
  if (first === "ultra" && words.length === 2) return { name: "ultra", args: words[1]! };
  // Single whitespace-free token, so `split(/\s+/)` keeps it intact.
  if (first === "auto-approve" && words.length === 2) return { name: "auto-approve", args: words[1]! };
  if (first === "workflows" && words.length === 2) return { name: "workflows", args: words[1]! };
  if (first === "workflows" && second === "write" && words.length === 3) {
    return { name: "workflows", args: `write ${words[2]!}` };
  }
  // Role delegation. args carry the resolved principal key (or "?") + the
  // lowercased remainder: grant -> "<key|?> <role> [everywhere]", revoke -> "<key|?> [everywhere]".
  if (first === "grant" && words.length >= 2 && words.length <= 4) {
    const target = resolveUserMention(words[1]!, botUserId) ?? "?";
    return { name: "grant", args: `${target} ${words.slice(2).map((w) => w.toLowerCase()).join(" ")}`.trim() };
  }
  if (first === "revoke" && words.length >= 2 && words.length <= 3) {
    const target = resolveUserMention(words[1]!, botUserId) ?? "?";
    return { name: "revoke", args: `${target} ${words.slice(2).map((w) => w.toLowerCase()).join(" ")}`.trim() };
  }
  // What the harness will dispatch in this thread.
  if (first === "skills" && words.length === 1) return { name: "skills", args: "" };
  // `@Condotto /<name> [args…]` — run a skill / slash command.
  //
  // A `/`-prefixed first word is its own namespace: no verb above starts with a
  // slash, so this can never shadow the ladder, and ordinary prose is unaffected
  // because the slash is not the FIRST CHARACTER of the message. That placement is
  // the whole reason for the mention-first spelling: Slack intercepts a message
  // that BEGINS with `/` as one of its own commands, and custom slash commands
  // cannot run inside a thread at all (DECISIONS 2026-07-18).
  //
  // The `/` is stripped here — the core speaks skill NAMES, and only the harness
  // adapter knows that Claude Code spells an invocation with a leading slash.
  // Arguments keep their original case and internal spacing (paths, flags, a commit
  // message); the core validates them, and refuses what it will not pass on.
  if (first.startsWith("/") && first.length > 1) {
    const rest = m[1]!.trim().slice(words[0]!.length).trim();
    const name = words[0]!.slice(1);
    return { name: "skill", args: rest ? `${name} ${rest}` : name };
  }
  return null;
}

/**
 * Slack delivers events at-least-once (retries on slow acks, reconnects), and
 * a duplicated message event would run a duplicate agent turn. Bounded
 * first-seen-wins memory of recent event keys.
 */
class DedupWindow {
  private seen = new Set<string>();
  private order: string[] = [];

  has(key: string): boolean {
    if (this.seen.has(key)) return true;
    this.seen.add(key);
    this.order.push(key);
    if (this.order.length > 2000) this.seen.delete(this.order.shift()!);
    return false;
  }
}

export class SlackAdapter implements SurfaceAdapter {
  readonly id = SURFACE_ID;
  readonly capabilities: SurfaceCapabilities = {
    threads: true,
    editMessages: true,
    buttons: true,
    attachments: true,
    identityStrength: "verified",
  };

  private app: App;
  private botUserId: string | null = null;
  private emit: Emit = () => {};
  private dedup = new DedupWindow();
  private names: DisplayNameCache | null = null;
  /**
   * Per-conversation tail of the name-resolution chain. Resolving a name is
   * async, so without serializing, two quick messages could emit out of order and
   * land in the session transcript reversed.
   */
  private nameTail = new Map<string, Promise<void>>();

  constructor(
    tokens: { botToken: string; appToken: string },
    private authority: SurfaceAuthority,
    private operator: OperatorConsole,
    private log: (msg: string) => void = console.log,
    /** Test seam: inject a name cache so `handleMessage` runs without a live client. */
    names?: DisplayNameCache,
  ) {
    this.names = names ?? null;
    this.app = new App({
      token: tokens.botToken,
      appToken: tokens.appToken,
      socketMode: true,
      // Without this, Bolt verifies the token from the CONSTRUCTOR, unawaited: a
      // bad token becomes an unhandled rejection nobody can catch or report.
      // Deferring moves it into `start()`, where a failure is ours to surface.
      deferInitialization: true,
    });
  }

  async start(emit: Emit): Promise<void> {
    this.emit = emit;

    // Deferred from the constructor so a bad token throws HERE, awaited.
    await this.app.init();

    const auth = await this.app.client.auth.test();
    this.botUserId = (auth.user_id as string) ?? null;
    // Needs the `users:read` scope. If it is missing, every lookup fails soft and
    // messages simply arrive without a display name.
    if (!this.names) this.names = new DisplayNameCache(slackUserSource(this.app.client as any));

    this.app.command("/condotto", async ({ command, ack, respond }) => {
      await ack();
      if (command.trigger_id && this.dedup.has(`cmd:${command.trigger_id}`)) return;
      try {
        await this.handleSlashCommand(command, respond);
      } catch (err) {
        this.log(`[slack] /condotto failed: ${err}`);
        await respond({
          response_type: "ephemeral",
          text: `Something went wrong: ${err instanceof Error ? err.message : err}`,
        }).catch(() => {});
      }
    });

    this.app.event("app_mention", async ({ event }) => {
      await this.handleMention(event as Record<string, any>);
    });

    this.app.event("message", async ({ event }) => {
      this.handleMessage(event as Record<string, any>);
    });

    const onDecision = async (args: any) => {
      await args.ack();
      try {
        await this.handleApprovalAction(args);
      } catch (err) {
        this.log(`[slack] approval action failed: ${err}`);
      }
    };
    this.app.action(APPROVE_ACTION, onDecision);
    this.app.action(DENY_ACTION, onDecision);

    // Guided-choice buttons: action_ids look like `condotto_choice:<value>`.
    this.app.action(new RegExp(`^${CHOICE_ACTION}:`), async (args: any) => {
      await args.ack();
      try {
        await this.handleChoiceAction(args);
      } catch (err) {
        this.log(`[slack] choice action failed: ${err}`);
      }
    });

    await this.app.start();
    this.log("[slack] Socket Mode connected");
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }

  // -- inbound --------------------------------------------------------------

  private async handleSlashCommand(
    command: Record<string, any>,
    respond: RespondFn,
  ): Promise<void> {
    const [sub = "", ...rest] = String(command.text ?? "").trim().split(/\s+/);
    const args = rest.join(" ");
    const author = { surface: SURFACE_ID, externalId: String(command.user_id) };
    const channelId = String(command.channel_id);

    // `/condotto status` (daemon-wide operator dashboard) and `/condotto stop`
    // (session list + how to stop in-thread) are EPHEMERAL operator-console
    // queries: the core renders the text, and we deliver it privately via
    // `respond` — never a public channel post (DESIGN §8-(5)).
    const ephemeral = slashEphemeralText(sub, author, channelId, this.operator);
    if (ephemeral !== null) {
      await respond({ response_type: "ephemeral", text: renderMrkdwn(ephemeral) });
      return;
    }

    switch (sub.toLowerCase()) {
      case "assign": {
        // A repo is required. Answer here rather than posting the anchor first:
        // the anchor is public and announces a session, so falling through to
        // the core's repo picker would leave a channel post advertising a
        // session that may never exist. In-thread `@Condotto assign` has no such
        // problem (the thread already exists) and still gets the picker.
        if (args.trim() === "") {
          await respond({
            response_type: "ephemeral",
            text:
              "Usage: `/condotto assign <repo>` — name the repo to work in (there is no default).\n" +
              "To see the configured repos, mention `@Condotto assign` inside an existing thread and pick from the list.",
          });
          return;
        }
        // Slash commands carry no thread context — create a fresh conversation
        // by posting an anchor message; its ts becomes the thread root.
        let anchorTs: string;
        try {
          const anchor = await this.app.client.chat.postMessage({
            channel: channelId,
            text: `🎫 New Condotto session (started by <@${author.externalId}>) — talk to me in this thread.`,
          });
          anchorTs = String(anchor.ts);
        } catch (err: any) {
          const reason =
            err?.data?.error === "not_in_channel"
              ? "I'm not in this channel — run `/invite @Condotto` first."
              : `couldn't post here (${err?.data?.error ?? err})`;
          await respond({ response_type: "ephemeral", text: reason });
          return;
        }
        this.emit({
          kind: "command",
          conv: {
            surfaceId: SURFACE_ID,
            channelId,
            conversationId: encodeConversationId(channelId, anchorTs),
          },
          author,
          name: "assign",
          args,
        });
        return;
      }
      default: {
        await respond({
          response_type: "ephemeral",
          text:
            "Usage: `/condotto assign <repo>` (new session in this channel), " +
            "`/condotto status` (operator dashboard — architects), " +
            "`/condotto stop` (list this channel's sessions).\n" +
            "Inside a session thread (mention me): `@Condotto stop`, `@Condotto cancel` (stop the running turn), " +
            "`@Condotto status`, `@Condotto land`/`deploy` (gated), `@Condotto budget <usd>`.\n" +
            "Tune the implementer: `@Condotto model <opus|sonnet|fable>`, `@Condotto effort <low…max>`, " +
            "`@Condotto subagents on|off`, `@Condotto workflows on|off`, `@Condotto ultra on|off`.\n" +
            "Run one of my skills: `@Condotto /<skill> [args]` — `@Condotto skills` lists them.\n" +
            "Approvals & roles: `@Condotto auto-approve on|off` (skip your own Approve clicks), " +
            "`@Condotto grant @user architect [everywhere]`, `@Condotto revoke @user`.\n" +
            "To assign an existing thread: `@Condotto assign <repo>` in that thread.",
        });
      }
    }
  }

  /**
   * Strict command forms only — anything looser is conversation, not a
   * command ("@Condotto take a look at src/x.ts" must reach the session, not
   * trigger an assign).
   */
  private mentionCommand(text: string): { name: CommandName; args: string } | null {
    // Parsing is a pure module-level function (unit-tested without a live App);
    // the mention forms, incl. those controls, live there.
    return parseMentionCommand(text, this.botUserId);
  }

  /**
   * A bare `@Condotto` or `@Condotto help`/`start` — a request for guidance rather
   * than a command or a conversational message. (Commands are matched first.)
   */
  private isHelpMention(text: string): boolean {
    if (!this.botUserId) return false;
    const m = text.match(new RegExp(`^\\s*<@${this.botUserId}(?:\\|[^>]*)?>\\s*(.*)$`, "s"));
    if (!m) return false;
    const rest = m[1]!.trim().toLowerCase().replace(/[?!.]+$/, "").trim();
    return rest === "" || /^help( me)?$/.test(rest) || rest === "start" || rest === "commands";
  }

  private mentioned(text: string): boolean {
    return !!this.botUserId && text.includes(`<@${this.botUserId}`);
  }

  private async handleMention(event: Record<string, any>): Promise<void> {
    if (!event.user || event.bot_id || event.user === this.botUserId) return;
    if (this.dedup.has(`mention:${event.channel}:${event.ts}`)) return;
    const text = String(event.text ?? "");
    const channelId = String(event.channel);
    const rootTs = String(event.thread_ts ?? event.ts);
    const author = { surface: SURFACE_ID, externalId: String(event.user) };
    const conv = { surfaceId: SURFACE_ID, channelId, conversationId: encodeConversationId(channelId, rootTs) };

    const cmd = this.mentionCommand(text);
    if (cmd) {
      this.emit({ kind: "command", conv, author, name: cmd.name, args: cmd.args });
      return;
    }
    // A bare/"help" mention, or ANY non-command mention at the top level (no
    // thread yet), is a request for guidance — root a thread if needed and let
    // the core guide (onboarding if unassigned, command summary if assigned). A
    // conversational mention INSIDE a thread instead flows through handleMessage.
    if (this.isHelpMention(text) || !event.thread_ts) {
      this.emit({ kind: "command", conv, author, name: "help", args: "" });
    }
  }

  private handleMessage(event: Record<string, any>): void {
    if (!event.user || event.bot_id || event.user === this.botUserId) return;
    const subtype = event.subtype as string | undefined;
    if (subtype && subtype !== "file_share" && subtype !== "thread_broadcast") return;
    if (!event.thread_ts) return; // sessions are threads; top-level chatter is not ours
    if (this.dedup.has(`msg:${event.channel}:${event.ts}`)) return;
    const text = String(event.text ?? "");
    if (this.mentionCommand(text)) return; // command mentions handled via app_mention
    if (this.isHelpMention(text)) return; // bare/help mentions handled via app_mention (as `help`)

    const attachments: Attachment[] = Array.isArray(event.files)
      ? event.files.map((f: Record<string, any>) => ({
          kind: String(f.mimetype ?? "").startsWith("image/") ? "image" as const : "file" as const,
          name: f.name ? String(f.name) : undefined,
        }))
      : [];

    const conv = {
      surfaceId: SURFACE_ID,
      channelId: String(event.channel),
      conversationId: encodeConversationId(String(event.channel), String(event.thread_ts)),
    };
    const author = { surface: SURFACE_ID, externalId: String(event.user) };
    const mentioned = this.mentioned(text);

    // Every sync guard above has already run, so nothing below can change whether
    // this message counts. Resolving the author's display name is best-effort:
    // the emit happens either way, and only the `authorDisplayName` decoration is
    // lost on failure. Chained per conversation so arrival order is preserved.
    const userId = String(event.user);
    const prev = this.nameTail.get(conv.conversationId) ?? Promise.resolve();
    // `tail` must reference ITSELF in the cleanup: the map holds the post-cleanup
    // promise, so comparing against the pre-cleanup one would never match and the
    // entry would leak for the daemon's lifetime (one per thread, forever).
    const tail: Promise<void> = prev
      .then(() => this.names?.get(userId))
      .catch(() => undefined)
      .then((authorDisplayName) => {
        this.emit({ kind: "message", conv, author, text, mentioned, attachments, authorDisplayName });
      })
      .then(() => {
        // Only the LAST message in a conversation clears the tail; an earlier one
        // finding a newer tail in place leaves it alone.
        if (this.nameTail.get(conv.conversationId) === tail) this.nameTail.delete(conv.conversationId);
      });
    this.nameTail.set(conv.conversationId, tail);
  }

  // -- outbound -------------------------------------------------------------

  async post(conv: ConversationRef, msg: OutboundMessage): Promise<PostedRef> {
    const res = await this.app.client.chat.postMessage({
      channel: conv.channelId,
      thread_ts: threadTsOf(conv),
      text: renderMrkdwn(msg.text),
    });
    return { conv, messageId: String(res.ts) };
  }

  async update(ref: PostedRef, msg: OutboundMessage): Promise<void> {
    await this.app.client.chat.update({
      channel: ref.conv.channelId,
      ts: ref.messageId,
      text: renderMrkdwn(msg.text),
    });
  }

  async requestChoice(conv: ConversationRef, prompt: ChoicePrompt): Promise<void> {
    const { text, blocks } = choiceBlocks(prompt);
    await this.app.client.chat.postMessage({
      channel: conv.channelId,
      thread_ts: threadTsOf(conv),
      text, // notification fallback; the blocks carry the interactive content
      blocks: blocks as any[],
    });
  }

  async requestApproval(conv: ConversationRef, req: ApprovalPrompt): Promise<void> {
    const { text, blocks } = approvalBlocks(req);
    await this.app.client.chat.postMessage({
      channel: conv.channelId,
      thread_ts: threadTsOf(conv),
      text, // notification fallback; the blocks carry the interactive content
      blocks: blocks as any[],
    });
  }

  /**
   * An Approve/Deny click. Bolt has already verified the request signature, so
   * `body.user.id` is a genuine platform identity. We do the ephemeral
   * "architects only" gate here for UX; the daemon re-verifies authority
   * server-side before it acts on the emitted decision (DESIGN.md §4).
   */
  private async handleApprovalAction(args: {
    body: Record<string, any>;
    client: { chat: { update: (o: Record<string, any>) => Promise<unknown> } };
    respond: RespondFn;
  }): Promise<void> {
    const { body, client, respond } = args;
    const action = (body.actions ?? [])[0] ?? {};
    const requestId = action.value ? String(action.value) : "";
    if (!requestId) return;
    // Slack delivers actions at-least-once; a click can also be double-fired.
    if (action.action_ts && this.dedup.has(`act:${action.action_ts}`)) return;

    const decider: Principal = { surface: SURFACE_ID, externalId: String(body.user?.id) };
    const channelId = String(body.channel?.id ?? body.container?.channel_id ?? "");
    const outcome: "approved" | "denied" = action.action_id === APPROVE_ACTION ? "approved" : "denied";
    this.log(`[slack] approval click: ${outcome} req=${requestId} by ${decider.externalId} ch=${channelId}`);

    if (!this.authority.isArchitect(decider, channelId)) {
      this.log(`[slack] click ignored — ${decider.externalId} is not an architect in ${channelId}`);
      await respond({
        response_type: "ephemeral",
        text: "Only architects can approve or deny — ignoring.",
      }).catch(() => {});
      return;
    }

    // Resolve the message: keep the detail, drop the buttons, record who decided.
    const resolved = resolveApprovalMessage(body.message?.blocks, outcome, decider.externalId);
    if (body.message?.ts) {
      await client.chat
        .update({ channel: channelId, ts: String(body.message.ts), text: resolved.text, blocks: resolved.blocks as any[] })
        .catch((err) => this.log(`[slack] could not update approval message: ${err}`));
    }

    this.emit({ kind: "approval_decision", requestId, decider, decision: outcome });
  }

  /**
   * A guided-choice button click, e.g. picking a repo to assign. Same
   * pattern as approvals: Bolt has verified the signature; we pre-check authority
   * for UX on architect-only choices, and the core re-verifies when it acts.
   */
  private async handleChoiceAction(args: {
    body: Record<string, any>;
    client: { chat: { update: (o: Record<string, any>) => Promise<unknown> } };
    respond: RespondFn;
  }): Promise<void> {
    const { body, client, respond } = args;
    const action = (body.actions ?? [])[0] ?? {};
    const value = action.value ? String(action.value) : "";
    const parsed = parseChoiceBlockId(action.block_id ? String(action.block_id) : undefined);
    if (!value || !parsed) return;
    if (action.action_ts && this.dedup.has(`choice:${action.action_ts}`)) return;

    const decider: Principal = { surface: SURFACE_ID, externalId: String(body.user?.id) };
    const channelId = String(body.channel?.id ?? body.container?.channel_id ?? "");
    // The choice message lives in the thread; its thread_ts is the root.
    const rootTs = String(body.message?.thread_ts ?? body.message?.ts ?? "");
    this.log(`[slack] choice click: ${parsed.choiceId}=${value} by ${decider.externalId} ch=${channelId}`);

    if (parsed.architectOnly && !this.authority.isArchitect(decider, channelId)) {
      // Leave the buttons so an architect can still choose.
      await respond({
        response_type: "ephemeral",
        text: "Only architects can choose this — ask one to pick.",
      }).catch(() => {});
      return;
    }

    // Resolve the message: drop the buttons, record who chose what.
    const label = action.text?.text ? String(action.text.text) : value;
    const resolved = resolveChoiceMessage(body.message?.blocks, label, decider.externalId);
    if (body.message?.ts) {
      await client.chat
        .update({ channel: channelId, ts: String(body.message.ts), text: resolved.text, blocks: resolved.blocks as any[] })
        .catch((err) => this.log(`[slack] could not update choice message: ${err}`));
    }

    this.emit({
      kind: "choice",
      conv: { surfaceId: SURFACE_ID, channelId, conversationId: encodeConversationId(channelId, rootTs) },
      author: decider,
      choiceId: parsed.choiceId,
      value,
    });
  }
}

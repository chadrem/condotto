import { App, type RespondFn } from "@slack/bolt";
import type {
  ApprovalPrompt,
  Attachment,
  ConversationRef,
  InboundEvent,
  OutboundMessage,
  PostedRef,
  SurfaceAdapter,
  SurfaceCapabilities,
} from "../../core/types";
import { renderMrkdwn } from "./render";

// Slack surface adapter: Bolt over Socket Mode (outbound WebSocket, no public
// URL — hard requirement, DESIGN.md §3). All Slack shapes (thread_ts, channel
// ids, Bolt payloads) stay inside this directory.
//
// Slack `ts` values are strings with significant leading zeros in the
// fractional part. They are NEVER parsed as numbers here.
//
// Verified live-doc fact (2026-07-18, contradicts DESIGN.md journey 1; logged
// in DECISIONS.md): custom slash commands CANNOT be invoked inside a message
// thread — the client only offers them at top level, and the payload carries
// no thread context. So:
//   /conduit assign        -> creates a NEW conversation: we post an anchor
//                             message and its ts becomes the thread root.
//   @Conduit assign        -> assigns the EXISTING thread the mention is in
//                             (app_mention events do carry thread_ts).
//   @Conduit stop|status   -> thread-scoped commands.

const SURFACE_ID = "slack";

type Emit = (e: InboundEvent) => void;

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

  constructor(
    tokens: { botToken: string; appToken: string },
    private log: (msg: string) => void = console.log,
  ) {
    this.app = new App({
      token: tokens.botToken,
      appToken: tokens.appToken,
      socketMode: true,
    });
  }

  async start(emit: Emit): Promise<void> {
    this.emit = emit;

    const auth = await this.app.client.auth.test();
    this.botUserId = (auth.user_id as string) ?? null;

    this.app.command("/conduit", async ({ command, ack, respond }) => {
      await ack();
      try {
        await this.handleSlashCommand(command, respond);
      } catch (err) {
        this.log(`[slack] /conduit failed: ${err}`);
        await respond({
          response_type: "ephemeral",
          text: `Something went wrong: ${err instanceof Error ? err.message : err}`,
        }).catch(() => {});
      }
    });

    this.app.event("app_mention", async ({ event }) => {
      this.handleMention(event as Record<string, any>);
    });

    this.app.event("message", async ({ event }) => {
      this.handleMessage(event as Record<string, any>);
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

    switch (sub.toLowerCase()) {
      case "assign": {
        // Slash commands carry no thread context — create a fresh conversation
        // by posting an anchor message; its ts becomes the thread root.
        let anchorTs: string;
        try {
          const anchor = await this.app.client.chat.postMessage({
            channel: channelId,
            text: `🎫 New Conduit session (started by <@${author.externalId}>) — talk to me in this thread.`,
          });
          anchorTs = String(anchor.ts);
        } catch (err: any) {
          const reason =
            err?.data?.error === "not_in_channel"
              ? "I'm not in this channel — run `/invite @Conduit` first."
              : `couldn't post here (${err?.data?.error ?? err})`;
          await respond({ response_type: "ephemeral", text: reason });
          return;
        }
        this.emit({
          kind: "command",
          conv: { surfaceId: SURFACE_ID, channelId, conversationId: anchorTs },
          author,
          name: "assign",
          args,
        });
        return;
      }
      case "status": {
        this.emit({
          kind: "command",
          conv: { surfaceId: SURFACE_ID, channelId, conversationId: "" },
          author,
          name: "status",
          args,
        });
        return;
      }
      case "stop": {
        // Slash commands can't run inside threads, so there is no thread to stop.
        await respond({
          response_type: "ephemeral",
          text: "To stop a session, mention me inside its thread: `@Conduit stop`.",
        });
        return;
      }
      default: {
        await respond({
          response_type: "ephemeral",
          text:
            "Usage: `/conduit assign [repo]` (new session in this channel), " +
            "`/conduit status`. Inside a session thread: `@Conduit stop`. " +
            "To assign an existing thread: `@Conduit assign` in that thread.",
        });
      }
    }
  }

  private mentionCommand(text: string): { name: "assign" | "stop" | "status"; args: string } | null {
    if (!this.botUserId) return null;
    const m = text.match(new RegExp(`^\\s*<@${this.botUserId}>\\s*(.*)$`, "s"));
    if (!m) return null;
    const [word = "", ...rest] = m[1]!.trim().split(/\s+/);
    switch (word.toLowerCase()) {
      case "assign":
      case "take":
        return { name: "assign", args: rest.filter((w) => w !== "this").join(" ") };
      case "stop":
        return { name: "stop", args: rest.join(" ") };
      case "status":
        return { name: "status", args: rest.join(" ") };
      default:
        return null;
    }
  }

  private handleMention(event: Record<string, any>): void {
    if (!event.user || event.user === this.botUserId) return;
    const cmd = this.mentionCommand(String(event.text ?? ""));
    if (!cmd) return; // plain mentions flow through the message handler as turns
    // Mentions DO carry thread context; a top-level mention roots its own thread.
    const conversationId = String(event.thread_ts ?? event.ts);
    this.emit({
      kind: "command",
      conv: {
        surfaceId: SURFACE_ID,
        channelId: String(event.channel),
        conversationId,
      },
      author: { surface: SURFACE_ID, externalId: String(event.user) },
      name: cmd.name,
      args: cmd.args,
    });
  }

  private handleMessage(event: Record<string, any>): void {
    if (!event.user || event.bot_id || event.user === this.botUserId) return;
    const subtype = event.subtype as string | undefined;
    if (subtype && subtype !== "file_share" && subtype !== "thread_broadcast") return;
    if (!event.thread_ts) return; // sessions are threads; top-level chatter is not ours
    const text = String(event.text ?? "");
    if (this.mentionCommand(text)) return; // command mentions are handled via app_mention

    const attachments: Attachment[] = Array.isArray(event.files)
      ? event.files.map((f: Record<string, any>) => ({
          kind: String(f.mimetype ?? "").startsWith("image/") ? "image" as const : "file" as const,
          name: f.name ? String(f.name) : undefined,
        }))
      : [];

    this.emit({
      kind: "message",
      conv: {
        surfaceId: SURFACE_ID,
        channelId: String(event.channel),
        conversationId: String(event.thread_ts),
      },
      author: { surface: SURFACE_ID, externalId: String(event.user) },
      text,
      attachments,
    });
  }

  // -- outbound -------------------------------------------------------------

  async post(conv: ConversationRef, msg: OutboundMessage): Promise<PostedRef> {
    const res = await this.app.client.chat.postMessage({
      channel: conv.channelId,
      thread_ts: conv.conversationId || undefined,
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

  async requestApproval(conv: ConversationRef, req: ApprovalPrompt): Promise<void> {
    // M2 renders Approve/Deny buttons (block_actions verified server-side).
    await this.post(conv, { text: `Approval needed (M2, not yet wired): ${req.summary}` });
  }
}

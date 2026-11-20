// A minimal Slack Web API client for the e2e driver, over plain fetch.
//
// Deliberately not Bolt's transitive @slack/web-api: the driver should depend on
// Slack's wire format, not on the package whose upgrades it exists to catch.
// Every method takes form-encoded arguments, so one call shape covers them all.

export interface SlackFile {
  id: string;
  name?: string;
}

export interface SlackMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  thread_ts?: string;
  files?: SlackFile[];
  edited?: { ts: string };
}

type Args = Record<string, string | number | boolean | object | undefined>;

export class SlackError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`Slack ${method} failed: ${code}`);
  }
}

export class SlackApi {
  constructor(private readonly token: string) {}

  async call<T = Record<string, unknown>>(method: string, args: Args = {}): Promise<T> {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(args)) {
      if (v === undefined) continue;
      body.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}` },
        body,
      });
      if (res.status === 429 && attempt < 5) {
        const wait = Number(res.headers.get("retry-after") ?? "1");
        await Bun.sleep(Math.max(1, wait) * 1000);
        continue;
      }
      const json = (await res.json()) as { ok: boolean; error?: string } & T;
      if (!json.ok) throw new SlackError(method, json.error ?? `HTTP ${res.status}`);
      return json;
    }
  }

  /** The token's own user id (a bot token's bot user, or a user token's human). */
  async whoAmI(): Promise<string> {
    const r = await this.call<{ user_id: string }>("auth.test");
    return r.user_id;
  }

  async post(channel: string, text: string, threadTs?: string): Promise<string> {
    const r = await this.call<{ ts: string }>("chat.postMessage", { channel, text, thread_ts: threadTs });
    return r.ts;
  }

  /** Every message in a thread, the root first. */
  async replies(channel: string, threadTs: string): Promise<SlackMessage[]> {
    const out: SlackMessage[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.call<{ messages: SlackMessage[]; response_metadata?: { next_cursor?: string } }>(
        "conversations.replies",
        { channel, ts: threadTs, limit: 200, cursor },
      );
      out.push(...r.messages);
      cursor = r.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return out;
  }

  async permalink(channel: string, ts: string): Promise<string> {
    const r = await this.call<{ permalink: string }>("chat.getPermalink", { channel, message_ts: ts });
    return r.permalink;
  }

  /**
   * Upload a file into a thread the way a person drops one in: the external-upload
   * flow, with the message text as the share's initial comment.
   */
  async upload(channel: string, threadTs: string, filename: string, content: string, text: string): Promise<void> {
    const bytes = new TextEncoder().encode(content);
    const slot = await this.call<{ upload_url: string; file_id: string }>("files.getUploadURLExternal", {
      filename,
      length: bytes.byteLength,
    });
    const put = await fetch(slot.upload_url, { method: "POST", body: bytes });
    if (!put.ok) throw new Error(`file upload to Slack failed: HTTP ${put.status}`);
    await this.call("files.completeUploadExternal", {
      files: [{ id: slot.file_id, title: filename }],
      channel_id: channel,
      thread_ts: threadTs,
      initial_comment: text,
    });
  }
}

// Display-name resolution for the Slack surface. Lives in the adapter because a
// display name is a Slack profile concept; the core receives it as the domain
// field `InboundEvent.authorDisplayName` and treats it as decoration only.
//
// Why this exists: without it, the framed header the agent reads carries only
// `user=slack:U0ABBY`, so the agent's ONLY handle on a human is the raw id — and
// it echoes that into replies (the raw-id bug). A name lets
// it address people naturally and reserves the mention token for real pings.
//
// SECURITY: a display name is attacker-chosen free text. It never carries
// authority — approvals resolve against a server-verified Principal, the gate is
// mechanical, and `framing.sanitizeDisplayName` strips anything that could forge a
// header field or a mention token before it reaches the model.

/** Where names come from. Injected so the cache is testable without a live Slack. */
export type DisplayNameSource = (userId: string) => Promise<string | null>;

export interface DisplayNameCacheOptions {
  /** How long a resolved (or absent) name is trusted. Default 6h. */
  ttlMs?: number;
  /** Max distinct users held; oldest insertion evicted first. Default 2000. */
  max?: number;
  /** Per-lookup ceiling. A name must never delay or drop a message. Default 1.5s. */
  timeoutMs?: number;
}

/**
 * A bounded, single-flight, TTL cache over `users.info`.
 *
 * Degradation is the design: on timeout, API error, or a missing profile it
 * resolves `undefined` and the message flows on nameless. It NEVER falls back to
 * the user id — an id in the name slot is precisely the bug this fixes.
 */
export class DisplayNameCache {
  private map = new Map<string, { name: string | null; at: number }>();
  private inflight = new Map<string, Promise<string | null>>();
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly timeoutMs: number;

  constructor(
    private source: DisplayNameSource,
    opts: DisplayNameCacheOptions = {},
    private now: () => number = Date.now,
  ) {
    this.ttlMs = opts.ttlMs ?? 6 * 60 * 60 * 1000;
    this.max = opts.max ?? 2000;
    this.timeoutMs = opts.timeoutMs ?? 1500;
  }

  async get(userId: string): Promise<string | undefined> {
    const hit = this.map.get(userId);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.name ?? undefined;

    // Single-flight: a burst of messages from one person is one API call.
    let pending = this.inflight.get(userId);
    if (!pending) {
      pending = this.fetch(userId);
      this.inflight.set(userId, pending);
      // Settle the in-flight entry regardless of outcome; `fetch` never rejects.
      pending.finally(() => {
        if (this.inflight.get(userId) === pending) this.inflight.delete(userId);
      });
    }
    const name = await pending;
    return name ?? undefined;
  }

  /** Resolve one id. Never rejects; a failure yields null and is not cached. */
  private async fetch(userId: string): Promise<string | null> {
    // A tagged result rather than sentinels, so "the lookup did not complete" is
    // distinguishable from "the lookup says there is no name" — the first must
    // not be cached, the second must be.
    type Outcome = { done: true; raw: string | null } | { done: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<Outcome>((resolve) => {
      timer = setTimeout(() => resolve({ done: false }), this.timeoutMs);
    });
    try {
      const result = await Promise.race<Outcome>([
        this.source(userId).then(
          (raw) => ({ done: true, raw }),
          () => ({ done: false }),
        ),
        timeout,
      ]);
      // A timeout or an error is transient — don't cache it, or one blip poisons
      // this user's name for the whole TTL.
      if (!result.done) return null;
      const name = result.raw === null ? null : normalizeName(result.raw);
      // A genuine "no usable name" IS cached (negative caching), so a deleted or
      // unreadable account doesn't re-hit the API on every single message.
      this.remember(userId, name);
      return name;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private remember(userId: string, name: string | null): void {
    // Re-insert so refreshed entries move to the back of the eviction order.
    this.map.delete(userId);
    this.map.set(userId, { name, at: this.now() });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }
}

/** Trim and reject empties. Never returns a user id — that is the bug. */
function normalizeName(raw: string): string | null {
  const s = raw.trim();
  return s.length > 0 ? s : null;
}

/**
 * Build a source backed by Slack's `users.info` (scope: `users:read`). Preference
 * order is what a human would recognize: the name they chose, then their real
 * name, then the handle.
 */
export function slackUserSource(
  client: { users: { info: (a: { user: string }) => Promise<any> } },
): DisplayNameSource {
  return async (userId: string) => {
    const res = await client.users.info({ user: userId });
    const user = res?.user;
    if (!user) return null;
    const p = user.profile ?? {};
    const candidate = p.display_name || p.real_name || user.name || "";
    return typeof candidate === "string" && candidate.trim() ? candidate : null;
  };
}

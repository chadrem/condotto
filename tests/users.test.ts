import { describe, expect, test } from "bun:test";

import { DisplayNameCache, slackUserSource } from "../src/adapters/slack/users";

/** A source that records every call, so "one API call" is an assertion, not a hope. */
function countingSource(fn: (userId: string) => Promise<string | null>) {
  const calls: string[] = [];
  const source = (userId: string) => {
    calls.push(userId);
    return fn(userId);
  };
  return { source, calls };
}

/** Manual clock. TTL is a policy decision, not a reason to make tests slow. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("DisplayNameCache", () => {
  test("a second lookup for the same user hits the cache, not the API", async () => {
    const { source, calls } = countingSource(async () => "Abby");
    const cache = new DisplayNameCache(source, {}, fakeClock().now);

    expect(await cache.get("U0ABBY")).toBe("Abby");
    expect(await cache.get("U0ABBY")).toBe("Abby");
    expect(calls).toEqual(["U0ABBY"]);
  });

  test("distinct users are cached independently", async () => {
    const { source, calls } = countingSource(async (id) => `name-${id}`);
    const cache = new DisplayNameCache(source, {}, fakeClock().now);

    expect(await cache.get("U1")).toBe("name-U1");
    expect(await cache.get("U2")).toBe("name-U2");
    expect(await cache.get("U1")).toBe("name-U1");
    expect(calls).toEqual(["U1", "U2"]);
  });

  test("an entry older than the TTL is refetched", async () => {
    const clock = fakeClock();
    let n = 0;
    const { source, calls } = countingSource(async () => `Abby${++n}`);
    const cache = new DisplayNameCache(source, { ttlMs: 1000 }, clock.now);

    expect(await cache.get("U0ABBY")).toBe("Abby1");
    clock.advance(999);
    expect(await cache.get("U0ABBY")).toBe("Abby1"); // still inside the TTL
    clock.advance(2);
    expect(await cache.get("U0ABBY")).toBe("Abby2"); // past it — a fresh read
    expect(calls.length).toBe(2);
  });

  test("a burst of concurrent lookups for one user is a single API call", async () => {
    let release!: (name: string | null) => void;
    const gate = new Promise<string | null>((r) => (release = r));
    const { source, calls } = countingSource(() => gate);
    const cache = new DisplayNameCache(source, {}, fakeClock().now);

    const all = Promise.all(Array.from({ length: 20 }, () => cache.get("U0ABBY")));
    release("Abby");
    expect(await all).toEqual(Array(20).fill("Abby"));
    expect(calls).toEqual(["U0ABBY"]);
  });

  test("a user with no usable name is negatively cached", async () => {
    const { source, calls } = countingSource(async () => null);
    const cache = new DisplayNameCache(source, {}, fakeClock().now);

    expect(await cache.get("U0GONE")).toBeUndefined();
    expect(await cache.get("U0GONE")).toBeUndefined();
    expect(calls).toEqual(["U0GONE"]); // a deleted account doesn't re-hit the API
  });

  test("a rejecting source degrades to undefined and is retried later", async () => {
    let fail = true;
    const { source, calls } = countingSource(async () => {
      if (fail) throw new Error("ratelimited");
      return "Abby";
    });
    const cache = new DisplayNameCache(source, {}, fakeClock().now);

    expect(await cache.get("U0ABBY")).toBeUndefined();
    fail = false;
    // A transient blip must not poison the name for the whole TTL.
    expect(await cache.get("U0ABBY")).toBe("Abby");
    expect(calls.length).toBe(2);
  });

  test("a hung source resolves undefined at the timeout and is not cached", async () => {
    let hang = true;
    const { source, calls } = countingSource(
      (): Promise<string | null> =>
        hang ? new Promise<string | null>(() => {}) : Promise.resolve("Abby"),
    );
    const cache = new DisplayNameCache(source, { timeoutMs: 10 }, fakeClock().now);

    expect(await cache.get("U0ABBY")).toBeUndefined();
    hang = false;
    expect(await cache.get("U0ABBY")).toBe("Abby");
    expect(calls.length).toBe(2);
  });

  test("a slow-but-inside-the-timeout source still resolves", async () => {
    const { source } = countingSource(
      () => new Promise<string | null>((r) => setTimeout(() => r("Abby"), 5)),
    );
    const cache = new DisplayNameCache(source, { timeoutMs: 200 }, fakeClock().now);

    expect(await cache.get("U0ABBY")).toBe("Abby");
  });

  test("the cache is bounded: a third user evicts the oldest", async () => {
    const { source, calls } = countingSource(async (id) => `name-${id}`);
    const cache = new DisplayNameCache(source, { max: 2 }, fakeClock().now);

    await cache.get("U1");
    await cache.get("U2");
    await cache.get("U3"); // evicts U1
    expect(calls).toEqual(["U1", "U2", "U3"]);

    await cache.get("U2"); // still resident
    expect(calls.length).toBe(3);
    await cache.get("U1"); // gone — refetched
    expect(calls).toEqual(["U1", "U2", "U3", "U1"]);
  });

  test("a refreshed entry moves to the back of the eviction order", async () => {
    const clock = fakeClock();
    const { source, calls } = countingSource(async (id) => `name-${id}`);
    const cache = new DisplayNameCache(source, { max: 2, ttlMs: 100 }, clock.now);

    await cache.get("U1");
    await cache.get("U2");
    clock.advance(101);
    await cache.get("U1"); // refetch re-inserts U1 behind U2
    await cache.get("U3"); // so U2 is the oldest and goes
    await cache.get("U1");
    expect(calls).toEqual(["U1", "U2", "U1", "U3"]); // U1 served from cache
  });

  test("names are trimmed and a whitespace-only name counts as no name", async () => {
    const cache = new DisplayNameCache(
      async (id) => (id === "U1" ? "  Abby Jones \n" : "   "),
      {},
      fakeClock().now,
    );

    expect(await cache.get("U1")).toBe("Abby Jones");
    expect(await cache.get("U2")).toBeUndefined();
  });

  test("get never returns the user id in the name slot", async () => {
    // The original bug: a raw id leaking into user-facing text. Every degraded
    // path must yield undefined, never the id.
    const cases: Array<[string, () => Promise<string | null>]> = [
      ["missing", async () => null],
      ["empty", async () => ""],
      ["blank", async () => "\t \n"],
      ["error", async () => { throw new Error("boom"); }],
      ["hang", () => new Promise<string | null>(() => {})],
    ];
    for (const [label, fn] of cases) {
      const cache = new DisplayNameCache(fn, { timeoutMs: 10 }, fakeClock().now);
      const got = await cache.get("U0ABBY");
      expect(got, label).toBeUndefined();
      expect(got, label).not.toBe("U0ABBY");
    }
  });
});

describe("slackUserSource", () => {
  const stub = (user: unknown) => ({ users: { info: async () => ({ user }) } });

  test("prefers the name the human chose over real_name and the handle", async () => {
    const src = slackUserSource(
      stub({ name: "abby", profile: { display_name: "Abby!", real_name: "Abigail Jones" } }),
    );
    expect(await src("U0ABBY")).toBe("Abby!");
  });

  test("falls back to real_name when display_name is unset", async () => {
    const src = slackUserSource(
      stub({ name: "abby", profile: { display_name: "", real_name: "Abigail Jones" } }),
    );
    expect(await src("U0ABBY")).toBe("Abigail Jones");
  });

  test("falls back to the handle when the profile carries no names", async () => {
    const src = slackUserSource(stub({ name: "abby", profile: {} }));
    expect(await src("U0ABBY")).toBe("abby");
  });

  test("tolerates a user object with no profile at all", async () => {
    const src = slackUserSource(stub({ name: "abby" }));
    expect(await src("U0ABBY")).toBe("abby");
  });

  test("a whitespace-only candidate is no name, not a blank name", async () => {
    const src = slackUserSource(stub({ name: "   ", profile: {} }));
    expect(await src("U0ABBY")).toBeNull();
  });

  test("a missing user yields null rather than an id-shaped guess", async () => {
    const src = slackUserSource(stub(undefined));
    expect(await src("U0GONE")).toBeNull();
  });
});

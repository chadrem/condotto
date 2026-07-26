// Remote control end to end, against the real claude.ai session service.
//
// What this proves that `bun test` cannot: the bridge API is `@alpha` and its
// maintainers state that breaking changes do NOT bump the package major, so a routine
// `bun install` can silently change the shapes Condotto depends on. The unit tests use
// a fake harness and would stay green through all of it. This is the early warning.
//
// Phases, in the order the daemon does them:
//   1. read the operator's claude.ai credential from the OS credential store
//   2. create a code session, mint worker credentials, attach the bridge
//   3. write a transcript line and close the turn (the outbound mirror)
//   4. OPTIONALLY wait for a message typed in the Claude app (the inbound path)
//   5. close, and prove the handle round-trips
//
// The assertions are against what the SERVICE returned, not against our own types. A
// shape that drifted is exactly the failure this has to catch.
//
//   Run: bun run smoke:remote                (phases 1-3, 5 — no human needed)
//        CONDOTTO_SMOKE_INTERACTIVE=1 bun run smoke:remote   (adds phase 4)
//
// Needs a working `claude auth login` on this host. Costs no model tokens — nothing
// here runs a turn.

import { RemoteBridges, type RemoteHandle } from "../src/adapters/claude-code/remote";
import type { RemoteControlSink } from "../src/core/types";

const INTERACTIVE = process.env.CONDOTTO_SMOKE_INTERACTIVE === "1";
const WAIT_MS = Number(process.env.CONDOTTO_SMOKE_WAIT_MS ?? 120_000);

// Every claim has to hold for a PASS.
let published = false;
let urlLooksRight = false;
let handleRoundTrips = false;
let mirrorAccepted = false;
let idempotent = false;
let closedCleanly = false;
let inboundSeen = false;

const inbound: string[] = [];
const sink: RemoteControlSink = {
  onRemoteInput: (text) => {
    inbound.push(text);
    inboundSeen = true;
    console.log(`[smoke] INBOUND: ${JSON.stringify(text)}`);
  },
  onClosed: (reason) => console.log(`[smoke] bridge closed: ${reason}`),
};

// The key the adapter uses is the worktree root. Nothing is written to it here — the
// bridge never touches the filesystem — so the repo root stands in fine.
const KEY = process.cwd();
const bridges = new RemoteBridges({ mode: "subscription" });

console.log("\n=== phase 1-2: credential, create, attach ===");
const result = await bridges.enable(KEY, { name: "condotto smoke — safe to delete", sink });

if (!result.ok) {
  console.error(`[smoke] FAIL could not publish: ${result.reason}`);
  console.error("[smoke] If this names auth, run `claude auth login` on this host and retry.");
  process.exit(1);
}
published = true;
console.log(`[smoke] published: ${result.url}`);

// The url is what gets posted into a thread, so a shape change here is user-visible.
urlLooksRight = /^https:\/\/claude\.ai\/code\/cse_[A-Za-z0-9]+$/.test(result.url);
console.log(`[smoke] url shape (https://claude.ai/code/cse_…): ${urlLooksRight}`);

// The handle is persisted verbatim into `sessions.remote_control` and handed back on
// re-attach, so it has to survive a JSON round trip with the fields the adapter reads.
try {
  const h = JSON.parse(result.handle) as RemoteHandle;
  handleRoundTrips = h.v === 1 && typeof h.remoteSessionId === "string" && h.remoteSessionId.startsWith("cse_") && typeof h.seq === "number";
  console.log(`[smoke] handle: v=${h.v} id=${h.remoteSessionId.slice(0, 12)}… seq=${h.seq}`);
} catch (err) {
  console.error(`[smoke] handle is not JSON: ${err}`);
}
console.log(`[smoke] handle round-trips: ${handleRoundTrips}`);

console.log("\n=== phase 2b: enabling twice is idempotent ===");
const again = await bridges.enable(KEY, { name: "condotto smoke — safe to delete", sink });
idempotent = again.ok && again.url === result.url;
console.log(`[smoke] same url, no second remote session: ${idempotent}`);

console.log("\n=== phase 3: outbound mirror ===");
// Exactly the shape the adapter forwards from the turn loop.
bridges.write(KEY, {
  type: "assistant",
  uuid: crypto.randomUUID(),
  session_id: JSON.parse(result.handle).remoteSessionId,
  parent_tool_use_id: null,
  message: {
    id: `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [{ type: "text", text: "Condotto smoke test. If you can read this in the Claude app, outbound mirroring works." }],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  },
});
bridges.endTurn(KEY);
// `write`/`endTurn` swallow their own failures by contract (a wedged bridge must never
// cost a turn), so "accepted" here means the bridge is still live afterwards — which is
// the property that actually matters to a turn.
mirrorAccepted = bridges.isLive(KEY);
console.log(`[smoke] bridge still live after write + endTurn: ${mirrorAccepted}`);

if (INTERACTIVE) {
  console.log("\n=== phase 4: inbound ===");
  console.log("  Open claude.ai/code or the Claude app.");
  console.log(`  Find "condotto smoke — safe to delete" and type anything into it.`);
  console.log(`  Waiting ${Math.round(WAIT_MS / 1000)}s…`);
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until && !inboundSeen) await new Promise((r) => setTimeout(r, 500));
  console.log(`[smoke] inbound messages seen: ${inbound.length}`);
} else {
  console.log("\n=== phase 4: inbound — SKIPPED (set CONDOTTO_SMOKE_INTERACTIVE=1) ===");
}

console.log("\n=== phase 5: close ===");
await bridges.disable(KEY);
closedCleanly = !bridges.isLive(KEY);
console.log(`[smoke] closed: ${closedCleanly}`);

console.log("");
console.log(`[smoke] published:           ${published}`);
console.log(`[smoke] url shape:           ${urlLooksRight}`);
console.log(`[smoke] handle round-trips:  ${handleRoundTrips}`);
console.log(`[smoke] idempotent enable:   ${idempotent}`);
console.log(`[smoke] mirror accepted:     ${mirrorAccepted}`);
console.log(`[smoke] closed cleanly:      ${closedCleanly}`);
if (INTERACTIVE) console.log(`[smoke] inbound received:    ${inboundSeen}`);

const ok =
  published &&
  urlLooksRight &&
  handleRoundTrips &&
  idempotent &&
  mirrorAccepted &&
  closedCleanly &&
  (!INTERACTIVE || inboundSeen);

if (!ok) {
  console.error("\n[smoke] FAIL — see the checks above.");
  console.error("[smoke] A shape failure most likely means the @alpha bridge API moved under us.");
  process.exit(1);
}
console.log("\n[smoke] PASS — the claude.ai session service accepted a publication from this");
console.log("host's own credential, the url and persisted handle are the shapes the daemon");
console.log("relies on, enabling twice reuses one remote session, the outbound mirror is");
console.log("accepted, and the bridge closes on request.");
console.log("[smoke] The session may still be listed on claude.ai — delete it there.");
process.exit(0);

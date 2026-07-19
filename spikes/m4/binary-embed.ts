// M4 §2 spike phase 2: prove the SDK's blessed single-binary path.
//
// The compiled binary bundles the SDK's JS but NOT its native `claude`
// subprocess (a 236MB optional per-platform package). The SDK ships
// `@anthropic-ai/claude-agent-sdk/extract` to close exactly this gap:
//   1. embed the native CLI with `import … with { type: "file" }`
//      (Bun bakes the bytes into the binary; at runtime the import yields a
//      `/$bunfs/root/...` path a child process CANNOT exec),
//   2. `extractFromBunfs(path)` copies it to a real temp path,
//   3. pass that as `options.pathToClaudeCodeExecutable`.
//
// This entrypoint statically imports the darwin-arm64 package because the spike
// host IS darwin-arm64; the shippable adapter selects the platform package at
// build time (see DECISIONS.md M4 §2).
//
// Build: bun build --compile spikes/m4/binary-embed.ts --outfile /tmp/conduit-embed
// Run:   /tmp/conduit-embed

// @ts-expect-error — Bun `type: "file"` embed import; darwin-arm64-only in this spike.
import claudeEmbeddedPath from "@anthropic-ai/claude-agent-sdk-darwin-arm64/claude" with { type: "file" };
import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fail(msg: string): never {
  console.error(`[embed] FAIL: ${msg}`);
  process.exit(1);
}

console.log("[embed] embedded path:", claudeEmbeddedPath);
const isBunfs = String(claudeEmbeddedPath).includes("$bunfs") || String(claudeEmbeddedPath).includes("~BUN");
console.log("[embed] running inside compiled binary ($bunfs)?", isBunfs);

const exe = extractFromBunfs(claudeEmbeddedPath as unknown as string);
console.log("[embed] extracted CLI path:", exe);
if (!existsSync(exe)) fail(`extracted CLI path does not exist: ${exe}`);

const cwd = mkdtempSync(join(tmpdir(), "conduit-embed-"));
let subtype = "";
let reply = "";
let cost: number | undefined;
for await (const m of query({
  prompt: "Reply with exactly the single word READY and nothing else. Do not use any tools.",
  options: {
    cwd,
    pathToClaudeCodeExecutable: exe,
    systemPrompt: { type: "preset", preset: "claude_code", append: "You are a headless smoke test." },
    model: "claude-haiku-4-5-20251001",
    maxBudgetUsd: 0.5,
  },
} as { prompt: unknown; options: Record<string, unknown> }) as AsyncIterable<Record<string, any>>) {
  if (m.type === "result") {
    subtype = m.subtype ?? "";
    if (typeof m.total_cost_usd === "number") cost = m.total_cost_usd;
    if (typeof m.result === "string") reply = m.result;
  }
}
console.log(`[embed] sdk result: subtype=${subtype} cost=$${cost ?? "?"} reply=${JSON.stringify(reply.trim())}`);
if (subtype !== "success") fail(`sdk query ended with subtype "${subtype}"`);
if (!/READY/i.test(reply)) fail(`sdk reply did not contain READY: ${JSON.stringify(reply)}`);
console.log("[embed] PASS — embedded native CLI extracted from $bunfs and drove a headless query");
process.exit(0);

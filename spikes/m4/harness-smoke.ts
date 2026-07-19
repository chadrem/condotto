// M4 §2 verification: prove the SHIPPED claude-code adapter's sidecar CLI
// resolution works inside a `bun build --compile` binary — i.e. the real release
// path (condotto + a `claude` sidecar), not just the isolated spike.
//
// Build: bun build --compile spikes/m4/harness-smoke.ts --outfile <dir>/harness-smoke
// Setup: put a `claude` next to it (symlink is fine), then run with no key:
//        env -u ANTHROPIC_API_KEY <dir>/harness-smoke
//
// The compiled binary triggers resolveClaudeCliPath() → finds `claude` beside
// process.execPath → passes it as pathToClaudeCodeExecutable. A successful reply
// proves the adapter's own resolution, unchanged from what the daemon runs.

import { ClaudeCodeAdapter } from "../../src/adapters/claude-code/adapter";
import type { GateDecision } from "../../src/core/types";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const adapter = new ClaudeCodeAdapter();
const cwd = mkdtempSync(join(tmpdir(), "condotto-harness-"));
const session = await adapter.create({ cwd, system: "You are a headless smoke test." });
const gate = async (): Promise<GateDecision> => ({ decision: "allow" });

let reply = "";
for await (const ev of session.turn(
  {
    text: "Reply with exactly the single word READY and nothing else. Do not use any tools.",
    budgetUsd: 0.5,
    harness: { model: "sonnet" },
  },
  gate,
)) {
  if (ev.kind === "reply") reply = ev.text;
  if (ev.kind === "error") {
    console.error("[harness] error:", ev.message);
    process.exit(1);
  }
}
console.log("[harness] reply:", JSON.stringify(reply.trim()));
if (!/READY/i.test(reply)) {
  console.error("[harness] FAIL: reply did not contain READY");
  process.exit(1);
}
console.log("[harness] PASS — shipped adapter drove a headless turn via the sidecar CLI");
process.exit(0);

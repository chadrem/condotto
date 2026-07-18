// Port-boundary check (DESIGN.md §7 "port erosion"): platform imports are
// allowed only under src/adapters/. A Slack or Agent SDK type in the core is a
// review-blocking bug even while each seam has a single adapter.
//
// Also enforced: no `thread_ts` (or other Slack wire names) leaking into core.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");
const ADAPTERS_PREFIX = join("src", "adapters") + "/";

const FORBIDDEN_IMPORTS = ["@slack/", "@anthropic-ai/claude-agent-sdk"];
const FORBIDDEN_CORE_TOKENS = ["thread_ts", "block_actions", "xoxb-", "xapp-"];

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (name.endsWith(".ts")) yield full;
  }
}

export function checkPorts(): string[] {
  const violations: string[] = [];
  for (const file of walk(SRC)) {
    const rel = relative(ROOT, file);
    if (rel.startsWith(ADAPTERS_PREFIX)) continue;
    const source = readFileSync(file, "utf8");
    const lines = source.split("\n");
    lines.forEach((line, i) => {
      for (const pkg of FORBIDDEN_IMPORTS) {
        if (line.includes(pkg)) {
          violations.push(`${rel}:${i + 1} references platform package "${pkg}"`);
        }
      }
      for (const token of FORBIDDEN_CORE_TOKENS) {
        if (line.includes(token)) {
          violations.push(`${rel}:${i + 1} contains surface wire token "${token}"`);
        }
      }
    });
  }
  return violations;
}

if (import.meta.main) {
  const violations = checkPorts();
  if (violations.length > 0) {
    console.error("Port boundary violations:");
    for (const v of violations) console.error("  " + v);
    process.exit(1);
  }
  console.log("check-ports: OK (no platform imports outside src/adapters/)");
}

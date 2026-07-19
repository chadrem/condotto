// M4 §2 spike: prove a `bun build --compile` single-file binary
//   (1) bundles `bun:sqlite` and can open/query a DB,
//   (2) supports the transactional `PRAGMA user_version` write the §2 migration
//       runner relies on (DDL + version bump must commit/rollback atomically),
//   (3) bundles the Agent SDK's runtime and runs a headless `query()` on the
//       machine's subscription OAuth (no ANTHROPIC_API_KEY), exactly as the
//       daemon does.
//
// Build:  bun build --compile spikes/m4/binary-smoke.ts --outfile /tmp/conduit-spike
// Run:    /tmp/conduit-spike          (run the BINARY, never `bun run`)
//
// Faithful to production: same `query()` shape as the claude-code adapter
// (claude_code systemPrompt preset, subscription auth). Exits non-zero on any
// failure so the run is self-checking.

import { Database } from "bun:sqlite";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fail(msg: string): never {
  console.error(`[spike] FAIL: ${msg}`);
  process.exit(1);
}

// -- (1) bun:sqlite round-trips inside the compiled binary --------------------
{
  const db = new Database(":memory:");
  db.run("PRAGMA journal_mode = WAL;");
  db.run("CREATE TABLE t (x INTEGER)");
  db.run("INSERT INTO t (x) VALUES (42)");
  const row = db.query<{ x: number }, []>("SELECT x FROM t").get();
  if (row?.x !== 42) fail(`sqlite round-trip returned ${JSON.stringify(row)}`);
  console.log("[spike] sqlite round-trip: OK (x=42)");
  db.close();
}

// -- (2) PRAGMA user_version is transactional (the migration-runner contract) --
// The §2 runner wraps each migration + its version bump in a transaction so a
// crash mid-upgrade rolls the WHOLE step back. Prove both commit and rollback.
{
  const db = new Database(":memory:");
  const readVersion = () =>
    (db.query<{ user_version: number }, []>("PRAGMA user_version").get()!).user_version;

  if (readVersion() !== 0) fail("fresh DB user_version was not 0");

  // Commit path: DDL + bump inside one tx, both visible after.
  db.transaction(() => {
    db.run("CREATE TABLE m1 (a TEXT)");
    db.run("PRAGMA user_version = 1");
  })();
  if (readVersion() !== 1) fail(`committed user_version was ${readVersion()}, expected 1`);
  const hasM1 = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='m1'")
    .get();
  if (!hasM1) fail("committed migration table m1 missing");

  // Rollback path: a throwing tx must revert BOTH the DDL and the version bump.
  try {
    db.transaction(() => {
      db.run("CREATE TABLE m2 (a TEXT)");
      db.run("PRAGMA user_version = 2");
      throw new Error("simulated mid-migration crash");
    })();
    fail("throwing transaction did not propagate");
  } catch (err) {
    if (!(err instanceof Error) || !/simulated/.test(err.message)) throw err;
  }
  if (readVersion() !== 1) fail(`after rollback user_version was ${readVersion()}, expected 1`);
  const hasM2 = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='m2'")
    .get();
  if (hasM2) fail("rolled-back migration table m2 still present — PRAGMA/DDL not atomic");
  console.log("[spike] PRAGMA user_version transactional (commit + rollback): OK");
  db.close();
}

// -- (3) Agent SDK runs headless on subscription OAuth ------------------------
{
  if (process.env.ANTHROPIC_API_KEY) {
    console.log("[spike] NOTE: ANTHROPIC_API_KEY is set — the spike wants to prove SUBSCRIPTION auth");
  }
  const cwd = mkdtempSync(join(tmpdir(), "conduit-spike-"));
  let sessionId = "";
  let reply = "";
  let subtype = "";
  let costUsd: number | undefined;
  for await (const m of query({
    prompt: "Reply with exactly the single word READY and nothing else. Do not use any tools.",
    options: {
      cwd,
      // Same preset the real adapter uses, so this exercises the production path.
      systemPrompt: { type: "preset", preset: "claude_code", append: "You are a headless smoke test." },
      // Keep it cheap and bounded.
      model: "claude-haiku-4-5-20251001",
      maxBudgetUsd: 0.5,
    },
  } as { prompt: unknown; options: Record<string, unknown> }) as AsyncIterable<Record<string, any>>) {
    if (m.type === "system" && m.subtype === "init") sessionId = m.session_id ?? "";
    if (m.type === "result") {
      subtype = m.subtype ?? "";
      if (typeof m.total_cost_usd === "number") costUsd = m.total_cost_usd;
      if (typeof m.result === "string") reply = m.result;
    }
  }
  console.log(
    `[spike] sdk result: subtype=${subtype} session=${sessionId.slice(0, 8)} cost=$${costUsd ?? "?"} reply=${JSON.stringify(reply.trim())}`,
  );
  if (subtype !== "success") fail(`sdk query ended with subtype "${subtype}" (auth or runtime not bundled?)`);
  if (!/READY/i.test(reply)) fail(`sdk reply did not contain READY: ${JSON.stringify(reply)}`);
  console.log("[spike] Agent SDK headless query: OK");
}

console.log("[spike] ALL CHECKS PASSED — compiled binary bundles bun:sqlite + Agent SDK and runs headless");
process.exit(0);

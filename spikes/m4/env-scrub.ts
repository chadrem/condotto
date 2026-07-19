// M4 §5 spike (a) — env-scrub the agent shell.
//
// THE load-bearing question: `options.env` REPLACES the subprocess environment
// entirely (SDK doc, sdk.d.ts:1411 — "it is not merged with process.env"). So a
// denylist that spreads process.env and drops ONLY the daemon's SLACK_*/CONDUIT_*
// secrets must (1) still let the Claude Code CLI run under keychain OAuth (nothing
// load-bearing was dropped), and (2) actually keep those secrets out of the agent's
// Bash, while PATH/HOME + the repo toolchain env survive.
//
//   Run: bun run spikes/m4/env-scrub.ts   (needs subscription auth)
import { query } from "@anthropic-ai/claude-agent-sdk";
import { WorktreeManager } from "../../src/core/worktrees";

const TESTREPO = process.env.HOME + "/tmp/conduit-testrepo";

// ---- the denylist under test (mirror of what session-manager will build) ----
// Drop the daemon's own secrets by PREFIX; preserve everything else (PATH/HOME +
// toolchain + the Claude auth token, which does NOT match these prefixes).
const SECRET_PREFIXES = ["SLACK_", "CONDUIT_"];
function scrubDaemonSecrets(base: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (SECRET_PREFIXES.some((p) => k.startsWith(p))) continue;
    out[k] = v;
  }
  return out;
}

// ---- plant poison secrets + a benign toolchain var in the daemon env ----------
process.env.SLACK_BOT_TOKEN = "xoxb-POISON-SHOULD-NOT-LEAK";
process.env.SLACK_APP_TOKEN = "xapp-POISON-SHOULD-NOT-LEAK";
process.env.CONDUIT_POISON = "CONDUIT-POISON-SHOULD-NOT-LEAK";
process.env.MY_TOOLCHAIN_VAR = "toolchain-keepme"; // stands in for repo build env

const scrubbed = scrubDaemonSecrets(process.env);
console.log(`[spike] scrubbed env has ${Object.keys(scrubbed).length} keys`);
console.log(`[spike] SLACK_BOT_TOKEN present in scrubbed env? ${"SLACK_BOT_TOKEN" in scrubbed}`);
console.log(`[spike] CONDUIT_POISON present in scrubbed env?   ${"CONDUIT_POISON" in scrubbed}`);
console.log(`[spike] PATH preserved? ${!!scrubbed.PATH}   HOME preserved? ${!!scrubbed.HOME}`);
console.log(`[spike] MY_TOOLCHAIN_VAR preserved? ${scrubbed.MY_TOOLCHAIN_VAR === "toolchain-keepme"}`);
console.log(`[spike] CLAUDE_CODE_OAUTH_TOKEN preserved? ${"CLAUDE_CODE_OAUTH_TOKEN" in scrubbed} (only meaningful on a headless box)`);

const worktrees = new WorktreeManager(process.env.HOME + "/tmp/conduit-spike-worktrees");
const wt = await worktrees.create({ repoPath: TESTREPO, defaultBranch: "main", sessionId: crypto.randomUUID() });
console.log(`[spike] worktree: ${wt.path}`);

// Sentinel the agent must echo so we can read the shell's view of the env.
const MARK = "ENVPROBE";
const q = query({
  prompt:
    `Run EXACTLY this one bash command and report its stdout verbatim, nothing else:\n` +
    `  echo "${MARK} slack=[$SLACK_BOT_TOKEN] conduit=[$CONDUIT_POISON] tool=[$MY_TOOLCHAIN_VAR] home=[$HOME] haspath=[${"${PATH:+yes}"}]"`,
  options: {
    cwd: wt.path,
    systemPrompt: { type: "preset", preset: "claude_code", append: "Env-scrub spike. Run the one command, report stdout. Terse." },
    // Allow Bash for the spike (the real daemon gates it); this tests the ENV the
    // shell sees, not the gate.
    allowedTools: ["Bash"],
    disallowedTools: ["ExitPlanMode", "SlashCommand", "WebFetch", "WebSearch"],
    permissionMode: "bypassPermissions",
    model: "claude-fable-5",
    effort: "low",
    settingSources: [],
    // THE THING UNDER TEST: replace the subprocess env with the scrubbed copy.
    env: scrubbed,
  },
});

let reply = "";
let ranClean = false;
for await (const m of q as AsyncIterable<Record<string, any>>) {
  if (m.type === "result") {
    console.log(`[spike] result subtype=${m.subtype} terminal=${m.terminal_reason} cost=${m.total_cost_usd}`);
    if (m.subtype === "success") { reply = String(m.result ?? ""); ranClean = true; }
  }
}
console.log(`\n[spike] agent reply:\n${reply}\n`);

// The shell's actual view (parse the echoed sentinel line).
const line = (reply.match(new RegExp(`${MARK}[^\\n]*`)) ?? [""])[0];
const slackLeaked = /slack=\[xoxb-POISON/.test(line);
const conduitLeaked = /conduit=\[CONDUIT-POISON/.test(line);
const toolKept = /tool=\[toolchain-keepme\]/.test(line);
const homeKept = /home=\[\/.+\]/.test(line);
const pathKept = /haspath=\[yes\]/.test(line);

console.log("================ ENV-SCRUB SPIKE RESULTS ================");
console.log(`CLI ran under scrubbed env (keychain OAuth ok):  ${ranClean}`);
console.log(`SLACK_BOT_TOKEN LEAKED to the shell:             ${slackLeaked}  (want false)`);
console.log(`CONDUIT_POISON LEAKED to the shell:              ${conduitLeaked}  (want false)`);
console.log(`toolchain var survived to the shell:             ${toolKept}  (want true)`);
console.log(`HOME survived:                                   ${homeKept}  (want true)`);
console.log(`PATH survived:                                   ${pathKept}  (want true)`);
console.log("========================================================\n");

const pass = ranClean && !slackLeaked && !conduitLeaked && toolKept && homeKept && pathKept;
if (pass) {
  console.log("[spike] PASS — denylist scrub keeps SLACK_*/CONDUIT_* out of the agent shell while the CLI runs and PATH/HOME/toolchain survive. BUILD as denylist.");
  process.exit(0);
}
console.error("[spike] FAIL — inspect the reply above (the agent may not have echoed cleanly; re-run).");
process.exit(1);

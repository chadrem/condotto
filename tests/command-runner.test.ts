import { describe, expect, test } from "bun:test";
import { CommandRunner, DEFAULT_SCRUB_ENV } from "../src/core/command-runner";

describe("CommandRunner", () => {
  test("runs a command in the given cwd and captures output + exit code", async () => {
    const r = new CommandRunner();
    const res = await r.run("echo hello && pwd", "/tmp");
    expect(res.code).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.output).toContain("hello");
    expect(res.output).toContain("/tmp");
  });

  test("reports a nonzero exit code", async () => {
    const res = await new CommandRunner().run("echo oops; exit 3", "/tmp");
    expect(res.code).toBe(3);
    expect(res.output).toContain("oops");
  });

  test("scrubs the daemon's secrets from the child environment", async () => {
    process.env.CONDOTTO_TEST_SECRET = "leaky";
    try {
      const scrubbed = await new CommandRunner({ scrubEnv: ["CONDOTTO_TEST_SECRET"] }).run("echo [$CONDOTTO_TEST_SECRET]", "/tmp");
      expect(scrubbed.output).toBe("[]");
      const notScrubbed = await new CommandRunner({ scrubEnv: [] }).run("echo [$CONDOTTO_TEST_SECRET]", "/tmp");
      expect(notScrubbed.output).toBe("[leaky]");
    } finally {
      delete process.env.CONDOTTO_TEST_SECRET;
    }
  });

  // REGRESSION GUARD (2026-07-20, api_key auth). Adding API-key support put a live
  // Anthropic credential in the daemon's environment on the DEFAULT path, where
  // previously subscription auth usually kept it in the keychain. The daemon holds
  // the credential; a repo's land/deploy command must never see it. Deleting a name
  // from DEFAULT_SCRUB_ENV must fail loudly here rather than silently widen the
  // blast radius. Paired with the policy hard-deny in tests/policy.test.ts.
  test("DEFAULT_SCRUB_ENV covers both Anthropic credential names", () => {
    expect(DEFAULT_SCRUB_ENV).toContain("ANTHROPIC_API_KEY");
    expect(DEFAULT_SCRUB_ENV).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  test("the default scrub keeps Anthropic credentials out of a deploy command", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-leak";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-leak";
    try {
      // No scrubEnv override — this is the production default the daemon runs with.
      const res = await new CommandRunner().run(
        "echo [$ANTHROPIC_API_KEY][$CLAUDE_CODE_OAUTH_TOKEN]",
        "/tmp",
      );
      expect(res.output).toBe("[][]");
      expect(res.output).not.toContain("sk-ant-leak");
      expect(res.output).not.toContain("oauth-leak");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
  });

  test("kills and flags a command that exceeds the timeout", async () => {
    const res = await new CommandRunner({ timeoutMs: 100 }).run("sleep 5", "/tmp");
    expect(res.timedOut).toBe(true);
    expect(res.code).toBeNull();
  });

  test("bounds runaway output", async () => {
    const res = await new CommandRunner({ maxOutputBytes: 50 }).run("for i in $(seq 1 1000); do echo line$i; done", "/tmp");
    expect(res.output.length).toBeLessThan(120);
    expect(res.output).toContain("truncated");
  });
});

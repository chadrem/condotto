import { describe, expect, test } from "bun:test";
import { CommandRunner } from "../src/core/command-runner";

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

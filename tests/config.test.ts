import { describe, expect, test, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadSlackConfig } from "../src/core/config";

// Write a throwaway condotto.toml and return its path. Tests pass an EXPLICIT
// path + an empty env so a stray ./condotto.toml or process.env can't leak in.
function tomlFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "condotto-cfg-"));
  const path = join(dir, "condotto.toml");
  writeFileSync(path, content);
  return path;
}

// A minimal Slack section so loadConfig-focused tests don't have to repeat it
// (loadConfig ignores [slack] entirely; only loadSlackConfig reads it).
const SLACK = `[slack]\nbot_token = "B"\napp_token = "A"\n`;

// At least one [[repos]] entry is required, so tests focused on defaults/roles
// append a filler one. APPENDED, never prepended: TOML top-level keys (e.g.
// `architects = [...]`) must stay above the first [section] header, or they'd be
// parsed as keys inside it.
const FILLER_REPO = `[[repos]]\nname = "filler"\npath = "/srv/filler"\n`;
const cfgFile = (body: string): string => tomlFile(`${body}\n${FILLER_REPO}`);

describe("config discovery + validation", () => {
  test("a missing config file fails fast with an actionable message", () => {
    expect(() => loadConfig({}, "/nonexistent/condotto.toml")).toThrow(/No Condotto config found/);
  });

  test("malformed TOML is rejected loudly with the file path", () => {
    const bad = tomlFile("this = = not valid toml");
    expect(() => loadConfig({}, bad)).toThrow(/parse .* as TOML/);
  });

  test("CONDOTTO_CONFIG selects the file when no --config override is given", () => {
    const path = tomlFile(`[[repos]]\nname = "webapp"\npath = "/srv/webapp"\n`);
    const config = loadConfig({ CONDOTTO_CONFIG: path });
    expect(config.repos.map((r) => r.name)).toContain("webapp");
  });

  test("unknown keys warn but do not throw (typo tolerance)", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const path = tomlFile(`totally_unknown = 1\n[[repos]]\nname = "r"\npath = "/x"\ntpyo = true\n`);
      expect(() => loadConfig({}, path)).not.toThrow();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("loadConfig repos", () => {
  test("no [[repos]] fails fast — there is no default repo", () => {
    // An operator must name their own repos; nothing is assumed on their behalf.
    expect(() => loadConfig({}, tomlFile(""))).toThrow(/No repos configured/);
    expect(() => loadConfig({}, tomlFile(""))).toThrow(/\[\[repos\]\]/);
    // The message shows a copy-pasteable entry and points at the example file.
    expect(() => loadConfig({}, tomlFile(`[defaults]\nmodel = "opus"\n`))).toThrow(/condotto\.example\.toml/);
  });

  test("[[repos]] adds named repos with expanded paths and default branch", () => {
    const path = tomlFile(`
[[repos]]
name = "webapp"
path = "~/Projects/webapp"
default_branch = "develop"

[[repos]]
name = "api"
path = "/srv/api"
`);
    const config = loadConfig({}, path);
    // Exactly the declared repos, in file order — nothing injected.
    expect(config.repos.map((r) => r.name)).toEqual(["webapp", "api"]);
    const webapp = config.repos.find((r) => r.name === "webapp")!;
    expect(webapp.path).not.toContain("~");
    expect(webapp.defaultBranch).toBe("develop");
    expect(config.repos.find((r) => r.name === "api")!.defaultBranch).toBe("main");
  });

  test("a duplicate repo name is rejected rather than silently discarded", () => {
    // Names key the repos table and every `assign <repo>`, so a duplicate is a
    // typo that would otherwise drop one of the two entries on the floor.
    const path = tomlFile(`[[repos]]\nname = "dup"\npath = "/a"\n\n[[repos]]\nname = "dup"\npath = "/b"\n`);
    expect(() => loadConfig({}, path)).toThrow(/duplicate name "dup"/);
  });

  test("malformed repo entries are rejected loudly", () => {
    expect(() => loadConfig({}, tomlFile(`[[repos]]\npath = "/x"\n`))).toThrow(/"name"/);
    expect(() => loadConfig({}, tomlFile(`[[repos]]\nname = "bad name!"\npath = "/x"\n`))).toThrow(/"name"/);
    expect(() => loadConfig({}, tomlFile(`[[repos]]\nname = "ok"\n`))).toThrow(/"path"/);
    expect(() => loadConfig({}, tomlFile(`repos = "notanarray"\n`))).toThrow(/array of tables/);
  });

  test("[[repos]] loads test/land/deploy commands and per-repo cost cap", () => {
    const path = tomlFile(`
[[repos]]
name = "webapp"
path = "/srv/webapp"
test_cmd = "npm test"
land_cmd = "make land"
deploy_cmd = "make deploy"
cost_cap_usd = 25

[[repos]]
name = "bare"
path = "/srv/bare"
`);
    const cfg = loadConfig({}, path);
    const webapp = cfg.repos.find((r) => r.name === "webapp")!;
    expect(webapp.testCmd).toBe("npm test");
    expect(webapp.landCmd).toBe("make land");
    expect(webapp.deployCmd).toBe("make deploy");
    expect(webapp.costCapUsd).toBe(25);
    const bare = cfg.repos.find((r) => r.name === "bare")!;
    expect(bare.testCmd).toBeUndefined();
    expect(bare.landCmd).toBeUndefined();
    expect(bare.costCapUsd).toBeUndefined();
  });

  test("a non-positive per-repo cost cap is rejected", () => {
    expect(() => loadConfig({}, tomlFile(`[[repos]]\nname = "r"\npath = "/x"\ncost_cap_usd = -5\n`))).toThrow(
      /positive number/,
    );
  });

  test("per-repo default model/effort and the trust flag parse", () => {
    const path = tomlFile(`
[[repos]]
name = "webapp"
path = "/srv/webapp"
default_model = "sonnet"
default_effort = "xhigh"
trusted = true

[[repos]]
name = "bare"
path = "/srv/bare"
`);
    const cfg = loadConfig({}, path);
    const webapp = cfg.repos.find((r) => r.name === "webapp")!;
    expect(webapp.defaultModel).toBe("sonnet");
    expect(webapp.defaultEffort).toBe("xhigh");
    expect(webapp.trusted).toBe(true);
    const bare = cfg.repos.find((r) => r.name === "bare")!;
    expect(bare.defaultModel).toBeUndefined();
    expect(bare.defaultEffort).toBeUndefined();
    expect(bare.trusted).toBe(false);
  });

  test("a non-boolean trusted fails fast rather than silently disabling trust", () => {
    // trusted opens repo config/MCP, so a typo like trusted = "true" (quoted)
    // must be surfaced, not coerced to a silent false.
    expect(() => loadConfig({}, tomlFile(`[[repos]]\nname = "r"\npath = "/x"\ntrusted = "yes"\n`))).toThrow(
      /must be a boolean/,
    );
  });

  test("safe_bash_allowlist defaults to the conservative set and can be overridden", () => {
    const def = loadConfig({}, cfgFile(""));
    expect(def.repos[0]!.safeBashAllowlist).toContain("git status");
    expect(def.repos[0]!.safeBashAllowlist).not.toContain("cat"); // reads go through confined tools

    const path = tomlFile(`[[repos]]\nname = "webapp"\npath = "/srv/webapp"\nsafe_bash_allowlist = ["bun test"]\n`);
    const cfg = loadConfig({}, path);
    expect(cfg.repos.find((r) => r.name === "webapp")!.safeBashAllowlist).toEqual(["bun test"]);
  });

  test("per-repo auto_approve requires an explicit boolean", () => {
    const path = tomlFile(`
[[repos]]
name = "on"
path = "/srv/on"
auto_approve = false

[[repos]]
name = "unset"
path = "/srv/unset"
`);
    const cfg = loadConfig({}, path);
    expect(cfg.repos.find((r) => r.name === "on")!.autoApprove).toBe(false);
    expect(cfg.repos.find((r) => r.name === "unset")!.autoApprove).toBeUndefined();
  });
});

describe("loadConfig defaults + env overrides", () => {
  test("cost cap and concurrency: defaults, file values, and env override", () => {
    const def = loadConfig({}, cfgFile(""));
    expect(def.defaultCostCapUsd).toBe(10);
    expect(def.maxConcurrentTurns).toBe(6);

    const fromFile = loadConfig({}, cfgFile(`[defaults]\ncost_cap_usd = 20\nmax_concurrent_turns = 4\n`));
    expect(fromFile.defaultCostCapUsd).toBe(20);
    expect(fromFile.maxConcurrentTurns).toBe(4);

    // Env wins over the file value.
    const over = loadConfig(
      { CONDOTTO_COST_CAP_USD: "42.5", CONDOTTO_MAX_CONCURRENT_TURNS: "3" },
      cfgFile(`[defaults]\ncost_cap_usd = 20\nmax_concurrent_turns = 4\n`),
    );
    expect(over.defaultCostCapUsd).toBe(42.5);
    expect(over.maxConcurrentTurns).toBe(3);

    expect(() => loadConfig({ CONDOTTO_COST_CAP_USD: "-1" }, cfgFile(""))).toThrow(/positive number/);
    expect(() => loadConfig({ CONDOTTO_MAX_CONCURRENT_TURNS: "0" }, cfgFile(""))).toThrow(/positive integer/);
    expect(() => loadConfig({}, cfgFile(`[defaults]\nmax_concurrent_turns = 0\n`))).toThrow(/positive integer/);
  });

  test("auto-approve defaults ON, is settable in-file, and env overrides it", () => {
    expect(loadConfig({}, cfgFile("")).defaultAutoApprove).toBe(true);
    expect(loadConfig({}, cfgFile(`[defaults]\nauto_approve = false\n`)).defaultAutoApprove).toBe(false);
    for (const off of ["off", "false", "0", "no", "OFF"]) {
      expect(loadConfig({ CONDOTTO_AUTO_APPROVE: off }, cfgFile("")).defaultAutoApprove).toBe(false);
    }
    // Env "on" beats a file `false`.
    expect(
      loadConfig({ CONDOTTO_AUTO_APPROVE: "on" }, cfgFile(`[defaults]\nauto_approve = false\n`)).defaultAutoApprove,
    ).toBe(true);
  });

  test("default model/effort defaults to Opus + high, settable in-file, env overrides", () => {
    const def = loadConfig({}, cfgFile(""));
    expect(def.defaultModel).toBe("opus");
    expect(def.defaultEffort).toBe("high");

    const fromFile = loadConfig({}, cfgFile(`[defaults]\nmodel = "sonnet"\neffort = "max"\n`));
    expect(fromFile.defaultModel).toBe("sonnet");
    expect(fromFile.defaultEffort).toBe("max");

    const over = loadConfig(
      { CONDOTTO_DEFAULT_MODEL: "fable", CONDOTTO_DEFAULT_EFFORT: "xhigh" },
      cfgFile(`[defaults]\nmodel = "sonnet"\neffort = "max"\n`),
    );
    expect(over.defaultModel).toBe("fable");
    expect(over.defaultEffort).toBe("xhigh");
  });

  test("paths: db + worktrees_root come from [paths] and env overrides", () => {
    const fromFile = loadConfig({}, cfgFile(`[paths]\ndb = "/data/condotto.sqlite"\nworktrees_root = "/data/wt"\n`));
    expect(fromFile.dbPath).toBe("/data/condotto.sqlite");
    expect(fromFile.worktreesRoot).toBe("/data/wt");

    const over = loadConfig(
      { CONDOTTO_DB_PATH: "/env/db.sqlite", CONDOTTO_WORKTREES_ROOT: "/env/wt" },
      cfgFile(`[paths]\ndb = "/data/condotto.sqlite"\nworktrees_root = "/data/wt"\n`),
    );
    expect(over.dbPath).toBe("/env/db.sqlite");
    expect(over.worktreesRoot).toBe("/env/wt");
  });
});

describe("loadConfig roles", () => {
  test("architects array seeds architect mappings at scope *", () => {
    const cfg = loadConfig({}, cfgFile(`architects = ["slack:U1", "slack:U2", "slack:U3"]\n`));
    expect(cfg.roles).toEqual([
      { principal: "slack:U1", role: "architect", scope: "*" },
      { principal: "slack:U2", role: "architect", scope: "*" },
      { principal: "slack:U3", role: "architect", scope: "*" },
    ]);
  });

  test("a non-qualified architect principal is rejected (file and env)", () => {
    expect(() => loadConfig({}, cfgFile(`architects = ["U_NOSURFACE"]\n`))).toThrow(/surface-qualified/);
    expect(() => loadConfig({ CONDOTTO_ARCHITECTS: "U_NOSURFACE" }, cfgFile(""))).toThrow(/surface-qualified/);
  });

  test("CONDOTTO_ARCHITECTS splits on both commas and spaces", () => {
    const cfg = loadConfig({ CONDOTTO_ARCHITECTS: "slack:U1, slack:U2 slack:U3" }, cfgFile(""));
    expect(cfg.roles).toEqual([
      { principal: "slack:U1", role: "architect", scope: "*" },
      { principal: "slack:U2", role: "architect", scope: "*" },
      { principal: "slack:U3", role: "architect", scope: "*" },
    ]);
  });

  test("a file [[roles]] entry wins over the env CONDOTTO_ARCHITECTS quick-list on a same-scope collision", () => {
    // Role assignments are authority: an explicit demote in the owned file must
    // stick even if the principal is still named in CONDOTTO_ARCHITECTS (a demote
    // must never be silently re-elevated by a leftover env entry).
    const path = cfgFile(`[[roles]]\nprincipal = "slack:U1"\nrole = "member"\nscope = "*"\n`);
    const cfg = loadConfig({ CONDOTTO_ARCHITECTS: "slack:U1" }, path);
    expect(cfg.roles).toEqual([{ principal: "slack:U1", role: "member", scope: "*" }]);
  });

  test("[[roles]] adds mappings with scope and role, merged with architects + env", () => {
    const path = cfgFile(`
architects = ["slack:U1"]

[[roles]]
principal = "slack:U9"
role = "member"
scope = "C_LOCKED"

[[roles]]
principal = "slack:U10"
role = "observer"
`);
    const cfg = loadConfig({ CONDOTTO_ARCHITECTS: "slack:U2" }, path);
    expect(cfg.roles).toContainEqual({ principal: "slack:U1", role: "architect", scope: "*" });
    expect(cfg.roles).toContainEqual({ principal: "slack:U2", role: "architect", scope: "*" });
    expect(cfg.roles).toContainEqual({ principal: "slack:U9", role: "member", scope: "C_LOCKED" });
    expect(cfg.roles).toContainEqual({ principal: "slack:U10", role: "observer", scope: "*" });
  });

  test("an invalid role in [[roles]] is rejected", () => {
    expect(() =>
      loadConfig({}, cfgFile(`[[roles]]\nprincipal = "slack:U1"\nrole = "superuser"\n`)),
    ).toThrow(/architect\|member\|observer/);
  });

  test("architects must be an array of strings", () => {
    expect(() => loadConfig({}, cfgFile(`architects = "slack:U1"\n`))).toThrow(/array of surface-qualified/);
  });
});

describe("loadSlackConfig", () => {
  test("reads [slack] tokens from the file", () => {
    const creds = loadSlackConfig({}, tomlFile(SLACK));
    expect(creds).toEqual({ botToken: "B", appToken: "A" });
  });

  test("env vars override the file tokens", () => {
    const creds = loadSlackConfig(
      { SLACK_BOT_TOKEN: "envB", SLACK_APP_TOKEN: "envA" },
      tomlFile(`[slack]\nbot_token = "fileB"\napp_token = "fileA"\n`),
    );
    expect(creds).toEqual({ botToken: "envB", appToken: "envA" });
  });

  test("missing Slack tokens fail fast with an actionable message", () => {
    expect(() => loadSlackConfig({}, tomlFile(""))).toThrow(/Missing Slack tokens/);
    expect(() => loadSlackConfig({}, tomlFile(`[slack]\nbot_token = "B"\n`))).toThrow(/Missing Slack tokens/);
  });

  test("env tokens alone suffice even with no [slack] section", () => {
    const creds = loadSlackConfig({ SLACK_BOT_TOKEN: "B", SLACK_APP_TOKEN: "A" }, tomlFile(""));
    expect(creds).toEqual({ botToken: "B", appToken: "A" });
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/core/config";

function reposFile(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "conduit-cfg-"));
  const path = join(dir, "repos.json");
  writeFileSync(path, JSON.stringify(content));
  return path;
}

function rolesFile(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "conduit-roles-"));
  const path = join(dir, "roles.json");
  writeFileSync(path, JSON.stringify(content));
  return path;
}

// Every loadConfig call points ROLES_FILE at a nonexistent path unless a test
// overrides it, so a stray conduit.roles.json in cwd can't leak in.
const NO_ROLES = { CONDUIT_ROLES_FILE: "/nonexistent/roles.json" };

describe("loadConfig repos", () => {
  test("defaults to the throwaway testrepo only", () => {
    const config = loadConfig({ CONDUIT_REPOS_FILE: "/nonexistent/repos.json" });
    expect(config.repos.map((r) => r.name)).toEqual(["testrepo"]);
  });

  test("registry file adds named repos with expanded paths and default branch", () => {
    const file = reposFile([
      { name: "webapp", path: "~/Projects/webapp", defaultBranch: "develop" },
      { name: "api", path: "/srv/api" },
    ]);
    const config = loadConfig({ CONDUIT_REPOS_FILE: file });
    const names = config.repos.map((r) => r.name);
    expect(names).toEqual(["testrepo", "webapp", "api"]);
    const webapp = config.repos.find((r) => r.name === "webapp")!;
    expect(webapp.path).not.toContain("~");
    expect(webapp.defaultBranch).toBe("develop");
    expect(config.repos.find((r) => r.name === "api")!.defaultBranch).toBe("main");
  });

  test("a registry entry named testrepo overrides the default", () => {
    const file = reposFile([{ name: "testrepo", path: "/tmp/elsewhere" }]);
    const config = loadConfig({ CONDUIT_REPOS_FILE: file });
    expect(config.repos).toHaveLength(1);
    expect(config.repos[0]!.path).toBe("/tmp/elsewhere");
  });

  test("malformed entries are rejected loudly", () => {
    expect(() => loadConfig({ CONDUIT_REPOS_FILE: reposFile([{ path: "/x" }]) })).toThrow(
      /"name"/,
    );
    expect(() =>
      loadConfig({ CONDUIT_REPOS_FILE: reposFile([{ name: "bad name!", path: "/x" }]) }),
    ).toThrow(/"name"/);
    expect(() => loadConfig({ CONDUIT_REPOS_FILE: reposFile({ not: "array" }) })).toThrow(
      /array/,
    );
  });

  test("the throwaway testrepo ships a real test command and echo land/deploy no-ops (M3)", () => {
    const config = loadConfig({ CONDUIT_REPOS_FILE: "/nonexistent/repos.json", ...NO_ROLES });
    const testrepo = config.repos.find((r) => r.name === "testrepo")!;
    expect(testrepo.testCmd).toBe("bun test");
    expect(testrepo.landCmd).toContain("echo");
    expect(testrepo.deployCmd).toContain("echo");
    // Build-time safety: land/deploy must not be a real deploy path.
    expect(testrepo.landCmd).not.toMatch(/git push|deploy|kubectl|ssh/i);
  });

  test("registry file loads test/land/deploy commands and per-repo cost cap (M3)", () => {
    const file = reposFile([
      { name: "webapp", path: "/srv/webapp", testCmd: "npm test", landCmd: "make land", deployCmd: "make deploy", costCapUsd: 25 },
      { name: "bare", path: "/srv/bare" },
    ]);
    const cfg = loadConfig({ CONDUIT_REPOS_FILE: file, ...NO_ROLES });
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

  test("daemon-wide cost cap and concurrency defaults, overridable by env (M3)", () => {
    const def = loadConfig({ CONDUIT_REPOS_FILE: "/nonexistent/repos.json", ...NO_ROLES });
    expect(def.defaultCostCapUsd).toBe(10);
    expect(def.maxConcurrentTurns).toBe(6);
    const over = loadConfig({
      CONDUIT_REPOS_FILE: "/nonexistent/repos.json",
      CONDUIT_COST_CAP_USD: "42.5",
      CONDUIT_MAX_CONCURRENT_TURNS: "3",
      ...NO_ROLES,
    });
    expect(over.defaultCostCapUsd).toBe(42.5);
    expect(over.maxConcurrentTurns).toBe(3);
    expect(() => loadConfig({ CONDUIT_COST_CAP_USD: "-1", ...NO_ROLES })).toThrow(/positive number/);
    expect(() => loadConfig({ CONDUIT_MAX_CONCURRENT_TURNS: "0", ...NO_ROLES })).toThrow(/positive integer/);
  });

  test("daemon-wide auto-approve defaults ON, disableable by env (M3.8)", () => {
    const def = loadConfig({ CONDUIT_REPOS_FILE: "/nonexistent/repos.json", ...NO_ROLES });
    expect(def.defaultAutoApprove).toBe(true);
    for (const off of ["off", "false", "0", "no", "OFF"]) {
      const cfg = loadConfig({ CONDUIT_REPOS_FILE: "/nonexistent/repos.json", CONDUIT_AUTO_APPROVE: off, ...NO_ROLES });
      expect(cfg.defaultAutoApprove).toBe(false);
    }
    // Any other value keeps it on.
    expect(loadConfig({ CONDUIT_REPOS_FILE: "/nonexistent/repos.json", CONDUIT_AUTO_APPROVE: "on", ...NO_ROLES }).defaultAutoApprove).toBe(true);
  });

  test("per-repo default model/effort and the trust flag parse (M3.5)", () => {
    const file = reposFile([
      { name: "webapp", path: "/srv/webapp", defaultModel: "sonnet", defaultEffort: "xhigh", trusted: true },
      { name: "bare", path: "/srv/bare" },
      // A non-boolean `trusted` must NOT enable trust — it opens repo config/MCP.
      { name: "sneaky", path: "/srv/sneaky", trusted: "yes" },
    ]);
    const cfg = loadConfig({ CONDUIT_REPOS_FILE: file, ...NO_ROLES });
    const webapp = cfg.repos.find((r) => r.name === "webapp")!;
    expect(webapp.defaultModel).toBe("sonnet");
    expect(webapp.defaultEffort).toBe("xhigh");
    expect(webapp.trusted).toBe(true);
    const bare = cfg.repos.find((r) => r.name === "bare")!;
    expect(bare.defaultModel).toBeUndefined();
    expect(bare.defaultEffort).toBeUndefined();
    expect(bare.trusted).toBe(false);
    expect(cfg.repos.find((r) => r.name === "sneaky")!.trusted).toBe(false);
  });

  test("daemon-wide default model/effort defaults to Opus + high, overridable by env (M3.5)", () => {
    const def = loadConfig({ CONDUIT_REPOS_FILE: "/nonexistent/repos.json", ...NO_ROLES });
    expect(def.defaultModel).toBe("opus");
    expect(def.defaultEffort).toBe("high");
    const over = loadConfig({
      CONDUIT_REPOS_FILE: "/nonexistent/repos.json",
      CONDUIT_DEFAULT_MODEL: "sonnet",
      CONDUIT_DEFAULT_EFFORT: "xhigh",
      ...NO_ROLES,
    });
    expect(over.defaultModel).toBe("sonnet");
    expect(over.defaultEffort).toBe("xhigh");
  });

  test("the throwaway testrepo is untrusted with no model/effort override (M3.5)", () => {
    const config = loadConfig({ CONDUIT_REPOS_FILE: "/nonexistent/repos.json", ...NO_ROLES });
    const testrepo = config.repos.find((r) => r.name === "testrepo")!;
    expect(testrepo.trusted).toBe(false);
    expect(testrepo.defaultModel).toBeUndefined();
    expect(testrepo.defaultEffort).toBeUndefined();
  });

  test("safeBashAllowlist defaults to the conservative set and can be overridden", () => {
    const def = loadConfig({ CONDUIT_REPOS_FILE: "/nonexistent/repos.json", ...NO_ROLES });
    expect(def.repos[0]!.safeBashAllowlist).toContain("git status");
    expect(def.repos[0]!.safeBashAllowlist).not.toContain("cat"); // reads go through confined tools

    const file = reposFile([{ name: "webapp", path: "/srv/webapp", safeBashAllowlist: ["bun test"] }]);
    const cfg = loadConfig({ CONDUIT_REPOS_FILE: file, ...NO_ROLES });
    expect(cfg.repos.find((r) => r.name === "webapp")!.safeBashAllowlist).toEqual(["bun test"]);
  });
});

describe("loadConfig roles", () => {
  test("CONDUIT_ARCHITECTS seeds architect mappings (comma/space separated)", () => {
    const cfg = loadConfig({ CONDUIT_ARCHITECTS: "slack:U1, slack:U2 slack:U3", ...NO_ROLES });
    expect(cfg.roles).toEqual([
      { principal: "slack:U1", role: "architect", scope: "*" },
      { principal: "slack:U2", role: "architect", scope: "*" },
      { principal: "slack:U3", role: "architect", scope: "*" },
    ]);
  });

  test("a non-qualified architect principal is rejected", () => {
    expect(() => loadConfig({ CONDUIT_ARCHITECTS: "U_NOSURFACE", ...NO_ROLES })).toThrow(/surface-qualified/);
  });

  test("roles file adds mappings with scope and role, merged with env", () => {
    const file = rolesFile([
      { principal: "slack:U9", role: "member", scope: "C_LOCKED" },
      { principal: "slack:U10", role: "observer" },
    ]);
    const cfg = loadConfig({ CONDUIT_ARCHITECTS: "slack:U1", CONDUIT_ROLES_FILE: file });
    expect(cfg.roles).toContainEqual({ principal: "slack:U1", role: "architect", scope: "*" });
    expect(cfg.roles).toContainEqual({ principal: "slack:U9", role: "member", scope: "C_LOCKED" });
    expect(cfg.roles).toContainEqual({ principal: "slack:U10", role: "observer", scope: "*" });
  });

  test("an invalid role in the roles file is rejected", () => {
    const file = rolesFile([{ principal: "slack:U1", role: "superuser" }]);
    expect(() => loadConfig({ CONDUIT_ROLES_FILE: file })).toThrow(/architect\|member\|observer/);
  });
});

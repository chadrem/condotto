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

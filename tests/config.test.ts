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
});

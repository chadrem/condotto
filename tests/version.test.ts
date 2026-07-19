import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../src/version";

// The compiled binary reports `src/version.ts` (package.json isn't beside it at
// runtime), so the two must never drift. Read package.json as text rather than
// importing it, to avoid pulling a root JSON file into the tsc program.
test("src/version.ts VERSION matches package.json (M4 §2 single binary)", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")) as {
    version: string;
  };
  expect(VERSION).toBe(pkg.version);
});

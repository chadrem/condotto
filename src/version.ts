/**
 * Conduit's version, baked into the source (M4 §2).
 *
 * A `bun build --compile` binary has no `package.json` beside it at runtime
 * (`--compile-autoload-package-json` is off by default), so `--version` must
 * read a compiled-in constant, not the file. `tests/version.test.ts` asserts
 * this stays in lockstep with `package.json`, so bump both together.
 */
export const VERSION = "0.1.0";

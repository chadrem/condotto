#!/usr/bin/env bun
// Build a Condotto release with `bun build --compile` (M4 §2).
//
// A release is TWO files shipped together:
//   dist/<platform>/condotto   — the compiled daemon (a ~60MB Bun binary)
//   dist/<platform>/claude    — the SDK's native runtime CLI (~236MB) the daemon
//                               spawns; it can't be bundled into the binary (M4
//                               §2 spike / DECISIONS.md), so it rides alongside.
// At runtime the daemon finds `claude` next to itself, or via CONDOTTO_CLAUDE_CLI.
//
// Usage:
//   bun run scripts/build-binary.ts                    # host platform
//   bun run scripts/build-binary.ts --target bun-linux-x64
//
// Cross-compiling: `bun build --compile --target=…` cross-builds the daemon, but
// the native `claude` is an os/cpu-gated optional dep — only the HOST's is
// installed here. For a target whose native package isn't present, the daemon is
// still built; supply that platform's `claude` yourself, or (simplest) run this
// script ON that platform / a matching CI runner.

import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const ENTRY = join(ROOT, "src", "daemon.ts");

const args = process.argv.slice(2);
const ti = args.indexOf("--target");
const bunTarget = ti >= 0 ? args[ti + 1] : undefined;
if (ti >= 0 && (!bunTarget || bunTarget.startsWith("-"))) {
  console.error("--target requires a value, e.g. --target bun-linux-x64");
  process.exit(1);
}

/** The SDK's native CLI package for a platform key like `darwin-arm64` or
 *  `linux-x64-musl` — `win`/`windows` normalizes to npm's `win32`. */
function sdkNativePkg(key: string): string {
  const os = key.startsWith("win") ? "win32" : key.split("-")[0]; // darwin | linux | win32
  const rest = key.slice(key.indexOf("-") + 1); // arch[-variant], e.g. x64-musl
  return `@anthropic-ai/claude-agent-sdk-${os}-${rest}`;
}

/** Discover the ONE native CLI package npm installed for THIS host. `process.arch`
 *  can't distinguish glibc from musl, so scan rather than guess: on a musl/Alpine
 *  host only the `-musl` package is present, and this finds it. Returns the
 *  platform key (mirroring the package's own suffix) + the `claude` path. */
function hostNative(): { key: string; claude: string } | null {
  const dir = join(ROOT, "node_modules", "@anthropic-ai");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    const m = name.match(/^claude-agent-sdk-((?:darwin|linux|win32)-(?:x64|arm64)(?:-musl)?)$/);
    if (!m) continue;
    for (const exe of ["claude", "claude.exe"]) {
      const p = join(dir, name, exe);
      if (existsSync(p)) return { key: m[1]!, claude: p };
    }
  }
  return null;
}

// Resolve the platform key + the native `claude` to bundle beside the binary.
let platformKey: string;
let nativeClaude: string | null;
if (bunTarget) {
  // Explicit target build: map the target to its native package.
  platformKey = bunTarget.replace(/^bun-/, "");
  const exe = platformKey.startsWith("win") ? "claude.exe" : "claude";
  const cand = join(ROOT, "node_modules", sdkNativePkg(platformKey), exe);
  nativeClaude = existsSync(cand) ? cand : null;
} else {
  // Host build: discover the installed native package (glibc/musl-proof).
  const found = hostNative();
  platformKey = found?.key ?? `${process.platform}-${process.arch}`;
  nativeClaude = found?.claude ?? null;
}

const isWindows = platformKey.startsWith("win");
const outDir = join(ROOT, "dist", platformKey);
const exeName = isWindows ? "condotto.exe" : "condotto";
const claudeName = isWindows ? "claude.exe" : "claude";

console.log(`[build] platform ${platformKey}  ->  dist/${platformKey}/`);
mkdirSync(outDir, { recursive: true });

// 1) Compile the daemon.
const cmd = ["bun", "build", "--compile", ENTRY, "--outfile", join(outDir, exeName)];
if (bunTarget) cmd.push(`--target=${bunTarget}`);
console.log(`[build] ${cmd.join(" ")}`);
const build = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
if (!build.success) {
  console.error(`[build] compile failed (exit ${build.exitCode})`);
  process.exit(build.exitCode ?? 1);
}
const mb = (p: string) => (statSync(p).size / 1024 / 1024).toFixed(0);
console.log(`[build] wrote dist/${platformKey}/${exeName} (${mb(join(outDir, exeName))} MB)`);

// 2) Place the native `claude` beside it (the release bundle's other half).
// nativeClaude is non-null iff a matching native package was found on disk.
if (nativeClaude) {
  const dest = join(outDir, claudeName);
  copyFileSync(nativeClaude, dest);
  chmodSync(dest, 0o755);
  console.log(`[build] copied native CLI -> dist/${platformKey}/${claudeName} (${mb(dest)} MB)`);
  console.log(
    `[build] DONE. Ship dist/${platformKey}/ as one bundle (${exeName} + ${claudeName}); run ./${exeName}.`,
  );
} else {
  console.warn(
    `[build] INCOMPLETE BUNDLE: native CLI not found at ${sdkNativePkg(platformKey)}/${claudeName}.\n` +
      `        The daemon built, but its runtime is missing. The ${platformKey} native package is an\n` +
      `        os/cpu-gated optional dep and isn't installed on this host. To finish the bundle:\n` +
      `          • run this build ON a ${platformKey} machine / CI runner (recommended), or\n` +
      `          • drop that platform's 'claude' into dist/${platformKey}/, or\n` +
      `          • at runtime, set CONDOTTO_CLAUDE_CLI to an installed claude.`,
  );
}

import {
  attachBridgeSession,
  createCodeSession,
  fetchRemoteCredentials,
  isCreateSessionFailure,
  isCredentialsFailure,
} from "@anthropic-ai/claude-agent-sdk/bridge";
import type { RemoteControlResult, RemoteControlSink } from "../../core/types";
import type { HarnessAuth } from "./adapter";

/**
 * Remote control: publishing a session so a human can drive it from claude.ai/code
 * or the Claude mobile apps.
 *
 * This is OUR bridge, not the runtime's. The runtime has its own remote control
 * (`Query.enableRemoteControl`, settings `remoteControlAtStartup`), and the adapter
 * pins all of it OFF in every session — see the `settings` block in `adapter.ts`.
 * We own the bridge instead for one reason: the runtime's version puts it inside the
 * CLI subprocess, so text typed on a phone would reach the model without passing
 * through `core/framing.ts`. Owning it here means an inbound message is handed to the
 * core as plain text and becomes an ordinary framed, authority-checked, budgeted,
 * audited turn. Nothing reaches the model unframed.
 *
 * Facts established by probe against the live service (2026-07-26, SDK 0.3.220,
 * account on a Max subscription), because the API is `@alpha` and its own types
 * disagree with the CLI in places:
 *   - `createCodeSession` returns a `cse_`-prefixed id, 28 chars. (The `session_01…`
 *     form recorded in `~/.claude/sessions/*.json` belongs to the CLI's own
 *     remote-control route, not this one.)
 *   - `fetchRemoteCredentials` returns `{worker_jwt, api_base_url, expires_in,
 *     worker_epoch}` — plus an undocumented `mcp_config` we ignore. `expires_in` was
 *     28800 (8h). It can also return a TERMINAL failure (`untrusted_device`,
 *     `session_stale_relogin`); retrying those is guaranteed to fail.
 *   - `handle.isConnected()` is FALSE immediately after `attachBridgeSession`
 *     resolves, yet `write()` + `flush()` still succeed — the write path queues. Do
 *     not gate writes on `isConnected()`; nothing would ever be written.
 *
 * The `@alpha` disclaimer on this API is explicit that breaking changes do not bump
 * the package major, so `bun update` can break it. `scripts/smoke-remote-control.ts`
 * is the early warning.
 */

/** Remote control needs first-party claude.ai; the gate rejects anything else. */
const API_BASE = "https://api.anthropic.com";
const HTTP_TIMEOUT_MS = 30_000;
/** Bound on shutdown/teardown so a wedged transport cannot hang the daemon. */
const CLOSE_TIMEOUT_MS = 5_000;

/**
 * What we persist about a published session, opaque to the core
 * (`sessions.remote_control`). Versioned so the shape can grow without a migration —
 * the whole reason the column is TEXT rather than a flag.
 */
export interface RemoteHandle {
  v: 1;
  /** The `cse_*` id. */
  remoteSessionId: string;
  /** SSE high-water mark, so a re-attach resumes instead of replaying history. */
  seq: number;
  /** Where a human opens it. Cached so `remote-control on` can re-post the link. */
  url: string;
}

function parseHandle(raw: string | null | undefined): RemoteHandle | null {
  if (!raw) return null;
  try {
    const h = JSON.parse(raw) as RemoteHandle;
    return h && h.v === 1 && typeof h.remoteSessionId === "string" ? h : null;
  } catch {
    return null;
  }
}

/**
 * The operator's claude.ai OAuth access token.
 *
 * Read fresh on every attach and never cached: it is short-lived (~8h) and the CLI
 * refreshes this same store on every turn Condotto runs, so re-reading is what keeps
 * us current WITHOUT Condotto implementing OAuth refresh itself. A stale token is a
 * refusal with a remediation, never a silent failure.
 *
 * Never logged, never persisted, never put in a thread message. The scopes that
 * matter are minted by `claude auth login`; `claude setup-token` /
 * `CLAUDE_CODE_OAUTH_TOKEN` are inference-only and the service refuses them for
 * remote control, which is why this reads the login credential and nothing else.
 */
async function readAccessToken(): Promise<{ token: string } | { error: string }> {
  const raw = await readCredentialBlob();
  if (!raw) {
    return {
      error:
        "I couldn't find a Claude login on this machine. Remote control needs a claude.ai " +
        "subscription login — run `claude auth login` on the daemon host.",
    };
  }
  let cred: { accessToken?: string; expiresAt?: number } | undefined;
  try {
    cred = (JSON.parse(raw) as { claudeAiOauth?: typeof cred }).claudeAiOauth;
  } catch {
    return { error: "The stored Claude credential isn't readable. Try `claude auth login` again." };
  }
  if (!cred?.accessToken) {
    return {
      error:
        "The stored Claude credential has no access token. Remote control needs a full " +
        "`claude auth login`; a `setup-token` credential can only make model requests.",
    };
  }
  if (typeof cred.expiresAt === "number" && cred.expiresAt <= Date.now()) {
    return {
      error:
        "This machine's Claude login has expired. Run any `claude` command on the host to " +
        "refresh it, or `claude auth login` if that doesn't take.",
    };
  }
  return { token: cred.accessToken };
}

/** darwin keeps it in the keychain; elsewhere it is a file beside the CLI's config. */
async function readCredentialBlob(): Promise<string | null> {
  if (process.platform === "darwin") {
    const p = Bun.spawn(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(p.stdout).text();
    if ((await p.exited) === 0 && out.trim()) return out.trim();
    // Fall through: a linux-style file can exist on darwin too (CLAUDE_CONFIG_DIR).
  }
  const dir = process.env.CLAUDE_CONFIG_DIR ?? `${process.env.HOME}/.claude`;
  const f = Bun.file(`${dir}/.credentials.json`);
  return (await f.exists()) ? (await f.text()).trim() : null;
}

interface LiveBridge {
  handle: Awaited<ReturnType<typeof attachBridgeSession>>;
  remoteSessionId: string;
  url: string;
  sink: RemoteControlSink;
  closing: boolean;
}

/**
 * The adapter's published bridges, keyed by WORKTREE ROOT.
 *
 * Keyed by the worktree rather than by a `ClaudeCodeSession` instance on purpose:
 * the core rebuilds session objects whenever the posture changes or a turn throws, and
 * a bridge owned by an instance would hand the architect a new claude.ai link every
 * time they typed `subagents off`. The worktree path is stable and absolute for a
 * session's whole life (a core invariant), so it is the right identity. Turning a
 * bridge off is therefore always an explicit call, never a side effect of an object
 * being dropped.
 */
export class RemoteBridges {
  private live = new Map<string, LiveBridge>();

  constructor(private auth?: HarnessAuth) {}

  isLive(key: string): boolean {
    return this.live.has(key);
  }

  /**
   * Publish `key`'s session, or return the existing publication unchanged.
   * Idempotent: enabling twice re-posts the same link rather than minting a second
   * remote session.
   */
  async enable(
    key: string,
    opts: { name: string; handle?: string | null; sink: RemoteControlSink },
  ): Promise<RemoteControlResult> {
    const existing = this.live.get(key);
    if (existing) {
      return { ok: true, url: existing.url, handle: this.serialize(existing) };
    }

    // The credential the service will accept exists only under a subscription login.
    // Refuse here rather than letting the service reject us, so the thread gets a
    // sentence that names the fix.
    if (this.auth?.mode === "api_key") {
      return {
        ok: false,
        reason:
          "Remote control needs this machine's Claude subscription login, and this daemon is " +
          "authenticated with an API key. There's no claude.ai session behind an API key, so " +
          "the service refuses it. Switch `[auth].mode` to `subscription` to use it.",
      };
    }

    const tok = await readAccessToken();
    if ("error" in tok) return { ok: false, reason: tok.error };

    const prior = parseHandle(opts.handle);
    try {
      // Re-attaching to a session we already created keeps the SAME link alive across
      // a reconnect; only a genuinely new publication calls createCodeSession.
      const remoteSessionId = prior?.remoteSessionId ?? (await this.create(tok.token, opts.name));
      if (typeof remoteSessionId !== "string") return remoteSessionId;

      const creds = await fetchRemoteCredentials(remoteSessionId, API_BASE, tok.token, HTTP_TIMEOUT_MS);
      if (creds === null) {
        return { ok: false, reason: "claude.ai didn't answer when I asked for session credentials. Try again." };
      }
      if (isCredentialsFailure(creds)) {
        return { ok: false, reason: credentialFailureReason(creds.reason) };
      }

      const bridge: LiveBridge = {
        handle: undefined as unknown as LiveBridge["handle"],
        remoteSessionId,
        // Built from the id, not parsed from a service response: the handle exposes no
        // url and the core only ever posts this string.
        url: `https://claude.ai/code/${remoteSessionId}`,
        sink: opts.sink,
        closing: false,
      };

      bridge.handle = await attachBridgeSession({
        sessionId: remoteSessionId,
        ingressToken: creds.worker_jwt,
        apiBaseUrl: creds.api_base_url,
        // The fetch above IS the worker register and bumped the epoch, so passing it
        // back skips a redundant one.
        epoch: creds.worker_epoch,
        ...(prior ? { initialSequenceNum: prior.seq } : {}),
        onInboundMessage: (msg) => {
          const text = textOf(msg);
          // A frame we cannot read text out of is dropped rather than guessed at:
          // whatever it is, it is not a message we can frame and attribute.
          if (text) opts.sink.onRemoteInput(text);
        },
        // There is no approval step in this system, so there is no remote approve
        // path to build. Rejecting keeps the prompt eligible for redelivery instead
        // of answering it falsely.
        onPermissionResponse: () => false,
        onInterrupt: () => opts.sink.onRemoteInput("__condotto_interrupt__"),
        // Posture lives in the session row and is changed in the thread. An explicit
        // error is the honest answer; a silent success would leave the remote UI
        // showing a setting the session does not have.
        onSetModel: () => ({ ok: false as const, error: "Set the model in the thread: `@Condotto model <name>`." }),
        onSetPermissionMode: () => ({
          ok: false as const,
          error: "Permission mode is Condotto's to decide. Use `@Condotto plan on|off` in the thread.",
        }),
        onRenameSession: () => ({ ok: false as const, error: "The session name follows the repo and branch." }),
        onClose: (code) => {
          if (bridge.closing) return;
          this.live.delete(key);
          opts.sink.onClosed(closeReason(code));
        },
      });

      this.live.set(key, bridge);
      bridge.handle.reportState("idle");
      return { ok: true, url: bridge.url, handle: this.serialize(bridge) };
    } catch (err) {
      this.live.delete(key);
      return { ok: false, reason: `I couldn't reach claude.ai to publish this session (${err}).` };
    }
  }

  private async create(token: string, name: string): Promise<string | RemoteControlResult> {
    const created = await createCodeSession(API_BASE, token, name, HTTP_TIMEOUT_MS, ["condotto"]);
    if (created === null) {
      return { ok: false, reason: "claude.ai didn't answer when I asked it to create a session. Try again." };
    }
    if (isCreateSessionFailure(created)) {
      return { ok: false, reason: `claude.ai refused to create the session (${created.status}: ${created.detail ?? "no detail"}).` };
    }
    return created;
  }

  /** Stop publishing. Idempotent, never throws, bounded. */
  async disable(key: string): Promise<void> {
    const bridge = this.live.get(key);
    if (!bridge) return;
    bridge.closing = true;
    this.live.delete(key);
    await withTimeout(bridge.handle.flush(), CLOSE_TIMEOUT_MS).catch(() => {});
    try {
      bridge.handle.close();
    } catch {
      /* already gone */
    }
  }

  /**
   * Mirror one runtime message to the remote transcript. Called from the turn loop, so
   * it is synchronous and swallows everything: the thread is the authoritative
   * surface and a wedged bridge must never cost a turn.
   */
  write(key: string, msg: unknown): void {
    const bridge = this.live.get(key);
    if (!bridge) return;
    try {
      bridge.handle.write(msg as never);
    } catch {
      /* the transport retries internally; a lost mirror line is not a turn failure */
    }
  }

  /** Turn boundary — stops the remote UI's spinner. Same swallow-everything contract. */
  endTurn(key: string): void {
    const bridge = this.live.get(key);
    if (!bridge) return;
    try {
      bridge.handle.sendResult();
      bridge.handle.reportState("idle");
    } catch {
      /* see write() */
    }
  }

  /** Working/idle for the remote UI. Same contract. */
  reportWorking(key: string): void {
    const bridge = this.live.get(key);
    if (!bridge) return;
    try {
      bridge.handle.reportState("running");
    } catch {
      /* see write() */
    }
  }

  /**
   * The current opaque handle for `key`, or null when nothing is published. The core
   * re-persists this after a turn so the SSE cursor advances on disk.
   */
  handleFor(key: string): string | null {
    const bridge = this.live.get(key);
    return bridge ? this.serialize(bridge) : null;
  }

  /** Daemon shutdown. Closes every bridge, bounded, never throws. */
  async closeAll(): Promise<void> {
    const keys = [...this.live.keys()];
    await Promise.allSettled(keys.map((k) => this.disable(k)));
  }

  private serialize(bridge: LiveBridge): string {
    const h: RemoteHandle = {
      v: 1,
      remoteSessionId: bridge.remoteSessionId,
      seq: safeSeq(bridge),
      url: bridge.url,
    };
    return JSON.stringify(h);
  }
}

function safeSeq(bridge: LiveBridge): number {
  try {
    return bridge.handle.getSequenceNum();
  } catch {
    return 0;
  }
}

/** Pull human text out of an inbound frame, or null if there is none to read. */
function textOf(msg: unknown): string | null {
  const m = msg as { message?: { content?: unknown } } | undefined;
  const content = m?.message?.content;
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((b): b is { type: "text"; text: string } => {
      const blk = b as { type?: string; text?: unknown };
      return blk?.type === "text" && typeof blk.text === "string";
    })
    .map((b) => b.text)
    .join("\n")
    .trim();
  return text || null;
}

/** These are terminal — the SDK marks them as "retrying will fail identically". */
function credentialFailureReason(reason: string): string {
  switch (reason) {
    case "untrusted_device":
      return (
        "claude.ai doesn't trust this device for remote sessions yet. Sign in on the daemon " +
        "host with `claude auth login` and complete any device-verification step, then try again."
      );
    case "session_stale_relogin":
      return "This machine's claude.ai login is too old for a remote session. Run `claude auth login` on the host.";
    default:
      return `claude.ai refused to issue session credentials (${reason}).`;
  }
}

function closeReason(code?: number): string {
  switch (code) {
    case 401:
      return "the claude.ai login expired";
    case 4090:
      // Worker attach is epoch-exclusive. Reconnecting would just evict whoever took
      // it, so this one must not auto-retry.
      return "another machine took over this remote session";
    case 403:
    case 404:
      return "claude.ai rejected the session";
    default:
      return code === undefined ? "the connection ended" : `the connection ended (${code})`;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | void> {
  return Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]);
}

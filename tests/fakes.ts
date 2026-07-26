// Fake adapters exercising both ports without any platform dependency.
import type {
  Attachment,
  ChoicePrompt,
  ConversationRef,
  GateFn,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessSession,
  HarnessSkill,
  HarnessTurnOptions,
  InboundEvent,
  OutboundFile,
  OutboundMessage,
  PostedRef,
  RemoteControlResult,
  RemoteControlSink,
  SessionHandle,
  SurfaceAdapter,
  SurfaceCapabilities,
  ToolCall,
  TurnEvent,
  TurnInput,
} from "../src/core/types";

export class FakeSurface implements SurfaceAdapter {
  readonly id = "fake";
  readonly capabilities: SurfaceCapabilities;

  /** identityStrength defaults to "verified"; pass "weak" for spoofable-surface tests. */
  constructor(identityStrength: "verified" | "weak" = "verified") {
    this.capabilities = { threads: true, editMessages: true, buttons: true, attachments: true, identityStrength };
  }

  posts: { conv: ConversationRef; text: string; messageId: string }[] = [];
  updates: { messageId: string; text: string }[] = [];
  choiceRequests: { conv: ConversationRef; prompt: ChoicePrompt }[] = [];
  /** Files posted back to the thread, in order. */
  postedFiles: { conv: ConversationRef; name: string; comment?: string; bytes: string }[] = [];
  /** Bytes this fake will hand back per attachment `ref`; absent = a failed download. */
  attachmentBytes = new Map<string, Uint8Array>();
  fetched: string[] = [];
  private nextId = 1;

  async start(_emit: (e: InboundEvent) => void): Promise<void> {}
  async stop(): Promise<void> {}

  async post(conv: ConversationRef, msg: OutboundMessage): Promise<PostedRef> {
    const messageId = `fake-msg-${this.nextId++}`;
    this.posts.push({ conv, text: msg.text, messageId });
    return { conv, messageId };
  }

  async update(ref: PostedRef, msg: OutboundMessage): Promise<void> {
    this.updates.push({ messageId: ref.messageId, text: msg.text });
  }

  async fetchAttachment(a: Attachment): Promise<Uint8Array | null> {
    this.fetched.push(a.ref ?? "");
    return this.attachmentBytes.get(a.ref ?? "") ?? null;
  }

  async postFile(conv: ConversationRef, file: OutboundFile): Promise<void> {
    this.postedFiles.push({
      conv,
      name: file.name,
      ...(file.comment ? { comment: file.comment } : {}),
      bytes: await Bun.file(file.path).text(),
    });
  }


  async requestChoice(conv: ConversationRef, prompt: ChoicePrompt): Promise<void> {
    this.choiceRequests.push({ conv, prompt });
  }

  /** The most recent guided-choice prompt (for tests to answer). */
  lastChoice(): ChoicePrompt | undefined {
    return this.choiceRequests.at(-1)?.prompt;
  }


  /** All texts a human in the conversation would have seen, in order. */
  transcript(): string[] {
    return [...this.posts.map((p) => p.text), ...this.updates.map((u) => u.text)];
  }
}

interface FakeHandle {
  fake: true;
  sessionId: string | null;
  system: string;
  /** A tool call deferred on a prior turn, awaiting re-drive on resume. */
  pending?: ToolCall | null;
}

class FakeHarnessSession implements HarnessSession {
  turns: TurnInput[] = [];
  gateCalls: ToolCall[] = [];

  constructor(
    private _handle: FakeHandle,
    public cwd: string,
    private parent: FakeHarness,
  ) {}

  get handle(): SessionHandle {
    return this._handle;
  }

  listSkills(): readonly HarnessSkill[] | null {
    return this.parent.skills;
  }

  async setRemoteControl(
    enabled: boolean,
    opts: { name: string; handle?: string | null; sink: RemoteControlSink },
  ): Promise<RemoteControlResult> {
    this.parent.remoteCalls.push({ enabled, name: opts.name, handle: opts.handle ?? null });
    if (enabled) this.parent.remoteSink = opts.sink;
    else this.parent.remoteSink = null;
    if (this.parent.remoteRefusal) return { ok: false, reason: this.parent.remoteRefusal };
    if (!enabled) return { ok: true, url: "", handle: "" };
    const url = `https://claude.ai/code/cse_fake${++this.parent.remoteSeq}`;
    return { ok: true, url, handle: JSON.stringify({ v: 1, remoteSessionId: `cse_fake${this.parent.remoteSeq}`, seq: 0, url }) };
  }

  async *turn(input: TurnInput, gate: GateFn): AsyncIterable<TurnEvent> {
    this.turns.push(input);
    this.parent.allTurns.push({
      cwd: this.cwd,
      text: input.text,
      budgetUsd: input.budgetUsd,
      harness: input.harness,
      ...(input.skill ? { skill: input.skill } : {}),
    });
    if (this.parent.beforeReply) await this.parent.beforeReply();
    // Simulate a turn that ends in an error carrying a cost (e.g. the SDK's
    // error_max_budget_usd), for cost-accounting tests.
    if (this.parent.nextError) {
      const e = this.parent.nextError;
      this.parent.nextError = null;
      if (this._handle.sessionId === null) {
        this._handle = { ...this._handle, sessionId: `fake-session-${++this.parent.sessionSeq}` };
        yield { kind: "handle_updated", handle: this._handle };
      }
      yield { kind: "error", message: e.message, costUsd: e.costUsd };
      return;
    }
    if (this._handle.sessionId === null) {
      this._handle = { ...this._handle, sessionId: `fake-session-${++this.parent.sessionSeq}` };
      yield { kind: "handle_updated", handle: this._handle };
    }

    // Resume path: re-drive a call deferred on a prior turn (the SDK re-runs it
    // through the gate first, where a recorded decision now resolves it).
    if (this._handle.pending) {
      const call = this._handle.pending;
      this.gateCalls.push(call);
      const d = await gate(call);
      let note: string;
      if (d.decision === "allow") {
        this.parent.executed.push(call);
        note = `applied ${call.name}`;
      } else if (d.decision === "deny") {
        note = `did not run ${call.name} — ${d.reason}`;
      } else {
        note = `still gated: ${call.name}`;
      }
      this._handle = { ...this._handle, pending: null };
      yield { kind: "handle_updated", handle: this._handle };
      const scripted = this.parent.nextScript();
      if (scripted) {
        for (const c of scripted) {
          this.gateCalls.push(c);
          const dd = await gate(c);
          if (dd.decision === "allow") this.parent.executed.push(c);
        }
      }
      yield { kind: "reply", text: `${note}${scripted ? ` (+ran ${scripted.length})` : ""}`, costUsd: 0.01 };
      return;
    }

    // A scripted turn (gating tests): run the queued tool calls in order.
    const scripted = this.parent.nextScript();
    if (scripted) {
      const denials: string[] = [];
      for (const call of scripted) {
        this.gateCalls.push(call);
        const d = await gate(call);
        yield { kind: "progress", text: `attempting ${call.name}` };
        if (d.decision === "allow") this.parent.executed.push(call);
        // A deny is fed back to the agent, which adapts — reflect the reason.
        if (d.decision === "deny") denials.push(d.reason);
      }
      const suffix = denials.length ? ` (denied: ${denials.join("; ")})` : "";
      yield { kind: "reply", text: `echo(${this._handle.sessionId}) ran ${scripted.length} call(s)${suffix}`, costUsd: 0.01 };
      return;
    }

    // Default (echo) behavior: one in-worktree read (allowed) and one escape
    // attempt (denied), then a reply that reports both gate decisions.
    const inside: ToolCall = { id: "t1", name: "Read", input: { file_path: "README.md" } };
    const outside: ToolCall = { id: "t2", name: "Read", input: { file_path: "/etc/hosts" } };
    this.gateCalls.push(inside, outside);
    const insideDecision = await gate(inside);
    const outsideDecision = await gate(outside);
    // Optional burst of progress events (for testing status throttling).
    for (let i = 0; i < this.parent.progressBurst; i++) {
      yield { kind: "progress", text: `step ${i + 1}` };
    }
    yield { kind: "progress", text: "reading README.md" };
    yield {
      kind: "reply",
      text:
        `echo(${this._handle.sessionId}) gate=${insideDecision.decision},${outsideDecision.decision}: ` +
        input.text.slice(-60),
      costUsd: 0.01,
    };
  }

  async interrupt(): Promise<void> {
    // Record the cancel + let a test release a held turn (models the real
    // adapter halting its query). The turn's own cancellation notice is covered by
    // the adapter-level tests; here we only assert the manager wired interrupt().
    this.parent.interruptCount++;
    this.parent.onInterrupt?.();
  }
}

export class FakeHarness implements HarnessAdapter {
  readonly id = "fake-harness";
  // Mutable on purpose: a test that wants the "this harness can't do X" refusal
  // flips a flag here rather than defining a second fake.
  capabilities: HarnessCapabilities = {
    mechanicalGating: true,
    resumeAfterRestart: true,
    costReporting: true,
    imageInput: false,
    supportedModels: ["opus", "sonnet", "fable"],
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    skillInvocation: true,
    planMode: true,
    remoteControl: true,
  };

  sessionSeq = 0;
  /** Every setRemoteControl call, so a test can assert order and arguments. */
  remoteCalls: { enabled: boolean; name: string; handle: string | null }[] = [];
  /** The live sink, so a test can push an inbound message as if from the app. */
  remoteSink: RemoteControlSink | null = null;
  /** Set to make publishing refuse with this reason (auth mode, stale credential…). */
  remoteRefusal: string | null = null;
  remoteSeq = 0;
  /** Bridges closed by the adapter-wide shutdown hook. */
  shutdownCalls = 0;
  created: { cwd: string; system: string; root?: string }[] = [];
  resumed: { handle: SessionHandle; cwd: string; system: string; root?: string }[] = [];
  allTurns: {
    cwd: string;
    text: string;
    budgetUsd?: number;
    harness?: HarnessTurnOptions;
    skill?: { name: string; args?: string };
  }[] = [];
  /**
   * What `listSkills()` reports. `null` models a harness that cannot enumerate
   * (the core must then refuse rather than dispatch an unvetted name).
   */
  skills: HarnessSkill[] | null = null;
  /** Tool calls the gate allowed to run (approved or auto-allowed). */
  executed: ToolCall[] = [];
  /** Queue of scripted tool-call lists, one per upcoming fresh turn. */
  private scripts: ToolCall[][] = [];
  /** Queue of scripted calls for an upcoming empty-prompt RESUME. */
  private resumeScripts: ToolCall[][] = [];
  /** Test hook: awaited at the start of every turn (lets tests hold a turn open). */
  beforeReply: (() => Promise<void>) | null = null;
  /** Number of extra progress events the default turn emits (status-throttle tests). */
  progressBurst = 0;
  /** If set, the next turn ends in an error carrying this cost (budget tests). */
  nextError: { message: string; costUsd?: number } | null = null;
  /** How many times a live session's interrupt() was called (cancel tests). */
  interruptCount = 0;
  /** Fired inside interrupt() so a test can release a held turn. */
  onInterrupt: (() => void) | null = null;

  /** Queue the tool calls the agent will attempt on its next fresh turn. */
  scriptTurn(calls: ToolCall[]): void {
    this.scripts.push(calls);
  }

  nextScript(): ToolCall[] | null {
    return this.scripts.shift() ?? null;
  }

  /** Queue calls the agent attempts during the next empty-prompt resume. */
  scriptResume(calls: ToolCall[]): void {
    this.resumeScripts.push(calls);
  }

  nextResumeScript(): ToolCall[] | null {
    return this.resumeScripts.shift() ?? null;
  }

  async create(opts: { cwd: string; system: string; root?: string }): Promise<HarnessSession> {
    this.created.push(opts);
    return new FakeHarnessSession({ fake: true, sessionId: null, system: opts.system }, opts.cwd, this);
  }

  async resume(handle: SessionHandle, cwd: string, system: string, root?: string): Promise<HarnessSession> {
    this.resumed.push({ handle, cwd, system, root });
    // Reflect the freshly-supplied prompt, as the real adapter does.
    return new FakeHarnessSession({ ...(handle as FakeHandle), system }, cwd, this);
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls++;
    this.remoteSink = null;
  }
}


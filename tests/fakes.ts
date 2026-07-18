// Fake adapters exercising both ports without any platform dependency.
import type {
  ApprovalPrompt,
  ConversationRef,
  GateFn,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessSession,
  InboundEvent,
  OutboundMessage,
  PostedRef,
  SessionHandle,
  SurfaceAdapter,
  SurfaceCapabilities,
  ToolCall,
  TurnEvent,
  TurnInput,
} from "../src/core/types";

export class FakeSurface implements SurfaceAdapter {
  readonly id = "fake";
  readonly capabilities: SurfaceCapabilities = {
    threads: true,
    editMessages: true,
    buttons: true,
    attachments: true,
    identityStrength: "verified",
  };

  posts: { conv: ConversationRef; text: string; messageId: string }[] = [];
  updates: { messageId: string; text: string }[] = [];
  approvalRequests: { conv: ConversationRef; req: ApprovalPrompt }[] = [];
  /** When true, requestApproval throws (simulates a Slack post failure). */
  failApprovals = false;
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

  async requestApproval(conv: ConversationRef, req: ApprovalPrompt): Promise<void> {
    if (this.failApprovals) throw new Error("fake: approval post failed");
    this.approvalRequests.push({ conv, req });
  }

  /** The requestId of the most recent approval prompt (for tests to decide). */
  lastApprovalRequestId(): string | undefined {
    return this.approvalRequests.at(-1)?.req.requestId;
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

  async *turn(input: TurnInput, gate: GateFn): AsyncIterable<TurnEvent> {
    this.turns.push(input);
    this.parent.allTurns.push({ cwd: this.cwd, text: input.text, budgetUsd: input.budgetUsd });
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
      // An empty-prompt resume (approval decision) is done here. A resume that
      // also carries a fresh human instruction continues into its scripted work
      // after the leftover call is resolved (models the agent moving on).
      if (input.text.trim().length === 0) {
        yield { kind: "reply", text: note, costUsd: 0.01 };
        return;
      }
      const scripted = this.parent.nextScript();
      if (scripted) {
        for (const c of scripted) {
          this.gateCalls.push(c);
          const dd = await gate(c);
          if (dd.decision === "gate") {
            this._handle = { ...this._handle, pending: c };
            yield { kind: "handle_updated", handle: this._handle };
            yield { kind: "deferred", call: c };
            return;
          }
          if (dd.decision === "allow") this.parent.executed.push(c);
        }
      }
      yield { kind: "reply", text: `${note}${scripted ? ` (+ran ${scripted.length})` : ""}`, costUsd: 0.01 };
      return;
    }

    // A scripted turn (M2 gating tests): run the queued tool calls in order.
    const scripted = this.parent.nextScript();
    if (scripted) {
      const denials: string[] = [];
      for (const call of scripted) {
        this.gateCalls.push(call);
        const d = await gate(call);
        if (d.decision === "gate") {
          // Deferred: end the turn with this call preserved for resume.
          this._handle = { ...this._handle, pending: call };
          yield { kind: "handle_updated", handle: this._handle };
          yield { kind: "progress", text: `attempting ${call.name}` };
          yield { kind: "deferred", call };
          return;
        }
        if (d.decision === "allow") this.parent.executed.push(call);
        // A deny is fed back to the agent, which adapts — reflect the reason.
        if (d.decision === "deny") denials.push(d.reason);
      }
      const suffix = denials.length ? ` (denied: ${denials.join("; ")})` : "";
      yield { kind: "reply", text: `echo(${this._handle.sessionId}) ran ${scripted.length} call(s)${suffix}`, costUsd: 0.01 };
      return;
    }

    // Default (M1 echo) behavior: one in-worktree read (allowed) and one escape
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

  async interrupt(): Promise<void> {}
}

export class FakeHarness implements HarnessAdapter {
  readonly id = "fake-harness";
  readonly capabilities: HarnessCapabilities = {
    mechanicalGating: true,
    resumeAfterRestart: true,
    costReporting: true,
    imageInput: false,
  };

  sessionSeq = 0;
  created: { cwd: string; system: string }[] = [];
  resumed: { handle: SessionHandle; cwd: string; system: string }[] = [];
  allTurns: { cwd: string; text: string; budgetUsd?: number }[] = [];
  /** Tool calls the gate allowed to run (approved or auto-allowed). */
  executed: ToolCall[] = [];
  /** Queue of scripted tool-call lists, one per upcoming fresh turn. */
  private scripts: ToolCall[][] = [];
  /** Test hook: awaited at the start of every turn (lets tests hold a turn open). */
  beforeReply: (() => Promise<void>) | null = null;
  /** Number of extra progress events the default turn emits (status-throttle tests). */
  progressBurst = 0;
  /** If set, the next turn ends in an error carrying this cost (budget tests). */
  nextError: { message: string; costUsd?: number } | null = null;

  /** Queue the tool calls the agent will attempt on its next fresh turn. */
  scriptTurn(calls: ToolCall[]): void {
    this.scripts.push(calls);
  }

  nextScript(): ToolCall[] | null {
    return this.scripts.shift() ?? null;
  }

  async create(opts: { cwd: string; system: string }): Promise<HarnessSession> {
    this.created.push(opts);
    return new FakeHarnessSession({ fake: true, sessionId: null, system: opts.system }, opts.cwd, this);
  }

  async resume(handle: SessionHandle, cwd: string, system: string): Promise<HarnessSession> {
    this.resumed.push({ handle, cwd, system });
    // Reflect the freshly-supplied prompt, as the real adapter does.
    return new FakeHarnessSession({ ...(handle as FakeHandle), system }, cwd, this);
  }
}

/** Fake land/deploy command runner — records calls, returns a canned result. */
export class FakeCommandRunner {
  calls: { command: string; cwd: string }[] = [];
  result: { code: number | null; output: string; timedOut: boolean } = {
    code: 0,
    output: "[land] no-op",
    timedOut: false,
  };
  async run(command: string, cwd: string): Promise<{ code: number | null; output: string; timedOut: boolean }> {
    this.calls.push({ command, cwd });
    return this.result;
  }
}

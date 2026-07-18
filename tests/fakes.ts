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

  async requestApproval(_conv: ConversationRef, _req: ApprovalPrompt): Promise<void> {}

  /** All texts a human in the conversation would have seen, in order. */
  transcript(): string[] {
    return [...this.posts.map((p) => p.text), ...this.updates.map((u) => u.text)];
  }
}

interface FakeHandle {
  fake: true;
  sessionId: string | null;
  system: string;
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
    this.parent.allTurns.push({ cwd: this.cwd, text: input.text });
    if (this._handle.sessionId === null) {
      this._handle = { ...this._handle, sessionId: `fake-session-${++this.parent.sessionSeq}` };
      yield { kind: "handle_updated", handle: this._handle };
    }
    const call: ToolCall = { id: "t1", name: "Read", input: { file_path: "README.md" } };
    this.gateCalls.push(call);
    const decision = await gate(call);
    yield { kind: "progress", text: "reading README.md" };
    yield {
      kind: "reply",
      text: `echo(${this._handle.sessionId}) gate=${decision.decision}: ${input.text.slice(-60)}`,
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
  resumed: { handle: SessionHandle; cwd: string }[] = [];
  allTurns: { cwd: string; text: string }[] = [];

  async create(opts: { cwd: string; system: string }): Promise<HarnessSession> {
    this.created.push(opts);
    return new FakeHarnessSession(
      { fake: true, sessionId: null, system: opts.system },
      opts.cwd,
      this,
    );
  }

  async resume(handle: SessionHandle, cwd: string): Promise<HarnessSession> {
    this.resumed.push({ handle, cwd });
    return new FakeHarnessSession(handle as FakeHandle, cwd, this);
  }
}

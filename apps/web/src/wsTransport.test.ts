// FILE: wsTransport.test.ts
// Purpose: Verifies browser WebSocket construction around the Effect RPC transport.
// Layer: Web transport tests
// Depends on: the global WebSocket constructor shim and desktop bridge URL contract.

import { ServerBusyController } from "./serverBusyState";
import { Cause, Effect, Exit, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CommandId,
  MessageId,
  type ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  ThreadId,
  WS_CHANNELS,
  WS_METHODS,
  WS_COMPATIBILITY_QUERY,
  WS_NEGOTIATE_QUERY,
  WS_PROTOCOL_EPOCH,
  WS_PROTOCOL_MAX_REVISION,
  WS_PROTOCOL_MIN_REVISION,
  WS_PROJECT_FILE_WATCH_CAPABILITY,
  WS_TURN_DISPATCH_SETTLEMENT_CAPABILITY,
  WS_GIT_ACTION_RECOVERY_CAPABILITY,
  WS_SERVER_RUNTIME_STATUS_CAPABILITY,
  WsCompatibilityError,
  type WsBootstrapNegotiateResult,
} from "@synara/contracts";

import {
  shouldKeepServerLifecycleStream,
  getUnexpectedStreamCompletionRetryDelayMs,
  getReconnectRetryDelayMs,
  getProjectFileWatchRetryDelayMs,
  getStreamCapacityRetryDelayMs,
  getStreamDuplicateRetryDelayMs,
  getThreadSnapshotBootstrapRetryDelayMs,
  getTerminalCompatibilityError,
  isTerminalCompatibilityFailure,
  makeFeatureSocketUrl,
  makeNegotiateHttpUrl,
  getResnapshotRetryDelayMs,
  getSnapshotFaultRetryDelayMs,
  getUnaryRpcCapacityRetryDelayMs,
  MAX_UNARY_RPC_CAPACITY_RETRY_ATTEMPTS,
  MAX_PROJECT_FILE_WATCH_RETRY_ATTEMPTS,
  SNAPSHOT_FAULT_RETRY_MS,
  isRuntimeInterruptFailure,
  makeRequestAbortScope,
  negotiateOverHttp,
  serverIdentityChanged,
  MAX_RESNAPSHOT_RETRY_ATTEMPTS,
  MAX_STREAM_DUPLICATE_RETRY_ATTEMPTS,
  MAX_THREAD_SNAPSHOT_BOOTSTRAP_RETRY_ATTEMPTS,
  resolveStreamAdmissionRetry,
  shouldReconnectAfterStreamFailure,
  threadStreamInputsEqual,
  projectFileChangeStreamKey,
  WsTransport,
  WsTransportRequestInterruptedError,
  type WsThreadStreamFailure,
} from "./wsTransport";
import {
  advanceThreadDetailResumeCursor,
  buildThreadSubscribeInput,
  hasThreadDetailResumeCursor,
  resetThreadDetailResumeCursorsForTests,
} from "./threadDetailResumeCursors";
import {
  addWsCompatibilityIssueListener,
  emitWsCompatibilityIssue,
  getWsSettlingThreadIds,
  readLatestWsCompatibilityIssue,
} from "./wsTransportEvents";

type WsEventType = "open" | "message" | "close" | "error";
type WsListener = (event?: { data?: unknown }) => void;

const sockets: MockWebSocket[] = [];

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  readonly sent: unknown[] = [];
  onSend: ((data: string) => void) | null = null;
  private readonly listeners = new Map<WsEventType, Set<WsListener>>();

  constructor(readonly url: string) {
    sockets.push(this);
  }

  addEventListener(type: WsEventType, listener: WsListener) {
    const listeners = this.listeners.get(type) ?? new Set<WsListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: WsEventType, listener: WsListener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: unknown) {
    this.sent.push(data);
    this.onSend?.(String(data));
  }

  close(code?: number, reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", { code: code ?? 1000, reason: reason ?? "" } as never);
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open");
  }

  receive(data: string) {
    this.emit("message", { data });
  }

  // Answers Effect RPC frames so unit tests can complete a feature-socket
  // session: Ping gets a Pong and every request gets a successful void Exit.
  serveVoidRpc() {
    this.onSend = (data) => {
      const frame = JSON.parse(data) as Record<string, unknown>;
      if (frame._tag === "Ping") {
        this.receive(JSON.stringify({ _tag: "Pong" }));
      } else if (frame._tag === "Request" && typeof frame.id === "string") {
        this.receive(
          JSON.stringify({
            _tag: "Exit",
            requestId: frame.id,
            exit: { _tag: "Success", value: null },
          }),
        );
      }
    };
    this.open();
  }

  private emit(type: WsEventType, event?: { data?: unknown }) {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      listener(event);
    }
  }
}

const originalWebSocket = globalThis.WebSocket;

interface WsTransportInternals {
  readonly streamCleanups: Map<string, () => void>;
  readonly streamSettled: Map<string, Promise<void>>;
  readonly streamCapacityRetries: Map<string, number>;
  readonly streamDuplicateRetries: Map<string, number>;
  readonly streamThreadBootstrapRetries: Map<string, number>;
  readonly streamResnapshotRetries: Map<string, number>;
  readonly projectFileWatchRetries: Map<string, number>;
  readonly streamCapacityRetryTimers: Map<string, number>;
  readonly streamOverflowRetries: Map<string, number>;
  readonly streamCompletionRetries: Map<string, number>;
  readonly streamCompletionRetryTimers: Map<string, number>;
  readonly activeThreadStreamInputs: Map<string, unknown>;
  readonly threadSubscriptions: Map<string, unknown>;
  readonly projectFileSubscriptions: Map<
    string,
    { readonly input: { cwd: string; relativePath: string }; readonly listeners: Set<unknown> }
  >;
  readonly projectAgentSubscriptions: Map<string, unknown>;
  shellSubscribed: boolean;
  readonly threadStreamFailureListeners: Set<(failure: WsThreadStreamFailure) => void>;
  disposed: boolean;
  sessionVersion: number;
  reconnect(): Promise<unknown>;
  openReconnectSession(): Promise<unknown>;
  getClient(): Promise<unknown>;
  startStream<T>(
    client: unknown,
    key: string,
    stream: unknown,
    listener: (event: T) => void,
    restart?: () => void,
  ): void;
  startThreadStream(
    client: unknown,
    threadId: string,
    input: unknown,
    forceRestart?: boolean,
  ): Promise<void>;
  startProjectFileChangeStream(client: unknown, key: string, subscription: unknown): void;
  startProjectAgentEventStream(client: unknown, projectId: string, params: unknown): void;
  stopStream(key: string, options?: { readonly resetCapacityRetry?: boolean }): Promise<void>;
  emitThreadStreamFailure(failure: WsThreadStreamFailure): void;
}

function makeBareTransport(): {
  readonly transport: WsTransport;
  readonly internals: WsTransportInternals;
} {
  const transport = Object.create(WsTransport.prototype) as WsTransport;
  const internals = transport as unknown as WsTransportInternals;
  Object.assign(internals, {
    streamCleanups: new Map(),
    streamSettled: new Map(),
    streamCapacityRetries: new Map(),
    streamDuplicateRetries: new Map(),
    streamThreadBootstrapRetries: new Map(),
    streamResnapshotRetries: new Map(),
    projectFileWatchRetries: new Map(),
    streamCapacityRetryTimers: new Map(),
    streamOverflowRetries: new Map(),
    streamCompletionRetries: new Map(),
    streamCompletionRetryTimers: new Map(),
    activeThreadStreamInputs: new Map(),
    threadSubscriptions: new Map(),
    projectFileSubscriptions: new Map(),
    projectAgentSubscriptions: new Map(),
    threadStreamFailureListeners: new Set(),
    shellStreamFailureListeners: new Set(),
    disposed: false,
    lifetime: new AbortController(),
    sessionVersion: 1,
    getClientRuntime: () => ({
      runCallback: (
        effect: Effect.Effect<unknown, Error>,
        options: { readonly onExit: (exit: Exit.Exit<unknown, Error>) => void },
      ) =>
        Effect.runCallback(effect, {
          onExit: (exit) => {
            void Promise.resolve().then(() => options.onExit(exit));
          },
        }),
    }),
    reconnect: vi.fn(async () => ({})),
  });
  return { transport, internals };
}

function bindWindowTimersToCurrentGlobals(): void {
  Object.assign(window, {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  });
}

const NEGOTIATION_RESULT: WsBootstrapNegotiateResult = {
  protocolEpoch: WS_PROTOCOL_EPOCH,
  negotiatedRevision: WS_PROTOCOL_MAX_REVISION,
  serverBuild: "test-server",
  serverInstanceId: "server-instance-1",
  capabilities: ["transport.http-negotiate"],
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

async function waitForSockets(count: number): Promise<void> {
  for (let attempt = 0; attempt < 50 && sockets.length < count; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(sockets.length).toBeGreaterThanOrEqual(count);
}

beforeEach(() => {
  sockets.length = 0;
  vi.stubEnv("VITE_WS_URL", "");
  // Default to an older server without the HTTP negotiate endpoint so
  // connection tests exercise the legacy bootstrap fallback unless they
  // install their own fetch stub.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("http negotiate unavailable"))),
  );

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { protocol: "http:", hostname: "localhost", port: "3020" },
      desktopBridge: undefined,
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    },
  });

  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("keeps a silent open socket and RPC alive until a late response", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, {
          ...NEGOTIATION_RESULT,
        }),
      ),
    ),
  );
  vi.useFakeTimers();
  bindWindowTimersToCurrentGlobals();
  const transport = new WsTransport("ws://localhost:3020");
  try {
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0]!;
    socket.serveVoidRpc();
    await vi.waitFor(() => expect(transport.getState()).toBe("open"));
    socket.onSend = null;
    const start = socket.sent.length;
    const pending = transport.request(
      WS_METHODS.terminalClose,
      { threadId: "late-rpc", terminalId: "terminal-1" },
      {
        timeoutMs: null,
      },
    );
    const verdict = pending.catch((error) => error);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(sockets).toHaveLength(1);
    expect(transport.getState()).toBe("open");
    expect(socket.readyState).toBe(MockWebSocket.OPEN);
    socket.receive(JSON.stringify({ _tag: "Pong" }));
    const request = socket.sent
      .slice(start)
      .map((data) => JSON.parse(String(data)))
      .find((frame) => frame._tag === "Request" && frame.tag === WS_METHODS.terminalClose);
    expect(request).toBeDefined();
    const status = null;
    socket.receive(
      JSON.stringify({
        _tag: "Exit",
        requestId: request.id,
        exit: { _tag: "Success", value: status },
      }),
    );
    expect(await verdict).toBeUndefined();
    socket.close(1006, "real connection loss after recovery");
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1]!.serveVoidRpc();
    await vi.waitFor(() => expect(transport.getState()).toBe("open"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
  } finally {
    await transport.dispose();
    vi.useRealTimers();
  }
});

it.each([false, true])(
  "waits for a silent feature probe without reconnect loops (recovery: %s)",
  async (recovery) => {
    vi.useFakeTimers();
    bindWindowTimersToCurrentGlobals();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(200, NEGOTIATION_RESULT))),
    );
    const transport = new WsTransport("ws://localhost:3020");
    try {
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      if (recovery) {
        sockets[0]!.serveVoidRpc();
        await vi.waitFor(() => expect(transport.getState()).toBe("open"));
        const recovering = (transport as unknown as WsTransportInternals).reconnect();
        void recovering.catch(() => undefined);
        await vi.waitFor(() => expect(sockets).toHaveLength(2));
      }
      const socket = sockets[recovery ? 1 : 0]!;
      socket.open();
      await vi.advanceTimersByTimeAsync(70_000);
      expect(sockets).toHaveLength(recovery ? 2 : 1);
      expect(socket.readyState).toBe(MockWebSocket.OPEN);
      expect(transport.getState()).toBe("connecting");
      const request = socket.sent
        .map((data) => JSON.parse(String(data)))
        .find(
          (frame) =>
            frame._tag === "Request" && frame.tag === ORCHESTRATION_WS_METHODS.unsubscribeShell,
        );
      expect(request).toBeDefined();
      socket.receive(
        JSON.stringify({
          _tag: "Exit",
          requestId: request.id,
          exit: { _tag: "Success", value: null },
        }),
      );
      await vi.waitFor(() => expect(transport.getState()).toBe("open"));
    } finally {
      await transport.dispose();
      vi.useRealTimers();
    }
  },
);

it("allows a slow WebSocket upgrade without a short handshake reconnect loop", async () => {
  vi.useFakeTimers();
  bindWindowTimersToCurrentGlobals();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(jsonResponse(200, NEGOTIATION_RESULT))),
  );
  const transport = new WsTransport("ws://localhost:3020");
  try {
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(70_000);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.readyState).toBe(MockWebSocket.CONNECTING);
    sockets[0]!.serveVoidRpc();
    await vi.waitFor(() => expect(transport.getState()).toBe("open"));
  } finally {
    await transport.dispose();
    vi.useRealTimers();
  }
});

it("disposes a silent feature probe and stops its keepalives promptly", async () => {
  vi.useFakeTimers();
  bindWindowTimersToCurrentGlobals();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(jsonResponse(200, NEGOTIATION_RESULT))),
  );
  const transport = new WsTransport("ws://localhost:3020");
  try {
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0]!;
    socket.open();
    await vi.advanceTimersByTimeAsync(15_000);
    await transport.dispose();
    const sent = socket.sent.length;
    await vi.advanceTimersByTimeAsync(70_000);
    expect(sockets).toHaveLength(1);
    expect(socket.sent).toHaveLength(sent);
    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
    expect(transport.getState()).toBe("disposed");
  } finally {
    await transport.dispose();
    vi.useRealTimers();
  }
});

it("recovers a failed thread subscription on a responsive session using its latest cursor", async () => {
  vi.useFakeTimers();
  bindWindowTimersToCurrentGlobals();
  const { internals } = makeBareTransport();
  const threadId = ThreadId.makeUnsafe("healthy-session-failed-subscription");
  const input = { threadId, afterSequence: 5 };
  const subscribe = vi
    .fn()
    .mockReturnValueOnce(Stream.fail(new Error("transport blip")))
    .mockReturnValue(Stream.never);
  const client = { [ORCHESTRATION_WS_METHODS.subscribeThread]: subscribe };
  Object.assign(internals, { getClient: async () => client, emit: vi.fn() });
  internals.threadSubscriptions.set(threadId, input);
  try {
    await internals.startThreadStream(client, threadId, input);
    await vi.advanceTimersByTimeAsync(0);
    advanceThreadDetailResumeCursor(threadId, 12);
    await vi.advanceTimersByTimeAsync(500);
    expect(internals.reconnect).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(subscribe).toHaveBeenLastCalledWith({ threadId, afterSequence: 12, batchReplay: true });
  } finally {
    internals.disposed = true;
    await internals.stopStream(`orchestration.thread:${threadId}`);
    resetThreadDetailResumeCursorsForTests();
    vi.useRealTimers();
  }
});

it.each([false, true])(
  "recovers a half-open feature socket after prolonged silence (probe pending: %s)",
  async (probePending) => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
    });
    bindWindowTimersToCurrentGlobals();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(200, NEGOTIATION_RESULT))),
    );
    resetThreadDetailResumeCursorsForTests();
    const transport = new WsTransport("ws://remote.synara.test:3020");
    const threadId = ThreadId.makeUnsafe("half-open-resume");
    try {
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      const socket = sockets[0]!;
      if (probePending) socket.open();
      else {
        socket.serveVoidRpc();
        await vi.waitFor(() => expect(transport.getState()).toBe("open"));
        // Leave a real stream pending on the multiplexed socket. The cursor
        // represents successfully applied events, not unacknowledged input.
        socket.onSend = null;
        await transport.request(ORCHESTRATION_WS_METHODS.subscribeThread, { threadId });
        advanceThreadDetailResumeCursor(threadId, 42);
      }
      await vi.advanceTimersByTimeAsync(175_000);
      expect(sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => expect(sockets).toHaveLength(2));
      expect(socket.readyState).toBe(MockWebSocket.CLOSED);
      const replacement = sockets[1]!;
      replacement.onSend = (data) => {
        const frame = JSON.parse(data);
        if (frame._tag === "Ping") replacement.receive(JSON.stringify({ _tag: "Pong" }));
        else if (
          frame._tag === "Request" &&
          frame.tag === ORCHESTRATION_WS_METHODS.unsubscribeShell
        )
          replacement.receive(
            JSON.stringify({
              _tag: "Exit",
              requestId: frame.id,
              exit: { _tag: "Success", value: null },
            }),
          );
      };
      replacement.open();
      await vi.waitFor(() => expect(transport.getState()).toBe("open"));
      if (!probePending) {
        await vi.waitFor(() =>
          expect(
            sockets[1]!.sent
              .map((data) => JSON.parse(String(data)))
              .some(
                (frame) =>
                  frame.tag === ORCHESTRATION_WS_METHODS.subscribeThread &&
                  frame.payload?.threadId === threadId &&
                  frame.payload?.afterSequence === 42,
              ),
          ).toBe(true),
        );
      }
    } finally {
      await transport.dispose();
      resetThreadDetailResumeCursorsForTests();
      vi.useRealTimers();
    }
  },
);

it("uses any inbound server frame as liveness evidence even when pongs are absent", async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
  });
  bindWindowTimersToCurrentGlobals();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(jsonResponse(200, NEGOTIATION_RESULT))),
  );
  const transport = new WsTransport("ws://remote.synara.test:3020");
  try {
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0]!;
    socket.serveVoidRpc();
    await vi.waitFor(() => expect(transport.getState()).toBe("open"));
    socket.onSend = null;
    for (let interval = 0; interval < 3; interval++) {
      await vi.advanceTimersByTimeAsync(120_000);
      // A well-formed response from an expired request is still proof that
      // the server-to-client path works; no pong ordering assumption is needed.
      socket.receive(
        JSON.stringify({
          _tag: "Exit",
          requestId: "9999999999",
          exit: { _tag: "Success", value: null },
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets).toHaveLength(1);
    }
    await vi.advanceTimersByTimeAsync(175_000);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
  } finally {
    await transport.dispose();
    vi.useRealTimers();
  }
});

it.each(["orchestration.shell", "orchestration.thread:capped-overflow"])(
  "surfaces exhausted overflow retries for %s without dropping the applied cursor",
  async (key) => {
    vi.useFakeTimers();
    bindWindowTimersToCurrentGlobals();
    resetThreadDetailResumeCursorsForTests();
    const { transport, internals } = makeBareTransport();
    const threadId = ThreadId.makeUnsafe("capped-overflow");
    advanceThreadDetailResumeCursor(threadId, 42);
    internals.threadSubscriptions.set(threadId, { threadId });
    const failure = vi.fn();
    const unsubscribe =
      key === "orchestration.shell"
        ? transport.onShellStreamFailure(failure)
        : transport.onThreadStreamFailure(failure);
    const restart = vi.fn();
    try {
      for (const delay of [250, 500, 1000, 2000, 4000, 8000, 16000, 16000]) {
        internals.startStream(
          {},
          key,
          Stream.fail({ code: "ORCHESTRATION_STREAM_OVERFLOW", retryable: true }),
          () => undefined,
          restart,
        );
        await vi.advanceTimersByTimeAsync(delay);
      }
      expect(restart).toHaveBeenCalledTimes(8);
      internals.startStream(
        {},
        key,
        Stream.fail({ code: "ORCHESTRATION_STREAM_OVERFLOW", retryable: true }),
        () => undefined,
        restart,
      );
      await vi.advanceTimersByTimeAsync(60000);
      expect(restart).toHaveBeenCalledTimes(8);
      expect(failure).toHaveBeenCalledOnce();
      expect(failure).toHaveBeenCalledWith(
        expect.objectContaining({ code: "ORCHESTRATION_STREAM_OVERFLOW" }),
      );
      expect(buildThreadSubscribeInput(threadId)).toEqual({
        threadId,
        afterSequence: 42,
        batchReplay: true,
      });
      expect(internals.reconnect).not.toHaveBeenCalled();
      expect(internals.streamCapacityRetryTimers.has(key)).toBe(false);
    } finally {
      unsubscribe();
      resetThreadDetailResumeCursorsForTests();
      vi.useRealTimers();
    }
  },
);

it("bounds the feature probe even when server pongs keep arriving without its RPC reply", async () => {
  vi.useFakeTimers();
  bindWindowTimersToCurrentGlobals();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(jsonResponse(200, NEGOTIATION_RESULT))),
  );
  const transport = new WsTransport("ws://remote.synara.test:3020");
  try {
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0]!;
    socket.onSend = (data) => {
      if (JSON.parse(String(data))._tag === "Ping")
        socket.receive(JSON.stringify({ _tag: "Pong" }));
    };
    socket.open();
    await vi.advanceTimersByTimeAsync(175000);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10000);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
    sockets[1]!.serveVoidRpc();
    await vi.waitFor(() => expect(transport.getState()).toBe("open"));
  } finally {
    await transport.dispose();
    vi.useRealTimers();
  }
});

it("renews the overflow retry budget only after a stream remains alive for ten seconds", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  bindWindowTimersToCurrentGlobals();
  const { internals } = makeBareTransport();
  const key = "orchestration.shell";
  const restart = vi.fn();
  internals.streamOverflowRetries.set(key, 8);
  try {
    internals.startStream(
      {},
      key,
      Stream.fromEffect(
        Effect.fail({ code: "ORCHESTRATION_STREAM_OVERFLOW", retryable: true }).pipe(
          Effect.delay(10000),
        ),
      ),
      () => undefined,
      restart,
    );
    await vi.advanceTimersByTimeAsync(10000);
    expect(restart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(249);
    expect(restart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(restart).toHaveBeenCalledOnce();
    expect(internals.streamOverflowRetries.get(key)).toBe(1);
    expect(internals.reconnect).not.toHaveBeenCalled();
  } finally {
    await internals.stopStream(key);
    vi.useRealTimers();
  }
});

describe("WsTransport", () => {
  it.each(["completed", "rejected", "older-server", "downgraded-server"])(
    "recovers an interrupted Git action safely: %s",
    async (outcome) => {
      vi.useFakeTimers();
      bindWindowTimersToCurrentGlobals();
      try {
        const { transport, internals } = makeBareTransport();
        const params = { actionId: "push-once", cwd: "/repo", action: "push" };
        const result = { action: "push", push: { status: "pushed" } };
        const run = vi
          .fn()
          .mockImplementationOnce(() => Stream.fromEffect(Effect.interrupt))
          .mockImplementation(() =>
            outcome === "rejected"
              ? Stream.fail(new Error("remote rejected push"))
              : Stream.make({ ...params, kind: "action_finished", result }),
          );
        const client = { [WS_METHODS.gitRunStackedAction]: run };
        let connections = 0;
        Object.assign(internals, {
          emit: vi.fn(),
          compatibility: {
            ...NEGOTIATION_RESULT,
            capabilities: outcome === "older-server" ? [] : [WS_GIT_ACTION_RECOVERY_CAPABILITY],
          },
          getClient: async () => {
            if (++connections > 1 && outcome === "downgraded-server") {
              Object.assign(internals, { compatibility: NEGOTIATION_RESULT });
            }
            return client;
          },
          getClientRuntime: () => ({ runPromise: Effect.runPromise }),
        });
        const request = transport.request(WS_METHODS.gitRunStackedAction, params, {
          timeoutMs: null,
        });
        const verdict =
          outcome === "completed"
            ? expect(request).resolves.toEqual(result)
            : expect(request).rejects.toThrow(
                outcome === "rejected"
                  ? "remote rejected push"
                  : outcome === "older-server"
                    ? "transport reconnect"
                    : "cannot recover",
              );
        await vi.advanceTimersByTimeAsync(1000);
        await verdict;
        expect(run).toHaveBeenCalledTimes(
          outcome === "completed" || outcome === "rejected" ? 2 : 1,
        );
        expect(run).toHaveBeenNthCalledWith(
          1,
          outcome === "older-server" ? params : { ...params, recoverable: true },
        );
        if (run.mock.calls.length === 2)
          expect(run).toHaveBeenNthCalledWith(2, { ...params, recoverable: true, resume: true });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["caller", "transport"])(
    "stops Git recovery when the %s stops waiting",
    async (source) => {
      vi.useFakeTimers();
      bindWindowTimersToCurrentGlobals();
      try {
        const { transport, internals } = makeBareTransport();
        const lifetime = new AbortController();
        const caller = new AbortController();
        const run = vi.fn(() => Stream.fromEffect(Effect.interrupt));
        Object.assign(internals, {
          lifetime,
          compatibility: {
            ...NEGOTIATION_RESULT,
            capabilities: [WS_GIT_ACTION_RECOVERY_CAPABILITY],
          },
          getClient: async () => ({ [WS_METHODS.gitRunStackedAction]: run }),
          getClientRuntime: () => ({ runPromise: Effect.runPromise }),
        });
        const request = transport.request(
          WS_METHODS.gitRunStackedAction,
          { actionId: "cancel-wait", cwd: "/repo", action: "push" },
          { signal: caller.signal, timeoutMs: null },
        );
        const verdict = expect(request).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(1000);
        (source === "caller" ? caller : lifetime).abort();
        await verdict;
        const attempts = run.mock.calls.length;
        expect(attempts).toBeGreaterThan(1);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(run).toHaveBeenCalledTimes(attempts);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("records the outcome of a Beta import without changing its result or rejection", async () => {
    const recordActivity = vi.fn();
    Object.assign(window, { desktopBridge: { betaDiagnostics: { recordActivity } } });
    const { transport, internals } = makeBareTransport();
    const failure = new Error("import rejected");
    let reject = false;
    Object.assign(internals, {
      getClient: async () => ({
        [ORCHESTRATION_WS_METHODS.importProject]: () =>
          reject ? Effect.fail(failure) : Effect.succeed({ imported: 3 }),
      }),
      getClientRuntime: () => ({ runPromise: Effect.runPromise }),
    });
    const params = { path: "/private/project", prompt: "never collect", id: "private-id" };
    await expect(
      transport.request(ORCHESTRATION_WS_METHODS.importProject, params),
    ).resolves.toEqual({ imported: 3 });
    reject = true;
    await expect(transport.request(ORCHESTRATION_WS_METHODS.importProject, params)).rejects.toThrow(
      "import rejected",
    );
    expect(recordActivity.mock.calls).toEqual([
      [{ activity: "project.import", phase: "started" }],
      [{ activity: "project.import", phase: "succeeded" }],
      [{ activity: "project.import", phase: "started" }],
      [{ activity: "project.import", phase: "failed" }],
    ]);
    recordActivity.mockImplementation(() => {
      throw new Error("broken diagnostics bridge");
    });
    reject = false;
    await expect(
      transport.request(ORCHESTRATION_WS_METHODS.importProject, params),
    ).resolves.toEqual({ imported: 3 });
  });

  it.each(["caller", "transport"])(
    "keeps an unacknowledged send pending through settlement failures until %s cancellation",
    async (cancelSource) => {
      vi.useFakeTimers();
      bindWindowTimersToCurrentGlobals();
      const lifetime = new AbortController();
      const caller = new AbortController();
      try {
        const { transport, internals } = makeBareTransport();
        const dispatch = vi.fn(() => Effect.never);
        const settle = vi
          .fn()
          .mockImplementationOnce(() =>
            Effect.fail(
              new WsTransportRequestInterruptedError({
                message: "Connection lost",
                code: "WS_REQUEST_RECONNECTED",
                method: ORCHESTRATION_WS_METHODS.settleTurnDispatch,
              }),
            ),
          )
          .mockImplementation(() => Effect.never);
        const client = {
          [ORCHESTRATION_WS_METHODS.dispatchCommand]: dispatch,
          [ORCHESTRATION_WS_METHODS.settleTurnDispatch]: settle,
        };
        Object.assign(internals, {
          lifetime,
          compatibility: {
            ...NEGOTIATION_RESULT,
            capabilities: [WS_TURN_DISPATCH_SETTLEMENT_CAPABILITY],
          },
          getClient: async () => client,
          getClientRuntime: () => ({ runPromise: Effect.runPromise }),
        });
        const command = {
          type: "thread.turn.start",
          commandId: "uncertain-send",
          threadId: "uncertain-thread",
          message: { messageId: "uncertain-message", role: "user", text: "hello", attachments: [] },
        };
        let finished = false;
        const send = transport.request(
          ORCHESTRATION_WS_METHODS.dispatchCommand,
          { command },
          { timeoutMs: 20, signal: caller.signal },
        );
        const verdict = expect(
          send.finally(() => {
            finished = true;
          }),
        ).rejects.toMatchObject({ code: "WS_REQUEST_ABORTED" });
        await vi.advanceTimersByTimeAsync(520);
        expect(settle).toHaveBeenCalledTimes(2);
        expect(finished).toBe(false);
        expect(getWsSettlingThreadIds().has(ThreadId.makeUnsafe(command.threadId))).toBe(true);
        expect(dispatch).toHaveBeenCalledOnce();
        expect(settle).toHaveBeenLastCalledWith({ command });
        (cancelSource === "caller" ? caller : lifetime).abort();
        await verdict;
        expect(getWsSettlingThreadIds().size).toBe(0);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(settle).toHaveBeenCalledTimes(2);
        expect(dispatch).toHaveBeenCalledOnce();
      } finally {
        lifetime.abort();
        vi.useRealTimers();
      }
    },
  );

  it("releases settlement ownership when recovery loses the optional capability", async () => {
    vi.useFakeTimers();
    bindWindowTimersToCurrentGlobals();
    const lifetime = new AbortController();
    try {
      const { transport, internals } = makeBareTransport();
      const dispatch = vi.fn(() => Effect.never);
      const settle = vi.fn(() => Effect.never);
      const client = {
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: dispatch,
        [ORCHESTRATION_WS_METHODS.settleTurnDispatch]: settle,
      };
      Object.assign(internals, {
        lifetime,
        compatibility: {
          ...NEGOTIATION_RESULT,
          capabilities: [WS_TURN_DISPATCH_SETTLEMENT_CAPABILITY],
        },
        getClient: vi
          .fn()
          .mockResolvedValueOnce(client)
          .mockImplementation(async () => {
            Object.assign(internals, { compatibility: NEGOTIATION_RESULT });
            return client;
          }),
        getClientRuntime: () => ({ runPromise: Effect.runPromise }),
      });
      const command = {
        type: "thread.turn.start",
        commandId: "optional-capability-send",
        threadId: "optional-capability-thread",
        message: {
          messageId: "optional-capability-message",
          role: "user",
          text: "hello",
          attachments: [],
        },
      };
      const send = transport.request(
        ORCHESTRATION_WS_METHODS.dispatchCommand,
        { command },
        { timeoutMs: 20 },
      );
      let failure: unknown;
      const verdict = send.catch((error) => {
        failure = error;
      });
      await vi.advanceTimersByTimeAsync(20);
      // Observe a terminal result without allowing an unresolved baseline promise to hang the test.
      expect(getWsSettlingThreadIds().size).toBe(0);
      await verdict;
      expect(failure).toMatchObject({ code: "WS_TURN_SETTLEMENT_UNAVAILABLE", retryable: false });
      expect(settle).not.toHaveBeenCalled();
      expect(dispatch).toHaveBeenCalledOnce();
    } finally {
      lifetime.abort();
      vi.useRealTimers();
    }
  });

  it("keeps recovery connecting when the detached feature probe rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, NEGOTIATION_RESULT)),
    );
    const transport = new WsTransport();
    const runtimeOwner = transport as unknown as {
      closeRuntime: (...args: unknown[]) => Promise<void>;
    };
    const closeRuntime = runtimeOwner.closeRuntime.bind(runtimeOwner);
    let releaseClose!: () => void;
    const closing = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const close = vi.spyOn(runtimeOwner, "closeRuntime").mockImplementation(async (...args) => {
      await closing;
      await closeRuntime(...args);
    });
    try {
      await waitForSockets(1);
      sockets[0]!.open();
      await vi.waitFor(() => expect(sockets[0]!.sent.length).toBeGreaterThan(0));
      sockets[0]!.close(1006, "probe connection died");
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(transport.getState()).toBe("connecting");
      releaseClose();
      await vi.waitFor(() => expect(sockets.length).toBe(2));
      sockets[1]!.serveVoidRpc();
      await vi.waitFor(() => expect(transport.getState()).toBe("open"));
    } finally {
      releaseClose();
      await transport.dispose();
    }
  });

  it("recovers an unopened feature socket without reporting it as connected", async () => {
    vi.useFakeTimers();
    bindWindowTimersToCurrentGlobals();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, NEGOTIATION_RESULT)),
    );
    const transport = new WsTransport();
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(1);
      expect(transport.getState()).toBe("connecting");
      await vi.advanceTimersByTimeAsync(89_000);
      expect(sockets).toHaveLength(1);
      expect(transport.getState()).toBe("connecting");
      await vi.advanceTimersByTimeAsync(1501);
      expect(sockets[0]!.readyState).toBe(MockWebSocket.CLOSED);
      expect(sockets).toHaveLength(2);
      expect(transport.getState()).toBe("connecting");
      sockets[1]!.serveVoidRpc();
      await vi.advanceTimersByTimeAsync(1);
      expect(transport.getState()).toBe("open");
    } finally {
      await transport.dispose();
      vi.useRealTimers();
    }
  });

  it.each(["accepted", "rejected"] as const)(
    "settles a lost send acknowledgement after reconnect (%s) without resending the turn",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse(200, {
            ...NEGOTIATION_RESULT,
            capabilities: [
              ...NEGOTIATION_RESULT.capabilities,
              WS_TURN_DISPATCH_SETTLEMENT_CAPABILITY,
              WS_GIT_ACTION_RECOVERY_CAPABILITY,
            ],
          }),
        ),
      );
      const transport = new WsTransport();
      const command = {
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("lost-ack-command"),
        threadId: ThreadId.makeUnsafe("lost-ack-thread"),
        message: {
          messageId: MessageId.makeUnsafe("lost-ack-message"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-10-04T12:00:00.000Z",
      } satisfies ClientOrchestrationCommand;
      try {
        await waitForSockets(1);
        sockets[0]!.onSend = (data) => {
          const frame = JSON.parse(data);
          if (frame._tag === "Ping") sockets[0]!.receive(JSON.stringify({ _tag: "Pong" }));
          if (frame._tag === "Request" && frame.tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
            queueMicrotask(() => sockets[0]!.close(1006, "lost acknowledgement"));
          } else if (frame._tag === "Request") {
            sockets[0]!.receive(
              JSON.stringify({
                _tag: "Exit",
                requestId: frame.id,
                exit: { _tag: "Success", value: null },
              }),
            );
          }
        };
        sockets[0]!.open();
        const send = transport.request(ORCHESTRATION_WS_METHODS.dispatchCommand, { command });
        const verdict =
          status === "accepted"
            ? expect(send).resolves.toEqual({ sequence: 42 })
            : expect(send).rejects.toMatchObject({
                message: "Message was not accepted. Send again.",
              });
        await vi.waitFor(() => expect(sockets.length).toBe(2));
        const recovered = sockets[1]!;
        recovered.onSend = (data) => {
          const frame = JSON.parse(data);
          if (frame._tag === "Ping") recovered.receive(JSON.stringify({ _tag: "Pong" }));
          if (frame._tag !== "Request") return;
          const value =
            frame.tag === ORCHESTRATION_WS_METHODS.settleTurnDispatch
              ? status === "accepted"
                ? { status, sequence: 42 }
                : { status, message: "Message was not accepted. Send again." }
              : null;
          recovered.receive(
            JSON.stringify({ _tag: "Exit", requestId: frame.id, exit: { _tag: "Success", value } }),
          );
        };
        recovered.open();
        await verdict;
        const requests = sockets
          .flatMap((socket) => socket.sent.map((data) => JSON.parse(String(data))))
          .filter((frame) => frame._tag === "Request");
        expect(
          requests.filter((frame) => frame.tag === ORCHESTRATION_WS_METHODS.dispatchCommand),
        ).toHaveLength(1);
        expect(
          requests.find((frame) => frame.tag === ORCHESTRATION_WS_METHODS.settleTurnDispatch)
            ?.payload.command,
        ).toMatchObject(command);
      } finally {
        await transport.dispose();
      }
    },
  );

  it("replaces a failed feature socket even when no streams are subscribed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, NEGOTIATION_RESULT)),
    );
    const transport = new WsTransport();
    transport.onStateChange((state) => {
      if (state === "open" && sockets.length === 2) {
        // Fail after the probe, while the reconnect promise is still settling.
        sockets[1]!.close(1006, "connection lost again");
      }
    });
    try {
      await waitForSockets(1);
      sockets[0]!.serveVoidRpc();
      await vi.waitFor(() => expect(transport.getState()).toBe("open"));
      sockets[0]!.close(1006, "connection lost");
      await vi.waitFor(() => expect(transport.getState()).toBe("connecting"));
      await vi.waitFor(() => expect(sockets.length).toBe(2));
      sockets[1]!.serveVoidRpc();
      await vi.waitFor(() => expect(sockets.length).toBe(3));
      sockets[2]!.serveVoidRpc();
      await vi.waitFor(() => expect(transport.getState()).toBe("open"));
    } finally {
      await transport.dispose();
    }
  });

  it("shares one stream per watched file and stops it after the last listener leaves", async () => {
    const { transport, internals } = makeBareTransport();
    const input = { cwd: "/repo", relativePath: "src/app.ts" };
    const key = projectFileChangeStreamKey(input);
    const client = {};
    internals.getClient = vi.fn(async () => client);
    internals.startProjectFileChangeStream = vi.fn();
    internals.stopStream = vi.fn(async () => undefined);

    const unsubscribeFirst = transport.subscribeProjectFileChange(input, vi.fn());
    const unsubscribeSecond = transport.subscribeProjectFileChange(input, vi.fn());

    await vi.waitFor(() => expect(internals.startProjectFileChangeStream).toHaveBeenCalledOnce());
    expect(internals.projectFileSubscriptions.size).toBe(1);

    unsubscribeFirst();
    expect(internals.stopStream).not.toHaveBeenCalled();
    unsubscribeSecond();

    expect(internals.projectFileSubscriptions.size).toBe(0);
    expect(internals.stopStream).toHaveBeenCalledWith(key);
  });

  it("does not open a file stream after its subscription is cancelled during connection", async () => {
    const { transport, internals } = makeBareTransport();
    let resolveClient!: (client: unknown) => void;
    internals.getClient = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveClient = resolve;
        }),
    );
    const subscribeFile = vi.fn(() => Stream.never);
    Object.assign(internals, {
      compatibility: { capabilities: [WS_PROJECT_FILE_WATCH_CAPABILITY] },
    });
    const unsubscribe = transport.subscribeProjectFileChange(
      { cwd: "/repo", relativePath: "app.ts" },
      vi.fn(),
    );
    unsubscribe();
    resolveClient({ [WS_METHODS.projectsSubscribeFileChange]: subscribeFile });
    await Promise.resolve();
    await Promise.resolve();
    expect(subscribeFile).not.toHaveBeenCalled();
    expect(internals.projectFileSubscriptions.size).toBe(0);
  });

  it("returns the completed GitHub provisioning result and emits each progress event", async () => {
    const phase = {
      operationId: "operation-1",
      kind: "phase" as const,
      phase: "cloning" as const,
      message: "Cloning openai/codex",
    };
    const completed = {
      operationId: "operation-1",
      kind: "completed" as const,
      result: {
        operationId: "operation-1",
        repository: "openai/codex",
        workspaceRoot: "/projects/codex",
        projectId: "project-1",
        checkout: "created" as const,
      },
    };
    const emit = vi.fn();
    const transport = Object.create(WsTransport.prototype) as WsTransport;
    Object.assign(transport, {
      emit,
      getClientRuntime: () => ({ runPromise: Effect.runPromise }),
    });
    const runProjectProvisionStream = (
      transport as unknown as {
        runProjectProvisionStream: (
          client: Record<string, () => Stream.Stream<typeof phase | typeof completed>>,
          params: unknown,
        ) => Promise<typeof completed.result>;
      }
    ).runProjectProvisionStream.bind(transport);

    await expect(
      runProjectProvisionStream(
        {
          [WS_METHODS.projectsProvisionFromGitHub]: () => Stream.make(phase, completed),
        },
        { repository: "openai/codex" },
      ),
    ).resolves.toEqual(completed.result);
    expect(emit).toHaveBeenNthCalledWith(1, WS_CHANNELS.projectProvisionProgress, phase);
    expect(emit).toHaveBeenNthCalledWith(2, WS_CHANNELS.projectProvisionProgress, completed);
  });

  it("returns the completed worktree setup result and emits each progress event", async () => {
    const phase = {
      progressId: "progress-1",
      kind: "phase_started" as const,
      phase: "worktree" as const,
    };
    const completed = {
      progressId: "progress-1",
      kind: "completed" as const,
      result: {
        worktree: {
          path: "/repo/.codex/worktrees/generated/synara",
          ref: "0123456789abcdef0123456789abcdef01234567",
          branch: "synara/abcd1234",
        },
      },
    };
    const emit = vi.fn();
    const transport = Object.create(WsTransport.prototype) as WsTransport;
    Object.assign(transport, {
      emit,
      getClientRuntime: () => ({ runPromise: Effect.runPromise }),
    });
    const runWorktreeSetupStream = (
      transport as unknown as {
        runWorktreeSetupStream: (
          client: Record<string, () => Stream.Stream<typeof phase | typeof completed>>,
          params: unknown,
        ) => Promise<typeof completed.result>;
      }
    ).runWorktreeSetupStream.bind(transport);

    await expect(
      runWorktreeSetupStream(
        {
          [WS_METHODS.gitCreateDetachedWorktree]: () => Stream.make(phase, completed),
        },
        { cwd: "/repo", ref: "main" },
      ),
    ).resolves.toEqual(completed.result);
    expect(emit).toHaveBeenNthCalledWith(1, WS_CHANNELS.gitWorktreeSetupProgress, phase);
    expect(emit).toHaveBeenNthCalledWith(2, WS_CHANNELS.gitWorktreeSetupProgress, completed);
  });

  it("does not reconnect the socket for typed stream-admission failures", () => {
    expect(
      shouldReconnectAfterStreamFailure(
        Cause.fail({
          code: "STREAM_CAPACITY_EXCEEDED",
          retryable: true,
          retryAfterMs: 1_000,
        }),
      ),
    ).toBe(false);
    expect(
      shouldReconnectAfterStreamFailure(
        Cause.fail({ code: "STREAM_DUPLICATE_SUBSCRIPTION", retryable: false }),
      ),
    ).toBe(false);
    expect(
      shouldReconnectAfterStreamFailure(
        Cause.fail({ code: "THREAD_SNAPSHOT_NOT_FOUND", retryable: false }),
      ),
    ).toBe(false);
    expect(
      shouldReconnectAfterStreamFailure(
        Cause.fail({ code: "PROJECT_FILE_WATCH_FAILED", retryable: false }),
      ),
    ).toBe(false);
    expect(shouldReconnectAfterStreamFailure(Cause.fail(new Error("transient")))).toBe(true);
    expect(
      shouldReconnectAfterStreamFailure(
        Cause.fail({ code: "WS_PROTOCOL_INCOMPATIBLE", retryable: false }),
      ),
    ).toBe(false);
    expect(
      isTerminalCompatibilityFailure({
        code: "WS_PROTOCOL_INCOMPATIBLE",
        retryable: false,
      }),
    ).toBe(true);
  });

  it("bounds project file watcher retries with exponential backoff", () => {
    const failure = Cause.fail({ code: "PROJECT_FILE_WATCH_FAILED", retryable: false });

    expect(getProjectFileWatchRetryDelayMs(failure, 0)).toBe(500);
    expect(getProjectFileWatchRetryDelayMs(failure, 4)).toBe(8_000);
    expect(
      getProjectFileWatchRetryDelayMs(failure, MAX_PROJECT_FILE_WATCH_RETRY_ATTEMPTS),
    ).toBeNull();
    expect(getProjectFileWatchRetryDelayMs(Cause.fail(new Error("transient")), 0)).toBeNull();
  });

  it("retries a failed project file watcher in place without reconnecting the socket", async () => {
    vi.useFakeTimers();
    bindWindowTimersToCurrentGlobals();
    try {
      const { internals } = makeBareTransport();
      const key = "projects.file-change:/repo\0src/app.ts";
      const restart = vi.fn();
      const reconnect = vi.mocked(internals.reconnect);

      internals.startStream(
        {},
        key,
        Stream.fail({ code: "PROJECT_FILE_WATCH_FAILED", retryable: false }),
        () => undefined,
        restart,
      );
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(499);

      expect(restart).not.toHaveBeenCalled();
      expect(reconnect).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(restart).toHaveBeenCalledTimes(1);
      expect(reconnect).not.toHaveBeenCalled();
      expect(internals.projectFileWatchRetries.get(key)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries resnapshot demands in place with bounded attempts", () => {
    const resnapshot = Cause.fail({
      code: "ORCHESTRATION_RESNAPSHOT_REQUIRED",
      retryable: true,
    });

    expect(getResnapshotRetryDelayMs(resnapshot, 0)).toBe(250);
    expect(getResnapshotRetryDelayMs(resnapshot, MAX_RESNAPSHOT_RETRY_ATTEMPTS)).toBeNull();
    // The server's escalated stall verdict is final; no in-place retry.
    expect(
      getResnapshotRetryDelayMs(
        Cause.fail({ code: "ORCHESTRATION_SNAPSHOT_STALLED", retryable: false }),
        0,
      ),
    ).toBeNull();
    expect(getResnapshotRetryDelayMs(Cause.fail(new Error("transient")), 0)).toBeNull();

    expect(resolveStreamAdmissionRetry(resnapshot, 0, 0, 0, 0)).toEqual({
      kind: "resnapshot",
      attempt: 1,
      delayMs: 250,
    });
    expect(resolveStreamAdmissionRetry(resnapshot, 0, 0, 0, MAX_RESNAPSHOT_RETRY_ATTEMPTS)).toBe(
      null,
    );
  });

  it("clears the thread resume cursor and retries in place on a resnapshot demand", async () => {
    // The retried subscription must request a fresh full snapshot: resending
    // the stale cursor would demand the same overflowing gap replay again.
    vi.useFakeTimers();
    bindWindowTimersToCurrentGlobals();
    resetThreadDetailResumeCursorsForTests();
    try {
      const { internals } = makeBareTransport();
      const threadId = "thread-resnapshot";
      const key = `orchestration.thread:${threadId}`;
      advanceThreadDetailResumeCursor(ThreadId.makeUnsafe(threadId), 100);
      internals.threadSubscriptions.set(threadId, { threadId, afterSequence: 100 });
      const restart = vi.fn();
      const reconnect = vi.mocked(internals.reconnect);

      internals.startStream(
        {},
        key,
        Stream.fail({ code: "ORCHESTRATION_RESNAPSHOT_REQUIRED", retryable: true }),
        () => undefined,
        restart,
      );
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);

      expect(hasThreadDetailResumeCursor(ThreadId.makeUnsafe(threadId))).toBe(false);
      expect(reconnect).not.toHaveBeenCalled();
      expect(restart).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(250);
      expect(restart).toHaveBeenCalledTimes(1);
      expect(reconnect).not.toHaveBeenCalled();
    } finally {
      resetThreadDetailResumeCursorsForTests();
      vi.useRealTimers();
    }
  });

  it.each(["orchestration.shell", "orchestration.thread:thread-overflow"])(
    "retries an overflowing %s stream locally and preserves the thread resume cursor",
    async (key) => {
      vi.useFakeTimers();
      bindWindowTimersToCurrentGlobals();
      resetThreadDetailResumeCursorsForTests();
      try {
        const { internals } = makeBareTransport();
        const threadId = ThreadId.makeUnsafe("thread-overflow");
        advanceThreadDetailResumeCursor(threadId, 100);
        const restartedInputs: unknown[] = [];
        const restart = () => restartedInputs.push(buildThreadSubscribeInput(threadId));
        const reconnect = vi.mocked(internals.reconnect);
        const cause = Cause.fail({ code: "ORCHESTRATION_STREAM_OVERFLOW", retryable: true });

        expect(shouldReconnectAfterStreamFailure(cause)).toBe(false);
        internals.startStream(
          {},
          key,
          Stream.fail({ code: "ORCHESTRATION_STREAM_OVERFLOW", retryable: true }),
          () => undefined,
          restart,
        );
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(250);

        expect(restartedInputs).toEqual([
          { threadId: "thread-overflow", afterSequence: 100, batchReplay: true },
        ]);
        expect(reconnect).not.toHaveBeenCalled();
      } finally {
        resetThreadDetailResumeCursorsForTests();
        vi.useRealTimers();
      }
    },
  );

  it("backs off repeated overflow locally and cancels the pending retry on unsubscribe", async () => {
    vi.useFakeTimers();
    bindWindowTimersToCurrentGlobals();
    const { internals } = makeBareTransport();
    const key = "orchestration.shell";
    const restart = vi.fn();
    try {
      for (const delay of [250, 500, 1000, 2000, 4000, 8000, 16000]) {
        internals.startStream(
          {},
          key,
          Stream.fail({
            code: "ORCHESTRATION_STREAM_OVERFLOW",
            retryable: true,
          }),
          () => undefined,
          restart,
        );
        await vi.advanceTimersByTimeAsync(0);
        const before = restart.mock.calls.length;
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(restart).toHaveBeenCalledTimes(before);
        await vi.advanceTimersByTimeAsync(1);
        expect(restart).toHaveBeenCalledTimes(before + 1);
      }
      internals.startStream(
        {},
        key,
        Stream.fail({
          code: "ORCHESTRATION_STREAM_OVERFLOW",
          retryable: true,
        }),
        () => undefined,
        restart,
      );
      await vi.advanceTimersByTimeAsync(0);
      await internals.stopStream(key);
      await vi.advanceTimersByTimeAsync(16000);
      expect(restart).toHaveBeenCalledTimes(7);
      expect(internals.reconnect).not.toHaveBeenCalled();
      expect(internals.streamCapacityRetryTimers.has(key)).toBe(false);
      expect(internals.streamOverflowRetries.has(key)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a stalled-snapshot verdict as a thread stream failure without reconnecting", async () => {
    vi.useFakeTimers();
    bindWindowTimersToCurrentGlobals();
    try {
      const { internals } = makeBareTransport();
      const threadId = "thread-stalled";
      const key = `orchestration.thread:${threadId}`;
      internals.threadSubscriptions.set(threadId, { threadId });
      const failures: WsThreadStreamFailure[] = [];
      internals.threadStreamFailureListeners.add((failure) => failures.push(failure));
      const restart = vi.fn();
      const reconnect = vi.mocked(internals.reconnect);

      internals.startStream(
        {},
        key,
        Stream.fail({ code: "ORCHESTRATION_SNAPSHOT_STALLED", retryable: false }),
        () => undefined,
        restart,
      );
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(SNAPSHOT_FAULT_RETRY_MS - 1);

      expect(reconnect).not.toHaveBeenCalled();
      expect(restart).not.toHaveBeenCalled();
      expect(failures).toHaveLength(1);
      expect(failures[0]?.code).toBe("ORCHESTRATION_SNAPSHOT_STALLED");

      // A snapshot fault clears only when the server heals; a slow in-place
      // retry converges then without the user resubscribing.
      await vi.advanceTimersByTimeAsync(1);
      expect(restart).toHaveBeenCalledTimes(1);
      expect(reconnect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("slow-retries a shell stream killed by a projection-state fault instead of leaving it dead", async () => {
    // The shell stream has no route-level fallback: without a retry the
    // sidebar silently freezes until an unrelated explicit resubscribe.
    vi.useFakeTimers();
    bindWindowTimersToCurrentGlobals();
    try {
      const { internals } = makeBareTransport();
      const key = "orchestration.shell";
      const restart = vi.fn();
      const reconnect = vi.mocked(internals.reconnect);

      internals.startStream(
        {},
        key,
        Stream.fail({ code: "ORCHESTRATION_PROJECTION_STATE_INCOMPLETE", retryable: false }),
        () => undefined,
        restart,
      );
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);

      expect(reconnect).not.toHaveBeenCalled();
      expect(restart).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(SNAPSHOT_FAULT_RETRY_MS);
      expect(restart).toHaveBeenCalledTimes(1);
      expect(reconnect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending snapshot-fault retry when the stream is stopped", async () => {
    vi.useFakeTimers();
    bindWindowTimersToCurrentGlobals();
    try {
      const { internals } = makeBareTransport();
      const key = "orchestration.shell";
      const restart = vi.fn();

      internals.startStream(
        {},
        key,
        Stream.fail({ code: "ORCHESTRATION_SNAPSHOT_STALLED", retryable: false }),
        () => undefined,
        restart,
      );
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await internals.stopStream(key);
      await vi.advanceTimersByTimeAsync(SNAPSHOT_FAULT_RETRY_MS * 2);

      expect(restart).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies snapshot faults for the slow retry and nothing else", () => {
    expect(
      getSnapshotFaultRetryDelayMs(
        Cause.fail({ code: "ORCHESTRATION_SNAPSHOT_STALLED", retryable: false }),
      ),
    ).toBe(SNAPSHOT_FAULT_RETRY_MS);
    expect(
      getSnapshotFaultRetryDelayMs(
        Cause.fail({ code: "ORCHESTRATION_PROJECTION_STATE_INCOMPLETE", retryable: false }),
      ),
    ).toBe(SNAPSHOT_FAULT_RETRY_MS);
    // RESNAPSHOT reaches this classifier only after its bounded fast retries
    // are exhausted (the admission-retry path returns first): an advancing
    // fence that has not yet closed a large gap must keep slow-retrying
    // instead of dying while recovery is succeeding.
    expect(
      getSnapshotFaultRetryDelayMs(
        Cause.fail({ code: "ORCHESTRATION_RESNAPSHOT_REQUIRED", retryable: true }),
      ),
    ).toBe(SNAPSHOT_FAULT_RETRY_MS);
    expect(getSnapshotFaultRetryDelayMs(Cause.fail(new Error("transient")))).toBeNull();
  });

  it("keeps slow-retrying an exhausted resnapshot demand instead of leaving the stream dead", async () => {
    // A projector catching up through a backlog larger than the replay limit
    // advances the fence on every request without closing the gap: the server
    // keeps answering RESNAPSHOT_REQUIRED (progress is real, so it never
    // escalates to STALLED). Once the fast retries are spent, the stream must
    // fall back to the slow recovery path rather than dying while the server
    // is actively healing.
    vi.useFakeTimers();
    bindWindowTimersToCurrentGlobals();
    try {
      const { internals } = makeBareTransport();
      const key = "orchestration.shell";
      internals.streamResnapshotRetries.set(key, MAX_RESNAPSHOT_RETRY_ATTEMPTS);
      const restart = vi.fn();
      const reconnect = vi.mocked(internals.reconnect);

      internals.startStream(
        {},
        key,
        Stream.fail({ code: "ORCHESTRATION_RESNAPSHOT_REQUIRED", retryable: true }),
        () => undefined,
        restart,
      );
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(SNAPSHOT_FAULT_RETRY_MS - 1);
      expect(restart).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(restart).toHaveBeenCalledTimes(1);
      expect(reconnect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets resnapshot retry state when a stream is explicitly stopped", async () => {
    const { internals } = makeBareTransport();
    const key = "orchestration.thread:stopped-resnapshot";
    internals.streamResnapshotRetries.set(key, MAX_RESNAPSHOT_RETRY_ATTEMPTS);

    await internals.stopStream(key);

    expect(internals.streamResnapshotRetries.has(key)).toBe(false);
  });

  it("classifies transport-runtime interrupts as retryable typed failures", () => {
    expect(isRuntimeInterruptFailure(new Error("All fibers interrupted without error"))).toBe(true);
    expect(isRuntimeInterruptFailure(new Error("Missing runtime for WebSocket RPC client"))).toBe(
      true,
    );
    expect(isRuntimeInterruptFailure(new Error("ManagedRuntime disposed"))).toBe(true);
    expect(isRuntimeInterruptFailure(new Error("boom"))).toBe(false);
    expect(isRuntimeInterruptFailure("All fibers interrupted without error")).toBe(false);
  });

  it("rejects an in-flight unary request with a typed retryable error across a reconnect", async () => {
    // Regression for "sign-in is broken": a transport reconnect used to leak
    // the raw squashed interrupt (`Error("All fibers interrupted without
    // error")`) to unary callers, indistinguishable from a server error.
    const { transport, internals } = makeBareTransport();
    const client = { "some.method": () => Effect.never };
    Object.assign(internals, {
      getClient: vi.fn(async () => client),
      getClientRuntime: () => ({
        runPromise: () => Promise.reject(new Error("All fibers interrupted without error")),
      }),
    });

    await expect(transport.request("some.method", {}, { timeoutMs: null })).rejects.toMatchObject({
      _tag: "WsTransportRequestInterruptedError",
      code: "WS_REQUEST_RECONNECTED",
      method: "some.method",
      retryable: true,
    });
  });

  it("retries capacity-rejected streams in place with the server-provided delay", () => {
    expect(
      getStreamCapacityRetryDelayMs(
        Cause.fail({
          code: "THREAD_STREAM_CAPACITY_EXCEEDED",
          retryable: true,
          retryAfterMs: 1_000,
        }),
      ),
    ).toBe(1_000);
    expect(
      getStreamCapacityRetryDelayMs(
        Cause.fail({ code: "STREAM_CAPACITY_EXCEEDED", retryable: true }),
      ),
    ).toBe(1_000);
    expect(
      getStreamCapacityRetryDelayMs(
        Cause.fail({ code: "STREAM_DUPLICATE_SUBSCRIPTION", retryable: false }),
      ),
    ).toBeNull();
    expect(getStreamCapacityRetryDelayMs(Cause.fail(new Error("transient")))).toBeNull();
    expect(
      getStreamCapacityRetryDelayMs(
        Cause.fail({ code: "WS_PROTOCOL_INCOMPATIBLE", retryable: false }),
      ),
    ).toBeNull();
  });

  it("retries capacity-rejected unary requests in place with the server-provided delay", async () => {
    vi.useFakeTimers();
    bindWindowTimersToCurrentGlobals();
    try {
      const { transport, internals } = makeBareTransport();
      const capacityError = {
        code: "RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED",
        retryable: true,
        retryAfterMs: 250,
        message: "WebSocket expensive-read request capacity exceeded.",
      };
      const runPromise = vi
        .fn()
        .mockRejectedValueOnce(capacityError)
        .mockResolvedValueOnce({ contents: "ok" });
      Object.assign(internals, {
        getClient: vi.fn(async () => ({
          "projects.readFile": () => Effect.succeed({ contents: "ok" }),
        })),
        getClientRuntime: () => ({ runPromise }),
      });

      const pending = transport.request(WS_METHODS.projectsReadFile, {}, { timeoutMs: null });
      await vi.advanceTimersByTimeAsync(0);
      expect(runPromise).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(249);
      expect(runPromise).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ contents: "ok" });
      expect(runPromise).toHaveBeenCalledTimes(2);
      expect(getUnaryRpcCapacityRetryDelayMs(capacityError, 0)).toBe(250);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops retrying a unary capacity rejection after the bounded attempt budget", async () => {
    vi.useFakeTimers();
    bindWindowTimersToCurrentGlobals();
    try {
      const { transport, internals } = makeBareTransport();
      const capacityError = {
        code: "RPC_REQUEST_CAPACITY_EXCEEDED",
        retryable: true,
        retryAfterMs: 250,
        message: "WebSocket standard request capacity exceeded.",
      };
      const runPromise = vi.fn().mockRejectedValue(capacityError);
      Object.assign(internals, {
        getClient: vi.fn(async () => ({
          "projects.readFile": () => Effect.succeed({ contents: "ok" }),
        })),
        getClientRuntime: () => ({ runPromise }),
      });

      const pending = transport.request(WS_METHODS.projectsReadFile, {}, { timeoutMs: null });
      const rejected = expect(pending).rejects.toMatchObject({
        code: "RPC_REQUEST_CAPACITY_EXCEEDED",
      });
      await vi.advanceTimersByTimeAsync(0);
      for (let attempt = 0; attempt < MAX_UNARY_RPC_CAPACITY_RETRY_ATTEMPTS; attempt += 1) {
        await vi.advanceTimersByTimeAsync(250);
      }

      await rejected;
      expect(runPromise).toHaveBeenCalledTimes(MAX_UNARY_RPC_CAPACITY_RETRY_ATTEMPTS + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts an in-place unary capacity retry when the request signal aborts", async () => {
    vi.useFakeTimers();
    bindWindowTimersToCurrentGlobals();
    try {
      const { transport, internals } = makeBareTransport();
      const capacityError = {
        code: "RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED",
        retryable: true,
        retryAfterMs: 250,
        message: "WebSocket expensive-read request capacity exceeded.",
      };
      const runPromise = vi.fn().mockRejectedValue(capacityError);
      Object.assign(internals, {
        getClient: vi.fn(async () => ({
          "projects.readFile": () => Effect.succeed({ contents: "ok" }),
        })),
        getClientRuntime: () => ({ runPromise }),
      });

      const controller = new AbortController();
      const pending = transport.request(
        WS_METHODS.projectsReadFile,
        {},
        {
          timeoutMs: null,
          signal: controller.signal,
        },
      );
      const rejected = expect(pending).rejects.toMatchObject({
        code: "WS_REQUEST_ABORTED",
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(runPromise).toHaveBeenCalledTimes(1);

      controller.abort();
      await rejected;
      await vi.advanceTimersByTimeAsync(250);
      expect(runPromise).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a non-capacity unary failure in place", async () => {
    const { transport, internals } = makeBareTransport();
    const failure = new Error("file missing");
    const runPromise = vi.fn().mockRejectedValue(failure);
    Object.assign(internals, {
      getClient: vi.fn(async () => ({
        "projects.readFile": () => Effect.succeed({ contents: "ok" }),
      })),
      getClientRuntime: () => ({ runPromise }),
    });

    await expect(
      transport.request(WS_METHODS.projectsReadFile, {}, { timeoutMs: null }),
    ).rejects.toBe(failure);
    expect(runPromise).toHaveBeenCalledTimes(1);
  });

  it("backs off unexpected normal stream completions with a bounded delay", () => {
    expect(getUnexpectedStreamCompletionRetryDelayMs(1)).toBe(100);
    expect(getUnexpectedStreamCompletionRetryDelayMs(2)).toBe(200);
    expect(getUnexpectedStreamCompletionRetryDelayMs(7)).toBe(5_000);
    expect(getUnexpectedStreamCompletionRetryDelayMs(100)).toBe(5_000);
  });

  it("reconnects after an unexpected normal completion instead of reopening a zombie stream", async () => {
    vi.useFakeTimers();
    bindWindowTimersToCurrentGlobals();
    try {
      const { internals } = makeBareTransport();
      const key = "orchestration.domain";
      const snapshots: string[] = [];
      const restart = vi.fn();
      const reconnect = vi.mocked(internals.reconnect);

      internals.startStream<string>(
        {},
        key,
        Stream.make("snapshot"),
        (event) => snapshots.push(event),
        restart,
      );
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);

      expect(internals.streamCompletionRetryTimers.has(key)).toBe(true);
      expect(internals.streamCleanups.has(key)).toBe(false);
      expect(snapshots).toEqual(["snapshot"]);

      expect(reconnect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(99);
      expect(reconnect).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(reconnect).toHaveBeenCalledTimes(1);
      expect(restart).not.toHaveBeenCalled();
      expect(snapshots).toEqual(["snapshot"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending normal-completion restart when the stream is unsubscribed", async () => {
    vi.useFakeTimers();
    bindWindowTimersToCurrentGlobals();
    try {
      const { internals } = makeBareTransport();
      const key = "orchestration.domain";
      const restart = vi.fn();
      const reconnect = vi.mocked(internals.reconnect);

      internals.startStream({}, key, Stream.empty, () => undefined, restart);
      await Promise.resolve();
      await internals.stopStream(key);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(restart).not.toHaveBeenCalled();
      expect(reconnect).not.toHaveBeenCalled();
      expect(internals.streamCompletionRetryTimers.has(key)).toBe(false);
      expect(internals.streamCompletionRetries.has(key)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not restart a normally-completed stream from a superseded session generation", async () => {
    vi.useFakeTimers();
    bindWindowTimersToCurrentGlobals();
    try {
      const { internals } = makeBareTransport();
      const key = "orchestration.domain";
      const restart = vi.fn();
      const reconnect = vi.mocked(internals.reconnect);

      internals.startStream({}, key, Stream.empty, () => undefined, restart);
      await Promise.resolve();
      internals.sessionVersion += 1;
      await vi.advanceTimersByTimeAsync(5_000);

      expect(restart).not.toHaveBeenCalled();
      expect(reconnect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries duplicate-rejected streams in place despite the non-retryable marker", () => {
    const duplicate = Cause.fail({
      code: "STREAM_DUPLICATE_SUBSCRIPTION",
      retryable: false,
    });

    expect(getStreamDuplicateRetryDelayMs(duplicate, 0)).toBe(250);
    expect(
      getStreamDuplicateRetryDelayMs(
        Cause.fail({
          code: "THREAD_STREAM_DUPLICATE_SUBSCRIPTION",
          retryable: false,
          retryAfterMs: 400,
        }),
        1,
      ),
    ).toBe(400);
    expect(
      getStreamDuplicateRetryDelayMs(duplicate, MAX_STREAM_DUPLICATE_RETRY_ATTEMPTS),
    ).toBeNull();
    expect(
      getStreamDuplicateRetryDelayMs(
        Cause.fail({ code: "STREAM_CAPACITY_EXCEEDED", retryable: true }),
        0,
      ),
    ).toBeNull();
    expect(getStreamDuplicateRetryDelayMs(Cause.fail(new Error("transient")), 0)).toBeNull();
  });

  it("keeps duplicate retry admission independent from prior capacity retries", () => {
    const capacity = Cause.fail({
      code: "STREAM_CAPACITY_EXCEEDED",
      retryable: true,
      retryAfterMs: 1_000,
    });
    const duplicate = Cause.fail({
      code: "STREAM_DUPLICATE_SUBSCRIPTION",
      retryable: false,
    });

    expect(resolveStreamAdmissionRetry(capacity, 5, 0)).toEqual({
      kind: "capacity",
      attempt: 6,
      delayMs: 1_000,
    });
    expect(resolveStreamAdmissionRetry(duplicate, 5, 0)).toEqual({
      kind: "duplicate",
      attempt: 1,
      delayMs: 250,
    });
    expect(
      resolveStreamAdmissionRetry(duplicate, 0, MAX_STREAM_DUPLICATE_RETRY_ATTEMPTS),
    ).toBeNull();
  });

  it("retries a missing draft snapshot until its projection becomes visible", () => {
    const projectionLag = Cause.fail({
      code: "THREAD_SNAPSHOT_NOT_FOUND",
      retryable: false,
    });

    expect(getThreadSnapshotBootstrapRetryDelayMs(projectionLag, 0)).toBe(100);
    expect(resolveStreamAdmissionRetry(projectionLag, 0, 0, 0)).toEqual({
      kind: "thread-bootstrap",
      attempt: 1,
      delayMs: 100,
    });
    expect(
      getThreadSnapshotBootstrapRetryDelayMs(
        projectionLag,
        MAX_THREAD_SNAPSHOT_BOOTSTRAP_RETRY_ATTEMPTS,
      ),
    ).toBeNull();
    expect(
      resolveStreamAdmissionRetry(
        projectionLag,
        0,
        0,
        MAX_THREAD_SNAPSHOT_BOOTSTRAP_RETRY_ATTEMPTS,
      ),
    ).toBeNull();
  });

  it("treats structurally identical thread subscribe params as the same input", () => {
    const input = { threadId: "thread-1" };

    expect(threadStreamInputsEqual(input, input)).toBe(true);
    expect(threadStreamInputsEqual(input, { threadId: "thread-1" })).toBe(true);
    expect(threadStreamInputsEqual(input, { threadId: "thread-2" })).toBe(false);
    expect(threadStreamInputsEqual(input, { threadId: "thread-1", extra: true })).toBe(false);
    expect(threadStreamInputsEqual(undefined, { threadId: "thread-1" })).toBe(false);
  });

  it("delivers thread stream failures to listeners until they unsubscribe", () => {
    const { transport, internals } = makeBareTransport();
    const failure: WsThreadStreamFailure = {
      threadId: "thread-failed",
      code: "THREAD_SNAPSHOT_NOT_FOUND",
      error: new Error("snapshot missing"),
    };
    const throwing = vi.fn(() => {
      throw new Error("listener exploded");
    });
    const listener = vi.fn();

    const unsubscribeThrowing = transport.onThreadStreamFailure(throwing);
    const unsubscribe = transport.onThreadStreamFailure(listener);
    internals.emitThreadStreamFailure(failure);

    expect(throwing).toHaveBeenCalledWith(failure);
    expect(listener).toHaveBeenCalledWith(failure);

    unsubscribe();
    unsubscribeThrowing();
    internals.emitThreadStreamFailure(failure);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("waits for a thread stream to settle before resolving unsubscribe", async () => {
    const { transport, internals } = makeBareTransport();
    const threadId = "thread-release-order";
    const key = `orchestration.thread:${threadId}`;
    let settleStream: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      settleStream = resolve;
    });
    const cleanup = vi.fn();
    internals.threadSubscriptions.set(threadId, { threadId });
    internals.streamCleanups.set(key, cleanup);
    internals.streamSettled.set(key, settled);

    let unsubscribeResolved = false;
    const unsubscribe = transport
      .request(ORCHESTRATION_WS_METHODS.unsubscribeThread, { threadId })
      .then(() => {
        unsubscribeResolved = true;
      });
    await Promise.resolve();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(unsubscribeResolved).toBe(false);

    settleStream();
    await unsubscribe;
    expect(unsubscribeResolved).toBe(true);
  });

  it("cancels owned capacity retry timers when a stream stops", async () => {
    vi.useFakeTimers();
    try {
      const { transport, internals } = makeBareTransport();
      const key = "orchestration.thread:thread-cancel-retry";
      const retry = vi.fn();
      const timeoutId = window.setTimeout(retry, 1_000);
      internals.streamCapacityRetries.set(key, 2);
      internals.projectFileWatchRetries.set(key, 2);
      internals.streamCapacityRetryTimers.set(key, timeoutId);

      await transport.request(ORCHESTRATION_WS_METHODS.unsubscribeThread, {
        threadId: "thread-cancel-retry",
      });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(retry).not.toHaveBeenCalled();
      expect(internals.streamCapacityRetryTimers.has(key)).toBe(false);
      expect(internals.streamCapacityRetries.has(key)).toBe(false);
      expect(internals.projectFileWatchRetries.has(key)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let stale or duplicate thread restarts replace the active stream", async () => {
    const { internals } = makeBareTransport();
    const threadId = "thread-current-generation";
    const key = `orchestration.thread:${threadId}`;
    const currentInput = { threadId, generation: "current" };
    const staleInput = { threadId, generation: "stale" };
    const cleanup = vi.fn();
    internals.threadSubscriptions.set(threadId, currentInput);
    internals.streamCleanups.set(key, cleanup);
    internals.activeThreadStreamInputs.set(key, currentInput);

    await internals.startThreadStream({}, threadId, staleInput);
    await internals.startThreadStream({}, threadId, currentInput);

    expect(cleanup).not.toHaveBeenCalled();
    expect(internals.streamCleanups.get(key)).toBe(cleanup);
  });

  it("force-restarts an identical live thread stream for a fresh snapshot", async () => {
    const { internals } = makeBareTransport();
    const threadId = "thread-force-snapshot";
    const key = `orchestration.thread:${threadId}`;
    const input = { threadId };
    const cleanup = vi.fn();
    const subscribeThread = vi.fn(() => ({}));
    const stopStream = vi.fn(async () => {
      internals.streamCleanups.delete(key);
      internals.activeThreadStreamInputs.delete(key);
    });
    const startStream = vi.fn();
    Object.assign(internals, {
      disposed: false,
      sessionVersion: 7,
      stopStream,
      startStream,
    });
    internals.threadSubscriptions.set(threadId, input);
    internals.streamCleanups.set(key, cleanup);
    internals.activeThreadStreamInputs.set(key, input);

    await internals.startThreadStream(
      { [ORCHESTRATION_WS_METHODS.subscribeThread]: subscribeThread },
      threadId,
      input,
      true,
    );

    expect(stopStream).toHaveBeenCalledWith(key, { resetCapacityRetry: false });
    expect(subscribeThread).toHaveBeenCalledWith(input);
    expect(startStream).toHaveBeenCalledWith(
      expect.anything(),
      key,
      {},
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("treats an explicit identical thread subscribe as a forced snapshot refresh", async () => {
    const { transport, internals } = makeBareTransport();
    const threadId = "thread-explicit-snapshot";
    const input = { threadId };
    const client = {};
    const startThreadStream = vi.fn(async () => undefined);
    Object.assign(internals, {
      disposed: false,
      getClient: vi.fn(async () => client),
      startThreadStream,
    });
    internals.threadSubscriptions.set(threadId, input);

    await transport.request(ORCHESTRATION_WS_METHODS.subscribeThread, { threadId });

    expect(startThreadStream).toHaveBeenCalledWith(client, threadId, input, true);
  });

  it("retains shell and thread subscription intent while the initial connection is unavailable", async () => {
    vi.useFakeTimers();
    try {
      const { transport, internals } = makeBareTransport();
      const threadId = "thread-slow-start";
      Object.assign(internals, {
        shellSubscribed: false,
        getClient: vi.fn(() => new Promise(() => {})),
      });

      const shellRequest = transport
        .request(ORCHESTRATION_WS_METHODS.subscribeShell, {}, { timeoutMs: 25 })
        .catch((error: unknown) => error);
      const threadRequest = transport
        .request(ORCHESTRATION_WS_METHODS.subscribeThread, { threadId }, { timeoutMs: 25 })
        .catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(25);

      await expect(shellRequest).resolves.toMatchObject({ code: "WS_REQUEST_TIMEOUT" });
      await expect(threadRequest).resolves.toMatchObject({ code: "WS_REQUEST_TIMEOUT" });
      expect(internals.shellSubscribed).toBe(true);
      expect(internals.threadSubscriptions.get(threadId)).toEqual({ threadId });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start the project-agent stream when unsubscribe lands during the connect wait", async () => {
    const { transport, internals } = makeBareTransport();
    const client = {};
    const clientResolvers: Array<(client: unknown) => void> = [];
    const startProjectAgentEventStream = vi.fn();
    Object.assign(internals, {
      getClient: vi.fn(
        () =>
          new Promise((resolve) => {
            clientResolvers.push(resolve);
          }),
      ),
      startProjectAgentEventStream,
    });

    const projectId = "project-pending";
    const params = { projectId };
    const subscribe = transport.request(WS_METHODS.subscribeProjectAgentEvents, params);

    await vi.waitFor(() => expect(internals.projectAgentSubscriptions.get(projectId)).toBe(params));
    await transport.unsubscribeProjectAgentEvents(projectId);

    for (const resolve of clientResolvers) resolve(client);
    await subscribe;

    expect(startProjectAgentEventStream).not.toHaveBeenCalled();
    expect(internals.projectAgentSubscriptions.has(projectId)).toBe(false);
  });

  it("starts only the newest registered project-agent subscription after the connect wait", async () => {
    const { transport, internals } = makeBareTransport();
    const client = {};
    const clientResolvers: Array<(client: unknown) => void> = [];
    const startProjectAgentEventStream = vi.fn();
    Object.assign(internals, {
      getClient: vi.fn(
        () =>
          new Promise((resolve) => {
            clientResolvers.push(resolve);
          }),
      ),
      startProjectAgentEventStream,
    });

    const projectId = "project-pending";
    const first = { projectId };
    const second = { projectId };
    const firstSubscribe = transport.request(WS_METHODS.subscribeProjectAgentEvents, first);
    await vi.waitFor(() => expect(internals.projectAgentSubscriptions.get(projectId)).toBe(first));
    const secondSubscribe = transport.request(WS_METHODS.subscribeProjectAgentEvents, second);
    await vi.waitFor(() => expect(internals.projectAgentSubscriptions.get(projectId)).toBe(second));

    for (const resolve of clientResolvers) resolve(client);
    await firstSubscribe;
    await secondSubscribe;

    expect(startProjectAgentEventStream).toHaveBeenCalledTimes(1);
    expect(startProjectAgentEventStream).toHaveBeenCalledWith(client, projectId, second);
  });

  it("does not restart an automatically restored shell stream for the initial subscriber", async () => {
    const { transport, internals } = makeBareTransport();
    const client = {};
    let resolveClient!: (client: unknown) => void;
    const startShellStream = vi.fn(async () => undefined);
    Object.assign(internals, {
      shellSubscribed: false,
      shellSnapshotDelivered: false,
      getClient: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveClient = resolve;
          }),
      ),
      startShellStream,
    });

    const subscription = transport.request(ORCHESTRATION_WS_METHODS.subscribeShell, {});
    // Recovery restored the desired stream and delivered its snapshot before
    // the original request resumed.
    Object.assign(internals, { shellSnapshotDelivered: true });
    resolveClient(client);
    await subscription;

    expect(startShellStream).toHaveBeenCalledWith(client, false);
  });

  it("uses bounded exponential reconnect backoff", () => {
    expect(getReconnectRetryDelayMs(0)).toBe(500);
    expect(getReconnectRetryDelayMs(1)).toBe(1_000);
    expect(getReconnectRetryDelayMs(3)).toBe(4_000);
    expect(getReconnectRetryDelayMs(4)).toBe(5_000);
    expect(getReconnectRetryDelayMs(100)).toBe(5_000);
  });

  it("joins an active reconnect instead of returning the detached prior client", async () => {
    const transport = Object.create(WsTransport.prototype) as WsTransport;
    const internals = transport as unknown as WsTransportInternals;
    const recoveredClient = { generation: "recovered" };
    Object.assign(internals, {
      reconnectPromise: Promise.resolve(recoveredClient),
      clientPromise: Promise.resolve({ generation: "stale" }),
    });

    await expect(internals.getClient()).resolves.toBe(recoveredClient);
  });

  it("keeps reconnecting and restores shell, thread and file subscriptions after recovery", async () => {
    vi.useFakeTimers();
    bindWindowTimersToCurrentGlobals();
    try {
      const transport = Object.create(WsTransport.prototype) as WsTransport;
      const internals = transport as unknown as WsTransportInternals;
      const threadId = "thread-reconnect";
      const input = { threadId };
      const client = { connected: true };
      const createSession = vi
        .fn()
        .mockImplementationOnce(() => ({
          clientPromise: Promise.reject(new Error("starting-1")),
        }))
        .mockImplementationOnce(() => ({
          clientPromise: Promise.reject(new Error("starting-2")),
        }))
        .mockImplementationOnce(() => ({ clientPromise: Promise.resolve(client) }));
      const startChannelStream = vi.fn();
      const startShellStream = vi.fn(async () => undefined);
      const startThreadStream = vi.fn(async () => undefined);
      const startProjectFileChangeStream = vi.fn();
      const watchedFile = {
        input: { cwd: "/repo", relativePath: "app.ts" },
        listeners: new Set([vi.fn()]),
      };
      const fileKey = projectFileChangeStreamKey(watchedFile.input);
      Object.assign(internals, {
        disposed: false,
        state: "closed",
        stateListeners: new Set(),
        reconnectFailures: 0,
        lifetime: new AbortController(),
        listeners: new Map([[WS_CHANNELS.serverWelcome, new Set([vi.fn()])]]),
        shellSubscribed: true,
        threadSubscriptions: new Map([[threadId, input]]),
        projectFileSubscriptions: new Map([[fileKey, watchedFile]]),
        projectAgentSubscriptions: new Map(),
        startProjectFileChangeStream,
        runtime: null,
        clientScope: null,
        createSession,
        takeCurrentRuntime: () => null,
        closeRuntime: vi.fn(async () => undefined),
        startChannelStream,
        startShellStream,
        refreshThreadSubscriptionInput: () => input,
        startThreadStream,
      });

      const recovery = internals.openReconnectSession();
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(recovery).resolves.toBe(client);
      expect(createSession).toHaveBeenCalledTimes(3);
      expect(startChannelStream).toHaveBeenCalledOnce();
      expect(startShellStream).toHaveBeenCalledOnce();
      expect(startThreadStream).toHaveBeenCalledOnce();
      expect(startThreadStream).toHaveBeenCalledWith(client, threadId, input);
      expect(startProjectFileChangeStream).toHaveBeenCalledExactlyOnceWith(
        client,
        fileKey,
        watchedFile,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending reconnect delay during transport shutdown", async () => {
    vi.useFakeTimers();
    bindWindowTimersToCurrentGlobals();
    try {
      const transport = Object.create(WsTransport.prototype) as WsTransport;
      const internals = transport as unknown as WsTransportInternals & {
        disposed: boolean;
        lifetime: AbortController;
      };
      const lifetime = new AbortController();
      const createSession = vi.fn();
      Object.assign(internals, {
        disposed: false,
        state: "closed",
        stateListeners: new Set(),
        reconnectFailures: 0,
        lifetime,
        createSession,
      });

      const recovery = internals.openReconnectSession();
      internals.disposed = true;
      lifetime.abort(new Error("Transport disposed"));

      await expect(recovery).rejects.toThrow("Transport disposed");
      expect(createSession).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("latches terminal compatibility guidance for late UI subscribers", () => {
    const issue = new WsCompatibilityError({
      message: "Update this client.",
      code: "WS_PROTOCOL_INCOMPATIBLE",
      retryable: false,
      action: "update-client",
      serverBuild: "0.5.2",
      protocolEpoch: WS_PROTOCOL_EPOCH,
      minRevision: WS_PROTOCOL_MIN_REVISION,
      maxRevision: WS_PROTOCOL_MAX_REVISION,
    });
    const listener = vi.fn();

    emitWsCompatibilityIssue(issue);
    const unsubscribe = addWsCompatibilityIssueListener(listener, { replayCurrent: true });

    expect(readLatestWsCompatibilityIssue()).toBe(issue);
    expect(listener).toHaveBeenCalledWith(issue);
    expect(getTerminalCompatibilityError(issue)).toBe(issue);

    unsubscribe();
    emitWsCompatibilityIssue(null);
  });

  it("owns request deadlines and external aborts without leaving timers active", async () => {
    vi.useFakeTimers();
    try {
      const deadline = makeRequestAbortScope({ timeoutMs: 25 });
      expect(deadline.signal?.aborted).toBe(false);
      expect(deadline.didTimeout()).toBe(false);

      await vi.advanceTimersByTimeAsync(25);
      expect(deadline.signal?.aborted).toBe(true);
      expect(deadline.didTimeout()).toBe(true);
      deadline.cleanup();
      deadline.cleanup();

      const external = new AbortController();
      const cancelled = makeRequestAbortScope({ timeoutMs: 1_000, signal: external.signal });
      external.abort(new Error("cancelled by caller"));
      expect(cancelled.signal?.aborted).toBe(true);
      expect(cancelled.didTimeout()).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(cancelled.didTimeout()).toBe(false);
      cancelled.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the shared lifecycle stream while either lifecycle channel is active", () => {
    expect(shouldKeepServerLifecycleStream(new Set([WS_CHANNELS.serverWelcome]))).toBe(true);
    expect(shouldKeepServerLifecycleStream(new Set([WS_CHANNELS.serverMaintenanceUpdated]))).toBe(
      true,
    );
    expect(
      shouldKeepServerLifecycleStream(
        new Set([WS_CHANNELS.serverWelcome, WS_CHANNELS.serverMaintenanceUpdated]),
      ),
    ).toBe(true);
    expect(shouldKeepServerLifecycleStream(new Set([WS_CHANNELS.serverConfigUpdated]))).toBe(false);
  });

  it("falls back to the legacy bootstrap socket when HTTP negotiation is unavailable", async () => {
    const transport = new WsTransport("ws://localhost:3020");

    expect(transport.getState()).toBe("connecting");
    await waitForSockets(1);
    expect(sockets[0]?.url).toBe("ws://localhost:3020/ws/bootstrap");

    await transport.dispose();
  });

  it("detects a server identity change across a failed reconnect", () => {
    // The negotiated compatibility is cleared on every failed reconnect, so
    // the comparison must use the last identity actually reached — otherwise a
    // restore whose downtime outlasts the first retry keeps stale cursors,
    // which is the case this guard exists for.
    expect(serverIdentityChanged(null, "instance-a")).toBe(false);
    expect(serverIdentityChanged("instance-a", "instance-a")).toBe(false);
    expect(serverIdentityChanged("instance-a", "instance-b")).toBe(true);
  });

  it("negotiates over HTTP so a connect opens only the feature socket", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request) =>
      Promise.resolve(jsonResponse(200, NEGOTIATION_RESULT)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const transport = new WsTransport("ws://localhost:3020");
    await waitForSockets(1);

    expect(transport.getState()).toBe("connecting");
    sockets[0]!.serveVoidRpc();
    await vi.waitFor(() => expect(transport.getState()).toBe("open"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const negotiateUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(negotiateUrl.protocol).toBe("http:");
    expect(negotiateUrl.pathname).toBe("/ws/negotiate");
    expect(negotiateUrl.searchParams.get(WS_NEGOTIATE_QUERY.protocolEpoch)).toBe(
      String(WS_PROTOCOL_EPOCH),
    );
    expect(sockets).toHaveLength(1);
    const featureUrl = new URL(sockets[0]!.url);
    expect(featureUrl.pathname).toBe("/ws");
    expect(featureUrl.searchParams.get(WS_COMPATIBILITY_QUERY.serverInstanceId)).toBe(
      NEGOTIATION_RESULT.serverInstanceId,
    );

    await transport.dispose();
  });

  it("surfaces a 426 HTTP negotiation refusal as a terminal compatibility error", async () => {
    const refusal = new WsCompatibilityError({
      message: "Update this client.",
      code: "WS_PROTOCOL_INCOMPATIBLE",
      retryable: false,
      action: "update-client",
      serverBuild: "0.5.2",
      protocolEpoch: WS_PROTOCOL_EPOCH,
      minRevision: WS_PROTOCOL_MIN_REVISION,
      maxRevision: WS_PROTOCOL_MAX_REVISION,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(426, JSON.parse(JSON.stringify(refusal))))),
    );

    await expect(negotiateOverHttp("ws://localhost:3020")).rejects.toSatisfy((error) =>
      isTerminalCompatibilityFailure(error),
    );
    // A non-426 failure (older server, transient outage) must fall back to the
    // legacy bootstrap socket instead of failing the connect.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(404, null))),
    );
    await expect(negotiateOverHttp("ws://localhost:3020")).resolves.toBeNull();
  });

  it.each([404, 503])(
    "falls back on HTTP %s without waiting for its error body",
    async (status) => {
      let finishBody!: () => void;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          finishBody = () => controller.close();
        },
        cancel() {
          finishBody = () => undefined;
        },
      });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status })));
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          negotiateOverHttp("ws://localhost:3020"),
          new Promise<string>((resolve) => {
            timeout = setTimeout(() => resolve("still waiting for an irrelevant error body"), 100);
          }),
        ]);
        expect(result).toBeNull();
      } finally {
        clearTimeout(timeout);
        finishBody();
      }
    },
  );

  it("falls back to bootstrap when the negotiate request never settles", async () => {
    // A connection that accepts and then stalls (WAN/tunnel black hole) must
    // not wedge the transport: browsers apply no default fetch timeout, so
    // without an abort signal the bootstrap fallback would never run.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: unknown, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("The operation was aborted.", "AbortError")),
            );
          }),
      ),
    );

    await expect(negotiateOverHttp("ws://localhost:3020")).resolves.toBeNull();
  }, 10_000);

  it("aborts a stalled negotiate when the caller's lifetime signal fires", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: unknown, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("The operation was aborted.", "AbortError")),
            );
          }),
      ),
    );

    const negotiation = negotiateOverHttp("ws://localhost:3020", controller.signal);
    controller.abort();
    // Resolves well before the 5s deadline because disposal, not the timeout,
    // ended the request.
    await expect(negotiation).resolves.toBeNull();
  });

  it("does not create a bootstrap socket when disposed during negotiation", async () => {
    // dispose() captures a null runtime and returns while the HTTP request is
    // still pending; the transport must not build one afterwards.
    let abortNegotiation: (() => void) | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: unknown, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            abortNegotiation = () =>
              reject(new DOMException("The operation was aborted.", "AbortError"));
            init?.signal?.addEventListener("abort", () => abortNegotiation?.());
          }),
      ),
    );

    const transport = new WsTransport();
    // subscribeShell reaches getClient(), so the request genuinely drives the
    // connect path rather than relying on the constructor's eager session.
    const connecting = transport
      .request(ORCHESTRATION_WS_METHODS.subscribeShell, {})
      .catch(() => null);
    await Promise.resolve();
    const socketsBefore = sockets.length;

    await transport.dispose();
    await connecting;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sockets.length).toBe(socketsBefore);
  }, 10_000);

  it("uses the desktop bridge URL before falling back to the browser location", async () => {
    const getWsUrl = vi.fn().mockReturnValue("ws://127.0.0.1:53036/?token=old");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { protocol: "http:", hostname: "localhost", port: "3020" },
        desktopBridge: { getWsUrl },
      },
    });

    const transport = new WsTransport();
    await waitForSockets(1);

    expect(getWsUrl).toHaveBeenCalled();
    expect(sockets[0]?.url).toBe("ws://127.0.0.1:53036/ws/bootstrap?token=old");

    await transport.dispose();
  });

  it("falls back to the current browser host when no desktop bridge URL exists", async () => {
    const transport = new WsTransport();
    await waitForSockets(1);

    expect(sockets[0]?.url).toBe("ws://localhost:3020/ws/bootstrap");

    await transport.dispose();
  });

  it("reuses cached negotiation on reconnect while the server instance is unchanged", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, NEGOTIATION_RESULT)));
    vi.stubGlobal("fetch", fetchMock);

    const transport = new WsTransport("ws://localhost:3020");
    const internals = transport as unknown as {
      createSession(): { clientPromise: Promise<unknown> };
      probeFeatureConnection: (...args: unknown[]) => Promise<void>;
      compatibility: WsBootstrapNegotiateResult | null;
    };
    await waitForSockets(1);
    sockets[0]!.serveVoidRpc();
    await vi.waitFor(() => expect(transport.getState()).toBe("open"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(internals.compatibility).toEqual(NEGOTIATION_RESULT);

    const probe = vi.fn(async () => undefined);
    internals.probeFeatureConnection = probe;
    await internals.createSession().clientPromise;

    // Reconnect on the same server generation opens exactly one new socket and
    // performs no renegotiation round trip — only the liveness probe.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(2);
    const reconnectUrl = new URL(sockets[1]!.url);
    expect(reconnectUrl.pathname).toBe("/ws");
    expect(reconnectUrl.searchParams.get(WS_COMPATIBILITY_QUERY.serverInstanceId)).toBe(
      NEGOTIATION_RESULT.serverInstanceId,
    );

    await transport.dispose();
  });

  it("renegotiates and resets replayed push state when the server instance changed", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, NEGOTIATION_RESULT)));
    vi.stubGlobal("fetch", fetchMock);

    const transport = new WsTransport("ws://localhost:3020");
    const internals = transport as unknown as {
      createSession(): { clientPromise: Promise<unknown> };
      compatibility: WsBootstrapNegotiateResult | null;
      latestPushByChannel: Map<string, unknown>;
      sequence: number;
    };
    await waitForSockets(1);
    sockets[0]!.serveVoidRpc();
    await vi.waitFor(() => expect(transport.getState()).toBe("open"));
    internals.latestPushByChannel.set("server.welcome", { stale: true });
    internals.sequence = 7;

    // A failed session clears the cache (probe or socket failure), so the next
    // reconnect renegotiates and lands on the restarted server generation.
    internals.compatibility = null;
    const restarted = { ...NEGOTIATION_RESULT, serverInstanceId: "server-instance-2" };
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, restarted)));
    const reconnected = internals.createSession().clientPromise;
    await waitForSockets(2);
    sockets[1]!.serveVoidRpc();
    await reconnected;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(internals.compatibility).toEqual(restarted);
    expect(internals.latestPushByChannel.size).toBe(0);
    expect(internals.sequence).toBe(0);
    const reconnectUrl = new URL(sockets[1]!.url);
    expect(reconnectUrl.searchParams.get(WS_COMPATIBILITY_QUERY.serverInstanceId)).toBe(
      "server-instance-2",
    );

    await transport.dispose();
  });

  it("mirrors the negotiate endpoint onto the WS host with an HTTP scheme", () => {
    const url = new URL(makeNegotiateHttpUrl("wss://remote.example:8443/?token=old"));

    expect(url.protocol).toBe("https:");
    expect(url.host).toBe("remote.example:8443");
    expect(url.pathname).toBe("/ws/negotiate");
    expect(url.searchParams.get("token")).toBe("old");
    expect(url.searchParams.get(WS_NEGOTIATE_QUERY.minRevision)).toBe(
      String(WS_PROTOCOL_MIN_REVISION),
    );
    expect(url.searchParams.get(WS_NEGOTIATE_QUERY.maxRevision)).toBe(
      String(WS_PROTOCOL_MAX_REVISION),
    );
  });

  it("pins the feature socket to the negotiated revision and server generation", () => {
    const resolved = new URL(
      makeFeatureSocketUrl("ws://127.0.0.1:53036/?token=old", {
        protocolEpoch: WS_PROTOCOL_EPOCH,
        negotiatedRevision: WS_PROTOCOL_MAX_REVISION,
        serverBuild: "0.5.2",
        serverInstanceId: "server-instance",
        capabilities: ["orchestration.cursor-safe-streams"],
      }),
    );

    expect(resolved.pathname).toBe("/ws");
    expect(resolved.searchParams.get("token")).toBe("old");
    expect(resolved.searchParams.get(WS_COMPATIBILITY_QUERY.protocolRevision)).toBe(
      String(WS_PROTOCOL_MAX_REVISION),
    );
    expect(resolved.searchParams.get(WS_COMPATIBILITY_QUERY.serverInstanceId)).toBe(
      "server-instance",
    );
  });

  it("notifies state listeners and replays the current state on demand", async () => {
    const transport = new WsTransport();
    const listener = vi.fn();

    const unsubscribe = transport.onStateChange(listener, { replayCurrent: true });

    expect(listener).toHaveBeenCalledWith("connecting");

    listener.mockClear();
    await transport.dispose();

    expect(listener).toHaveBeenCalledWith("disposed");

    listener.mockClear();
    unsubscribe();
    await transport.dispose();

    expect(listener).not.toHaveBeenCalled();
  });
});

it("tracks the real unary wait while keeping the heartbeat out of pending counts", async () => {
  vi.useFakeTimers();
  bindWindowTimersToCurrentGlobals();
  const { transport, internals } = makeBareTransport();
  const serverBusy = new ServerBusyController();
  const client = {
    [WS_METHODS.serverGetRuntimeStatus]: () =>
      Effect.succeed({
        available: false,
        sampleWindowMs: 0,
        sampleCount: 0,
        delayP50Ms: 0,
        delayP99Ms: 0,
        delayMaxMs: 0,
        utilization: 0,
        stallWindowCount: 0,
        maxStallMs: 0,
        lastStall: null,
      }),
    [WS_METHODS.gitStatus]: () => Effect.never,
  };
  Object.assign(internals, {
    serverBusy,
    state: "connecting",
    stateListeners: new Set(),
    compatibility: { ...NEGOTIATION_RESULT, capabilities: [WS_SERVER_RUNTIME_STATUS_CAPABILITY] },
    getClient: async () => client,
    getClientRuntime: () => ({ runPromise: Effect.runPromise }),
  });
  (transport as unknown as { setState(state: string): void }).setState("open");
  const verdict = transport.request(WS_METHODS.gitStatus).catch((error) => error);
  await vi.advanceTimersByTimeAsync(15000);
  expect(serverBusy.getSnapshot()).toMatchObject({
    reason: null,
    pendingRequests: 1,
    slowRequests: 1,
  });
  await vi.advanceTimersByTimeAsync(45000);
  expect(await verdict).toMatchObject({
    message: expect.stringContaining("Try again when the server responds"),
  });
  expect(serverBusy.getSnapshot()).toMatchObject({
    reason: null,
    pendingRequests: 0,
    slowRequests: 0,
  });
  serverBusy.dispose();
  vi.useRealTimers();
});

it("uses the caller's long-operation budget for providerCompactThread", async () => {
  vi.useFakeTimers();
  bindWindowTimersToCurrentGlobals();
  const { transport, internals } = makeBareTransport();
  const serverBusy = new ServerBusyController();
  const caller = new AbortController();
  Object.assign(internals, {
    serverBusy,
    getClient: async () => ({ [WS_METHODS.providerCompactThread]: () => Effect.never }),
    getClientRuntime: () => ({ runPromise: Effect.runPromise }),
  });
  const pending = transport
    .request(
      WS_METHODS.providerCompactThread,
      {},
      {
        timeoutMs: null,
        signal: caller.signal,
      },
    )
    .catch((error) => error);
  try {
    await vi.advanceTimersByTimeAsync(15_000);
    expect(serverBusy.getSnapshot()).toMatchObject({ pendingRequests: 1, slowRequests: 0 });
    await vi.advanceTimersByTimeAsync(105_000);
    expect(serverBusy.getSnapshot().slowRequests).toBe(1);
    caller.abort();
    expect(await pending).toMatchObject({ code: "WS_REQUEST_ABORTED" });
    expect(serverBusy.getSnapshot().pendingRequests).toBe(0);
  } finally {
    caller.abort();
    serverBusy.dispose();
    vi.useRealTimers();
  }
});

it.each([true, false])(
  "uses busy liveness only when the optional capability is present (%s)",
  async (supported) => {
    vi.useFakeTimers();
    bindWindowTimersToCurrentGlobals();
    const { transport, internals } = makeBareTransport();
    const serverBusy = new ServerBusyController();
    Object.assign(internals, {
      serverBusy,
      state: "connecting",
      stateListeners: new Set(),
      compatibility: {
        ...NEGOTIATION_RESULT,
        capabilities: supported ? [WS_SERVER_RUNTIME_STATUS_CAPABILITY] : [],
      },
      getClient: async () => ({ [WS_METHODS.serverGetRuntimeStatus]: () => Effect.never }),
      getClientRuntime: () => ({ runPromise: Effect.runPromise }),
    });
    (transport as unknown as { setState(state: string): void }).setState("open");
    await vi.advanceTimersByTimeAsync(3000);
    expect(serverBusy.getSnapshot().reason).toBe(supported ? "unresponsive" : null);
    (transport as unknown as { setState(state: string): void }).setState("connecting");
    expect(serverBusy.getSnapshot().reason).toBe(null);
    serverBusy.dispose();
    vi.useRealTimers();
  },
);

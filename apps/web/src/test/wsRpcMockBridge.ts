import {
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  WS_CHANNELS,
  WS_METHODS,
} from "@t3tools/contracts";

// Browser tests mock the WebSocket via msw's `ws.link`, but the production
// transport speaks the Effect (effect-smol) raw RPC protocol over `layerJson`,
// not the legacy `{ type: "push" }` / `{ id, result }` envelope the tests were
// written against. This bridge translates between the two so the existing test
// fixtures keep their high-level shape:
//
//   - request decode: { _tag: "Request", id, tag, payload }
//   - effect reply:   { _tag: "Exit", requestId, exit: { _tag: "Success", value } }
//   - stream chunk:   { _tag: "Chunk", requestId, values: [value] }
//   - ping:           { _tag: "Ping" } -> { _tag: "Pong" }
//
// Stream methods stay open; their pushed events are delivered as Chunks on the
// originating requestId. The channel each push targets determines which open
// stream and wire-value shape is used (mirrors wsTransport.ts stream wiring).

const STREAM_TAGS = new Set<string>([
  ORCHESTRATION_WS_METHODS.subscribeShell,
  ORCHESTRATION_WS_METHODS.subscribeThread,
  WS_METHODS.subscribeOrchestrationDomainEvents,
  WS_METHODS.subscribeServerLifecycle,
  WS_METHODS.subscribeServerConfig,
  WS_METHODS.subscribeServerProviderStatuses,
  WS_METHODS.subscribeServerSettings,
  WS_METHODS.subscribeTerminalEvents,
  WS_METHODS.subscribeReviewUpdates,
  WS_METHODS.gitRunStackedAction,
]);

function channelToStreamTag(channel: string): string | null {
  if (channel === WS_CHANNELS.serverWelcome || channel === WS_CHANNELS.serverMaintenanceUpdated) {
    return WS_METHODS.subscribeServerLifecycle;
  }
  if (channel === WS_CHANNELS.serverConfigUpdated) return WS_METHODS.subscribeServerConfig;
  if (channel === WS_CHANNELS.serverProviderStatusesUpdated) {
    return WS_METHODS.subscribeServerProviderStatuses;
  }
  if (channel === WS_CHANNELS.serverSettingsUpdated) return WS_METHODS.subscribeServerSettings;
  if (channel === WS_CHANNELS.terminalEvent) return WS_METHODS.subscribeTerminalEvents;
  if (channel === WS_CHANNELS.reviewUpdated) return WS_METHODS.subscribeReviewUpdates;
  if (channel === WS_CHANNELS.gitActionProgress) return WS_METHODS.gitRunStackedAction;
  if (channel === ORCHESTRATION_WS_CHANNELS.domainEvent) {
    return WS_METHODS.subscribeOrchestrationDomainEvents;
  }
  if (channel === ORCHESTRATION_WS_CHANNELS.shellEvent) return ORCHESTRATION_WS_METHODS.subscribeShell;
  if (channel === ORCHESTRATION_WS_CHANNELS.threadEvent) {
    return ORCHESTRATION_WS_METHODS.subscribeThread;
  }
  return null;
}

// The transport unwraps lifecycle stream items before emitting them on the
// welcome/maintenance channels, so re-wrap a channel push into the stream-item
// shape the transport expects to receive on the wire.
function channelDataToWireValue(channel: string, data: unknown): unknown {
  if (channel === WS_CHANNELS.serverWelcome) {
    return { type: "welcome", payload: data };
  }
  if (channel === WS_CHANNELS.serverConfigUpdated) {
    return { type: "configUpdated", payload: data };
  }
  return data;
}

interface DecodedRequest {
  readonly _tag: "Request";
  readonly id: string;
  readonly tag: string;
  readonly payload: unknown;
}

interface PushEnvelope {
  readonly type: "push";
  readonly channel: string;
  readonly data: unknown;
}

interface ResultEnvelope {
  readonly id: string;
  readonly result: unknown;
}

type MockClient = {
  send(data: string): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
};

export interface RpcBridgeHandlers {
  // Resolve an effect (non-stream) RPC call to its result value.
  readonly resolveRpc: (tag: string, payload: unknown) => unknown;
  // Called when a stream subscription opens. `emit` pushes a stream-item value
  // as a Chunk on that subscription's request id. Return value is ignored.
  readonly onStreamOpen?: (
    tag: string,
    payload: unknown,
    emit: (value: unknown) => void,
  ) => void;
}

export interface RpcBridge {
  // Push a server-initiated event on a channel; routed to the matching open
  // stream as a Chunk. No-op if that stream is not currently subscribed.
  pushToChannel(channel: string, data: unknown): void;
}

// Patches `client.send` so test code can keep emitting the legacy
// `{ type: "push", channel, data }` and `{ id, result }` envelopes, and wires up
// the request decoder. Returns a bridge for direct channel pushes.
export function installRpcBridge(client: MockClient, handlers: RpcBridgeHandlers): RpcBridge {
  // requestId by stream tag (single-instance streams).
  const streamRequestIdByTag = new Map<string, string>();
  // requestId by threadId for per-thread subscriptions.
  const threadStreamRequestIdByThreadId = new Map<string, string>();

  const rawSend = client.send.bind(client);

  const sendChunk = (requestId: string, value: unknown): void => {
    rawSend(JSON.stringify({ _tag: "Chunk", requestId, values: [value] }));
  };

  const sendExit = (requestId: string, value: unknown): void => {
    rawSend(
      JSON.stringify({
        _tag: "Exit",
        requestId,
        exit: { _tag: "Success", value },
      }),
    );
  };

  client.send = ((data: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      rawSend(data);
      return;
    }
    if (parsed && typeof parsed === "object" && (parsed as { type?: unknown }).type === "push") {
      const push = parsed as PushEnvelope;
      pushToChannel(push.channel, push.data);
      return;
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      "id" in parsed &&
      "result" in parsed &&
      !("_tag" in parsed)
    ) {
      const reply = parsed as ResultEnvelope;
      sendExit(reply.id, reply.result);
      return;
    }
    rawSend(data);
  }) as MockClient["send"];

  function pushToChannel(channel: string, data: unknown): void {
    const tag = channelToStreamTag(channel);
    if (!tag) return;
    const value = channelDataToWireValue(channel, data);
    if (tag === ORCHESTRATION_WS_METHODS.subscribeThread) {
      for (const requestId of threadStreamRequestIdByThreadId.values()) {
        sendChunk(requestId, value);
      }
      return;
    }
    const requestId = streamRequestIdByTag.get(tag);
    if (requestId !== undefined) sendChunk(requestId, value);
  }

  client.addEventListener("message", (event) => {
    const raw = event.data;
    if (typeof raw !== "string") return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return;
    }
    if (!decoded || typeof decoded !== "object") return;
    const tagged = decoded as { _tag?: string };
    if (tagged._tag === "Ping") {
      rawSend(JSON.stringify({ _tag: "Pong" }));
      return;
    }
    if (tagged._tag !== "Request") return;
    const request = decoded as DecodedRequest;
    const { id, tag, payload } = request;

    if (STREAM_TAGS.has(tag)) {
      if (tag === ORCHESTRATION_WS_METHODS.subscribeThread) {
        const threadId = (payload as { threadId?: string })?.threadId;
        if (typeof threadId === "string") {
          threadStreamRequestIdByThreadId.set(threadId, id);
        }
      } else {
        streamRequestIdByTag.set(tag, id);
      }
      handlers.onStreamOpen?.(tag, payload, (value) => sendChunk(id, value));
      return;
    }

    sendExit(id, handlers.resolveRpc(tag, payload));
  });

  return { pushToChannel };
}

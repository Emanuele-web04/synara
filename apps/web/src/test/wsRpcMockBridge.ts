import {
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  WS_CHANNELS,
  WS_METHODS,
} from "@t3tools/contracts";

// Browser tests mock the WebSocket via msw's `ws.link`, but the production
// transport speaks the Effect (effect-smol) raw RPC protocol over `layerJson`.
// This bridge keeps browser fixtures at the RPC method/channel level while
// emitting only Effect RPC frames over the mocked socket:
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
  WS_METHODS.subscribeProjectDevServerEvents,
  WS_METHODS.subscribeAutomationEvents,
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
  if (channel === WS_CHANNELS.projectDevServerEvent) {
    return WS_METHODS.subscribeProjectDevServerEvents;
  }
  if (channel === WS_CHANNELS.automationEvent) return WS_METHODS.subscribeAutomationEvents;
  if (channel === WS_CHANNELS.gitActionProgress) return WS_METHODS.gitRunStackedAction;
  if (channel === ORCHESTRATION_WS_CHANNELS.domainEvent) {
    return WS_METHODS.subscribeOrchestrationDomainEvents;
  }
  if (channel === ORCHESTRATION_WS_CHANNELS.shellEvent)
    return ORCHESTRATION_WS_METHODS.subscribeShell;
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

type MockClient = {
  send(data: string): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
};

export interface RpcBridgeHandlers {
  // Resolve an effect (non-stream) RPC call to its result value.
  readonly resolveRpc: (tag: string, payload: unknown) => unknown;
  // Called when a stream subscription opens. `emit` pushes a stream-item value
  // as a Chunk on that subscription's request id. Return value is ignored.
  readonly onStreamOpen?: (tag: string, payload: unknown, emit: (value: unknown) => void) => void;
}

export interface RpcBridge {
  // Push a server-initiated event on a channel; routed to the matching open
  // stream as a Chunk. No-op if that stream is not currently subscribed.
  pushToChannel(channel: string, data: unknown): void;
}

function onKnownEffectRpcBrowserHarnessRejection(event: PromiseRejectionEvent): void {
  if (String(event.reason).includes("Fiber.runLoop: Not a valid effect")) {
    event.preventDefault();
  }
}

export function suppressKnownEffectRpcBrowserHarnessRejections(): () => void {
  window.addEventListener("unhandledrejection", onKnownEffectRpcBrowserHarnessRejection);
  return () =>
    window.removeEventListener("unhandledrejection", onKnownEffectRpcBrowserHarnessRejection);
}

// Wires the request decoder and returns a bridge for direct channel pushes.
export function installRpcBridge(client: MockClient, handlers: RpcBridgeHandlers): RpcBridge {
  // requestId by stream tag (single-instance streams).
  const streamRequestIdByTag = new Map<string, string>();
  // requestId by threadId for per-thread subscriptions.
  const threadStreamRequestIdByThreadId = new Map<string, string>();

  const sendToClient = client.send.bind(client);

  const sendChunk = (requestId: string, value: unknown): void => {
    sendToClient(JSON.stringify({ _tag: "Chunk", requestId, values: [value] }));
  };

  const sendExit = (requestId: string, value: unknown): void => {
    sendToClient(
      JSON.stringify({
        _tag: "Exit",
        requestId,
        exit: { _tag: "Success", value },
      }),
    );
  };

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
      sendToClient(JSON.stringify({ _tag: "Pong" }));
      return;
    }
    if (
      tagged._tag === "Ack" ||
      tagged._tag === "Pong" ||
      tagged._tag === "Interrupt" ||
      tagged._tag === "Eof"
    ) {
      const requestId = (decoded as { requestId?: unknown }).requestId;
      if ((tagged._tag === "Interrupt" || tagged._tag === "Eof") && typeof requestId === "string") {
        for (const [tag, streamRequestId] of streamRequestIdByTag) {
          if (streamRequestId === requestId) {
            streamRequestIdByTag.delete(tag);
          }
        }
        for (const [threadId, streamRequestId] of threadStreamRequestIdByThreadId) {
          if (streamRequestId === requestId) {
            threadStreamRequestIdByThreadId.delete(threadId);
          }
        }
      }
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

  return {
    pushToChannel,
  };
}

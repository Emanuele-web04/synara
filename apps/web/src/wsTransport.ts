import {
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  WS_CHANNELS,
  WS_METHODS,
  WsRpcGroup,
  type GitActionProgressEvent,
  type GitRunStackedActionResult,
  type OrchestrationEvent,
  type OrchestrationShellStreamItem,
  type OrchestrationThreadStreamItem,
  type ServerConfigStreamEvent,
  type ServerLifecycleStreamEvent,
  type ServerProviderStatusesUpdatedPayload,
  type ServerSettingsUpdatedPayload,
  type TerminalEvent,
  type WsPush,
  type WsPushChannel,
  type WsPushMessage,
} from "@t3tools/contracts";
import { Cause, Data, Effect, Exit, Layer, ManagedRuntime, Scope, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

type PushListener<C extends WsPushChannel> = (message: WsPushMessage<C>) => void;

type RpcClientEffect = typeof makeRpcClient;
type RpcClientInstance =
  RpcClientEffect extends Effect.Effect<infer Client, any, any> ? Client : never;

type TransportState = "connecting" | "open" | "closed" | "disposed";

class WsTransportRpcError extends Data.TaggedError("WsTransportRpcError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const makeRpcClient = RpcClient.make(WsRpcGroup);

function resolveRpcUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.pathname = "/ws";
  return url.toString();
}

function makeSocketUrl(explicitUrl: string | null): string {
  if (explicitUrl) return resolveRpcUrl(explicitUrl);
  const bridgeUrl = window.desktopBridge?.getWsUrl();
  const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const rawUrl =
    bridgeUrl && bridgeUrl.length > 0
      ? bridgeUrl
      : envUrl && envUrl.length > 0
        ? envUrl
        : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:${window.location.port}`;
  return resolveRpcUrl(rawUrl);
}

function makeProtocolLayer(url: string) {
  const socketLayer = Socket.layerWebSocket(url).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );
  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)),
  );
}

function causeToError(cause: Cause.Cause<unknown>): Error {
  const error = Cause.squash(cause);
  return error instanceof Error ? error : new Error(String(error));
}

export class WsTransport {
  private readonly explicitUrl: string | null;
  private readonly listeners = new Map<string, Set<(message: WsPush) => void>>();
  private readonly latestPushByChannel = new Map<string, WsPush>();
  private sequence = 0;
  private state: TransportState = "connecting";
  private disposed = false;
  private runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
  private clientScope: Scope.Closeable;
  private clientPromise: Promise<RpcClientInstance>;
  private readonly streamCleanups = new Map<string, () => void>();

  constructor(url?: string) {
    this.explicitUrl = url ?? null;
    const session = this.createSession();
    this.runtime = session.runtime;
    this.clientScope = session.clientScope;
    this.clientPromise = session.clientPromise;
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    _options?: { readonly timeoutMs?: number | null },
  ): Promise<T> {
    if (this.disposed) throw new Error("Transport disposed");
    const client = await this.clientPromise;

    if (method === WS_METHODS.gitRunStackedAction) {
      return (await this.runGitActionStream(client, params)) as T;
    }

    if (method === ORCHESTRATION_WS_METHODS.subscribeShell) {
      this.startShellStream(client);
      return undefined as T;
    }
    if (method === ORCHESTRATION_WS_METHODS.unsubscribeShell) {
      this.stopStream("orchestration.shell");
      return undefined as T;
    }
    if (method === ORCHESTRATION_WS_METHODS.subscribeThread) {
      const threadId = (params as { threadId: string }).threadId;
      this.startThreadStream(client, threadId, params as never);
      return undefined as T;
    }
    if (method === ORCHESTRATION_WS_METHODS.unsubscribeThread) {
      const threadId = (params as { threadId: string }).threadId;
      this.stopStream(`orchestration.thread:${threadId}`);
      return undefined as T;
    }

    const rpcInput =
      method === ORCHESTRATION_WS_METHODS.dispatchCommand
        ? (params as { command: unknown }).command
        : (params ?? {});
    const call = (
      client as unknown as Record<
        string,
        (input: unknown) => Effect.Effect<unknown, WsTransportRpcError, never>
      >
    )[method];
    if (!call) throw new WsTransportRpcError({ message: `Unknown RPC method: ${method}` });
    return (await this.runtime.runPromise(call(rpcInput))) as T;
  }

  subscribe<C extends WsPushChannel>(
    channel: C,
    listener: PushListener<C>,
    options?: { readonly replayLatest?: boolean },
  ): () => void {
    let channelListeners = this.listeners.get(channel);
    if (!channelListeners) {
      channelListeners = new Set<(message: WsPush) => void>();
      this.listeners.set(channel, channelListeners);
      this.startChannelStream(channel);
    }

    const wrappedListener = (message: WsPush) => listener(message as WsPushMessage<C>);
    channelListeners.add(wrappedListener);

    if (options?.replayLatest) {
      const latest = this.latestPushByChannel.get(channel);
      if (latest) wrappedListener(latest);
    }

    return () => {
      channelListeners?.delete(wrappedListener);
      if (channelListeners?.size === 0) {
        this.listeners.delete(channel);
        this.stopChannelStream(channel);
      }
    };
  }

  getLatestPush<C extends WsPushChannel>(channel: C): WsPushMessage<C> | null {
    const latest = this.latestPushByChannel.get(channel);
    return latest ? (latest as WsPushMessage<C>) : null;
  }

  getState(): TransportState {
    return this.state;
  }

  dispose() {
    this.disposed = true;
    this.state = "disposed";
    for (const cleanup of this.streamCleanups.values()) cleanup();
    this.streamCleanups.clear();
    void this.runtime.runPromise(Scope.close(this.clientScope, Exit.void)).finally(() => {
      this.runtime.dispose();
    });
  }

  private createSession() {
    const runtime = ManagedRuntime.make(makeProtocolLayer(makeSocketUrl(this.explicitUrl)));
    const clientScope = runtime.runSync(Scope.make());
    const clientPromise = runtime
      .runPromise(Scope.provide(clientScope)(makeRpcClient))
      .then((client) => {
        this.state = "open";
        return client;
      })
      .catch((error) => {
        this.state = "closed";
        throw error;
      });
    return { runtime, clientScope, clientPromise };
  }

  private emit<C extends WsPushChannel>(channel: C, data: WsPushMessage<C>["data"]): void {
    const message = {
      type: "push" as const,
      sequence: ++this.sequence,
      channel,
      data,
    } as WsPush;
    this.latestPushByChannel.set(channel, message);
    const listeners = this.listeners.get(channel);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(message);
      } catch {
        // Listener errors must not break transport streams.
      }
    }
  }

  private startChannelStream(channel: WsPushChannel): void {
    void this.clientPromise.then((client) => {
      if (channel === WS_CHANNELS.serverWelcome) {
        this.startStream(
          "server.lifecycle",
          client[WS_METHODS.subscribeServerLifecycle]({}),
          (event: ServerLifecycleStreamEvent) => {
            if (event.type === "welcome") this.emit(WS_CHANNELS.serverWelcome, event.payload);
          },
        );
      } else if (channel === WS_CHANNELS.serverConfigUpdated) {
        this.startStream(
          "server.config",
          client[WS_METHODS.subscribeServerConfig]({}),
          (event: ServerConfigStreamEvent) => {
            if (event.type === "snapshot") {
              this.emit(WS_CHANNELS.serverConfigUpdated, {
                issues: event.config.issues,
                providers: event.config.providers,
              });
            } else if (event.type === "configUpdated") {
              this.emit(WS_CHANNELS.serverConfigUpdated, event.payload);
            }
          },
        );
      } else if (channel === WS_CHANNELS.serverProviderStatusesUpdated) {
        this.startStream(
          "server.providers",
          client[WS_METHODS.subscribeServerProviderStatuses]({}),
          (payload: ServerProviderStatusesUpdatedPayload) =>
            this.emit(WS_CHANNELS.serverProviderStatusesUpdated, payload),
        );
      } else if (channel === WS_CHANNELS.serverSettingsUpdated) {
        this.startStream(
          "server.settings",
          client[WS_METHODS.subscribeServerSettings]({}),
          (payload: ServerSettingsUpdatedPayload) =>
            this.emit(WS_CHANNELS.serverSettingsUpdated, payload),
        );
      } else if (channel === WS_CHANNELS.terminalEvent) {
        this.startStream(
          "terminal.events",
          client[WS_METHODS.subscribeTerminalEvents]({}),
          (event: TerminalEvent) => this.emit(WS_CHANNELS.terminalEvent, event),
        );
      } else if (channel === ORCHESTRATION_WS_CHANNELS.domainEvent) {
        this.startStream(
          "orchestration.domain",
          client[WS_METHODS.subscribeOrchestrationDomainEvents]({}),
          (event: OrchestrationEvent) => this.emit(ORCHESTRATION_WS_CHANNELS.domainEvent, event),
        );
      }
    });
  }

  private stopChannelStream(channel: WsPushChannel): void {
    if (channel === WS_CHANNELS.serverWelcome) this.stopStream("server.lifecycle");
    else if (channel === WS_CHANNELS.serverConfigUpdated) this.stopStream("server.config");
    else if (channel === WS_CHANNELS.serverProviderStatusesUpdated)
      this.stopStream("server.providers");
    else if (channel === WS_CHANNELS.serverSettingsUpdated) this.stopStream("server.settings");
    else if (channel === WS_CHANNELS.terminalEvent) this.stopStream("terminal.events");
    else if (channel === ORCHESTRATION_WS_CHANNELS.domainEvent)
      this.stopStream("orchestration.domain");
  }

  private startShellStream(client: RpcClientInstance): void {
    this.startStream(
      "orchestration.shell",
      client[ORCHESTRATION_WS_METHODS.subscribeShell]({}),
      (event: OrchestrationShellStreamItem) =>
        this.emit(ORCHESTRATION_WS_CHANNELS.shellEvent, event),
    );
  }

  private startThreadStream(client: RpcClientInstance, threadId: string, input: unknown): void {
    this.startStream(
      `orchestration.thread:${threadId}`,
      client[ORCHESTRATION_WS_METHODS.subscribeThread](input as never),
      (event: OrchestrationThreadStreamItem) =>
        this.emit(ORCHESTRATION_WS_CHANNELS.threadEvent, event),
    );
  }

  private startStream<T>(key: string, stream: unknown, listener: (event: T) => void): void {
    if (this.streamCleanups.has(key)) return;
    const runnableStream = stream as Stream.Stream<T, WsTransportRpcError, never>;
    const cancel = this.runtime.runCallback(
      Stream.runForEach(runnableStream, (event) => Effect.sync(() => listener(event))),
      {
        onExit: (exit) => {
          this.streamCleanups.delete(key);
          if (Exit.isFailure(exit) && !this.disposed) {
            console.warn("WebSocket RPC stream failed", causeToError(exit.cause));
          }
        },
      },
    );
    this.streamCleanups.set(key, cancel);
  }

  private stopStream(key: string): void {
    const cleanup = this.streamCleanups.get(key);
    if (!cleanup) return;
    this.streamCleanups.delete(key);
    cleanup();
  }

  private async runGitActionStream(
    client: RpcClientInstance,
    params: unknown,
  ): Promise<GitRunStackedActionResult> {
    let result: GitRunStackedActionResult | null = null;
    await this.runtime.runPromise(
      Stream.runForEach(client[WS_METHODS.gitRunStackedAction](params as never), (event) =>
        Effect.sync(() => {
          this.emit(WS_CHANNELS.gitActionProgress, event as GitActionProgressEvent);
          if ((event as GitActionProgressEvent).kind === "action_finished") {
            result = (event as Extract<GitActionProgressEvent, { kind: "action_finished" }>).result;
          }
        }),
      ),
    );
    if (!result) throw new Error("Git action stream completed without a final result.");
    return result;
  }
}

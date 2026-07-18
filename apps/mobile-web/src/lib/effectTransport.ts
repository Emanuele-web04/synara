import { CompanionRpcGroup } from "@synara/contracts";
import type {
  CompanionRequestInput,
  CompanionRequestMethod,
  CompanionRequestOutput,
  CompanionStreamInput,
  CompanionStreamItem,
  CompanionStreamMethod,
  CompanionTransport,
  CompanionTransportFactory,
  CompanionTransportSubscription,
} from "@synara/client";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Scope, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

const makeRpcClient = RpcClient.make(CompanionRpcGroup);
type RpcClientEffect = typeof makeRpcClient;
type RpcClientInstance = RpcClientEffect extends Effect.Effect<infer Client, any, any>
  ? Client
  : never;

function toError(cause: Cause.Cause<unknown>): Error {
  const error = Cause.squash(cause);
  return error instanceof Error ? error : new Error(String(error));
}

function protocolLayer(
  url: string,
  protocols: readonly string[],
  onSocket: (socket: WebSocket) => void,
) {
  const constructor = Layer.succeed(Socket.WebSocketConstructor)(
    (socketUrl, socketProtocols) => {
      const socket = new WebSocket(socketUrl, socketProtocols);
      onSocket(socket);
      return socket;
    },
  );
  const socket = Socket.layerWebSocket(url, {
    protocols: [...protocols],
    openTimeout: 10_000,
  }).pipe(Layer.provide(constructor));
  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Layer.mergeAll(socket, RpcSerialization.layerJson)),
  );
}

export const effectCompanionTransportFactory: CompanionTransportFactory = {
  async connect({ url, protocols, signal }) {
    if (signal.aborted) throw signal.reason;
    let websocket: WebSocket | null = null;
    let resolveClosed: (value: { code?: number; reason?: string; clean: boolean }) => void =
      () => undefined;
    const closed = new Promise<{ code?: number; reason?: string; clean: boolean }>((resolve) => {
      resolveClosed = resolve;
    });
    const runtime = ManagedRuntime.make(
      protocolLayer(url, protocols, (socket) => {
        websocket = socket;
        socket.addEventListener(
          "close",
          (event) =>
            resolveClosed({
              code: event.code,
              ...(event.reason ? { reason: event.reason } : {}),
              clean: event.wasClean,
            }),
          { once: true },
        );
      }),
    );
    const scope = runtime.runSync(Scope.make());
    let client: RpcClientInstance;
    try {
      client = await runtime.runPromise(Scope.provide(scope)(makeRpcClient));
    } catch (error) {
      await runtime.runPromise(Scope.close(scope, Exit.void)).catch(() => undefined);
      await runtime.dispose().catch(() => undefined);
      throw error;
    }

    let disposed = false;
    const close = async (reason?: string) => {
      if (disposed) return;
      disposed = true;
      signal.removeEventListener("abort", abort);
      if (websocket && websocket.readyState < WebSocket.CLOSING) websocket.close(1000, reason);
      await runtime.runPromise(Scope.close(scope, Exit.void)).catch(() => undefined);
      await runtime.dispose().catch(() => undefined);
      resolveClosed({ ...(reason ? { reason } : {}), clean: true });
    };
    function abort() {
      void close("connection-aborted");
    }
    signal.addEventListener("abort", abort, { once: true });

    const transport: CompanionTransport = {
      closed,
      async request<Method extends CompanionRequestMethod>(
        method: Method,
        input: CompanionRequestInput<Method>,
        options?: { readonly signal?: AbortSignal },
      ): Promise<CompanionRequestOutput<Method>> {
        if (disposed) throw new Error("The Companion transport is closed.");
        if (options?.signal?.aborted) throw options.signal.reason;
        const call = (client as unknown as Record<string, (value: unknown) => unknown>)[method];
        if (!call) throw new Error(`Unsupported Companion RPC method: ${method}`);
        const effect = call(input) as Effect.Effect<CompanionRequestOutput<Method>, unknown, never>;
        const bounded = Effect.timeoutOrElse(effect, {
          duration: 60_000,
          onTimeout: () => Effect.fail(new Error(`Companion request timed out: ${method}`)),
        });
        return runtime.runPromise(bounded);
      },
      async subscribe<Method extends CompanionStreamMethod>(
        method: Method,
        input: CompanionStreamInput<Method>,
        handlers: {
          readonly onItem: (item: CompanionStreamItem<Method>) => void;
          readonly onError: (error: unknown) => void;
        },
        options?: { readonly signal?: AbortSignal },
      ): Promise<CompanionTransportSubscription> {
        if (disposed) throw new Error("The Companion transport is closed.");
        if (options?.signal?.aborted) throw options.signal.reason;
        const call = (client as unknown as Record<string, (value: unknown) => unknown>)[method];
        if (!call) throw new Error(`Unsupported Companion stream method: ${method}`);
        const stream = call(input) as Stream.Stream<CompanionStreamItem<Method>, unknown, never>;
        let active = true;
        const cancel = runtime.runCallback(
          Stream.runForEach(stream, (item) => Effect.sync(() => handlers.onItem(item))),
          {
            onExit: (exit) => {
              if (active && Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
                handlers.onError(toError(exit.cause));
              }
            },
          },
        );
        return {
          close: async () => {
            if (!active) return;
            active = false;
            cancel();
          },
        };
      },
      close,
    };
    return transport;
  },
};

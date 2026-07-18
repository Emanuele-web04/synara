import type {
  AuthWebSocketTokenResult,
  CompanionHello,
  CompanionShellStreamItem,
} from "@synara/contracts";
import { COMPANION_RPC_METHODS } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import { CompanionClientError, createCompanionConnection } from "./connection";
import type {
  CompanionRequestInput,
  CompanionRequestMethod,
  CompanionRequestOutput,
  CompanionStreamHandlers,
  CompanionStreamInput,
  CompanionStreamItem,
  CompanionStreamMethod,
  CompanionTransport,
  CompanionTransportClose,
  CompanionTransportConnectOptions,
  CompanionTransportFactory,
  CompanionTransportSubscription,
} from "./transport";

const hello = {
  protocolVersion: 1,
  serverVersion: "0.5.5",
  capabilities: ["threads.read"],
  session: {
    id: "session-1",
    deviceLabel: "Test phone",
    accessProfile: "companion",
    expiresAt: "2026-08-17T00:00:00.000Z",
  },
} as unknown as CompanionHello;

class FakeTransport implements CompanionTransport {
  private resolveClosed!: (close: CompanionTransportClose) => void;
  readonly closed = new Promise<CompanionTransportClose>((resolve) => {
    this.resolveClosed = resolve;
  });
  readonly streams = new Map<CompanionStreamMethod, CompanionStreamHandlers<unknown>>();

  async request<Method extends CompanionRequestMethod>(
    method: Method,
    _input: CompanionRequestInput<Method>,
  ): Promise<CompanionRequestOutput<Method>> {
    if (method === COMPANION_RPC_METHODS.hello) {
      return hello as CompanionRequestOutput<Method>;
    }
    throw new Error(`Unexpected request: ${method}`);
  }

  async subscribe<Method extends CompanionStreamMethod>(
    method: Method,
    _input: CompanionStreamInput<Method>,
    handlers: CompanionStreamHandlers<CompanionStreamItem<Method>>,
  ): Promise<CompanionTransportSubscription> {
    this.streams.set(method, handlers as CompanionStreamHandlers<unknown>);
    return {
      close: async () => {
        this.streams.delete(method);
      },
    };
  }

  async close(reason?: string): Promise<void> {
    this.resolveClosed({ clean: true, ...(reason === undefined ? {} : { reason }) });
  }

  emit<Method extends CompanionStreamMethod>(
    method: Method,
    item: CompanionStreamItem<Method>,
  ): void {
    this.streams.get(method)?.onItem(item);
  }
}

describe("CompanionConnection", () => {
  it("refreshes credentials and restores subscriptions after reconnect", async () => {
    const transports = [new FakeTransport(), new FakeTransport()];
    const connections: CompanionTransportConnectOptions[] = [];
    const factory: CompanionTransportFactory = {
      connect: async (options) => {
        connections.push(options);
        const transport = transports[connections.length - 1];
        if (transport === undefined) throw new Error("No fake transport available");
        return transport;
      },
    };
    const tokenProvider = {
      issueWebSocketToken: vi.fn(async () =>
        ({
          token: `token-${connections.length + 1}`,
          expiresAt: "2026-07-18T00:05:00.000Z",
        }) as unknown as AuthWebSocketTokenResult,
      ),
    };
    const received: CompanionShellStreamItem[] = [];
    const connection = createCompanionConnection({
      baseUrl: "https://synara.example/mobile/",
      client: { name: "test", version: "1.0.0", platform: "web" },
      tokenProvider,
      transportFactory: factory,
      scheduler: { sleep: async () => undefined, random: () => 0.5 },
    });
    connection.subscribe(
      COMPANION_RPC_METHODS.subscribeShell,
      {},
      { onItem: (item) => received.push(item), onError: () => undefined },
    );

    connection.start();
    await connection.waitUntilReady();
    expect(transports[0]?.streams.has(COMPANION_RPC_METHODS.subscribeShell)).toBe(true);
    expect(connections[0]?.url).toBe("wss://synara.example/api/companion/v1/ws");
    expect(connections[0]?.protocols).toEqual([
      "synara.companion.v1",
      "synara.auth.token-1",
    ]);

    await transports[0]?.close("network-lost");
    await vi.waitFor(() => expect(connections).toHaveLength(2));
    await vi.waitFor(() => expect(connection.state.status).toBe("ready"));

    expect(tokenProvider.issueWebSocketToken).toHaveBeenCalledTimes(2);
    expect(transports[1]?.streams.has(COMPANION_RPC_METHODS.subscribeShell)).toBe(true);
    await connection.stop();
  });

  it("does not queue commands while disconnected", async () => {
    const connection = createCompanionConnection({
      baseUrl: "https://synara.example",
      client: { name: "test", version: "1.0.0", platform: "web" },
      tokenProvider: {
        issueWebSocketToken: async () => {
          throw new Error("not used");
        },
      },
      transportFactory: { connect: async () => new FakeTransport() },
    });

    const error = await connection
      .request(COMPANION_RPC_METHODS.listProjects, {})
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(CompanionClientError);
    expect((error as CompanionClientError).code).toBe("HostUnavailable");
  });

  it("settles readiness waiters when explicitly stopped before ready", async () => {
    const connection = createCompanionConnection({
      baseUrl: "https://synara.example",
      client: { name: "test", version: "1.0.0", platform: "web" },
      tokenProvider: {
        issueWebSocketToken: (options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
              once: true,
            });
          }),
      },
      transportFactory: { connect: async () => new FakeTransport() },
    });

    connection.start();
    const ready = connection.waitUntilReady().catch((cause: unknown) => cause);
    await connection.stop();
    const error = await ready;
    expect(error).toBeInstanceOf(CompanionClientError);
    expect((error as CompanionClientError).code).toBe("Stopped");
  });
});

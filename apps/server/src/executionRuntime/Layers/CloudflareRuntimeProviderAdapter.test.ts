import * as NodeServices from "@effect/platform-node/NodeServices";
import { ExecutionInstanceId } from "@t3tools/contracts";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  CodexAppServerManager,
  type CodexTransportFactoryInput,
} from "../../codexAppServerManager.ts";
import type { JsonRpcLineTransport } from "../../provider/process/JsonRpcLineTransport.ts";
import { CloudflareBridgeClient } from "../Services/CloudflareBridgeClient.ts";
import { CloudflareRuntimeProviderAdapter } from "../Services/CloudflareRuntimeProviderAdapter.ts";
import { CloudflareBridgeClientLive } from "./CloudflareBridgeClient.ts";
import { CloudflareRuntimeProviderAdapterLive } from "./CloudflareRuntimeProviderAdapter.ts";
import {
  makeFakeCloudflareBridge,
  type FakeBridgeController,
} from "./cloudflareBridgeTestSupport.ts";
import { CLOUDFLARE_RUNTIME_DESCRIPTOR } from "./cloudflareDescriptor.ts";

const makeRuntime = () => {
  const { layer: connectionLayer, controller } = makeFakeCloudflareBridge();
  const layer = CloudflareRuntimeProviderAdapterLive.pipe(
    Layer.provideMerge(CloudflareBridgeClientLive),
    Layer.provideMerge(connectionLayer),
  );
  return { runtime: ManagedRuntime.make(layer), controller };
};

type AdapterRuntime = ReturnType<typeof makeRuntime>["runtime"];

const provision = (runtime: AdapterRuntime) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const adapter = yield* CloudflareRuntimeProviderAdapter;
      return yield* adapter.provision({ threadId: "thread-cf" });
    }),
  );

const collectFirstInbound = (
  runtime: AdapterRuntime,
  inbound: JsonRpcLineTransport["inbound"],
): Promise<string> =>
  runtime.runPromise(
    Stream.runHead(inbound).pipe(
      Effect.map((option) => (option._tag === "Some" ? option.value : "")),
    ),
  );

describe("CloudflareRuntimeProviderAdapter contract (fake bridge)", () => {
  let runtime: AdapterRuntime | undefined;
  let controller: FakeBridgeController | undefined;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
      runtime = undefined;
      controller = undefined;
    }
  });

  it("declares the cloudflare descriptor for remote-runtime with terminal + exec", async () => {
    const made = makeRuntime();
    runtime = made.runtime;
    const descriptor = await runtime.runPromise(
      Effect.gen(function* () {
        const adapter = yield* CloudflareRuntimeProviderAdapter;
        return adapter.descriptor;
      }),
    );
    expect(descriptor).toBe(CLOUDFLARE_RUNTIME_DESCRIPTOR);
    expect(descriptor.provider).toBe("cloudflare");
    expect(descriptor.targetKinds).toEqual(["remote-runtime"]);
    expect(descriptor.capabilities.exec.pty).toBe(true);
    expect(descriptor.capabilities.exec.command).toBe(true);
  });

  it("provisions an instance over the bridge and reports a workspace root", async () => {
    const made = makeRuntime();
    runtime = made.runtime;
    const context = await provision(runtime);
    expect(context.instance.provider).toBe("cloudflare");
    expect(context.instance.status).toBe("running");
    expect(context.rootPath).toBe("/workspace");
    expect(context.instance.id.startsWith("cf-fake-")).toBe(true);
  });

  it("runs a Codex session over the terminal WebSocket transport", async () => {
    const made = makeRuntime();
    runtime = made.runtime;
    controller = made.controller;
    const localRuntime = runtime;
    const context = await provision(localRuntime);

    const transport = await localRuntime.runPromise(
      Effect.gen(function* () {
        const adapter = yield* CloudflareRuntimeProviderAdapter;
        return yield* adapter.createTransport(context.instance.id, {
          command: "",
          args: [],
          cwd: "/workspace",
          env: {},
        });
      }),
    );

    const terminal = controller.lastTerminal();
    expect(terminal).toBeDefined();

    // Drive Codex over the bridge terminal transport; the manager's outbound
    // frames arrive as stdin frames on the fake socket and our responder answers
    // by emitting `data` frames, proving the session is transport-agnostic.
    const events: unknown[] = [];
    const responders: Record<string, () => unknown> = {
      initialize: () => ({ userAgent: "codex-test" }),
      "model/list": () => ({ items: [] }),
      "account/read": () => ({ account: { type: "apiKey" } }),
      "thread/start": () => ({ thread: { id: "provider_thread_cf" } }),
    };
    const manager = new CodexAppServerManager(undefined, {
      createTransport: async (_input: CodexTransportFactoryInput) => transport,
    });
    manager.on("event", (event) => events.push(event));

    const pumpState = { running: true };
    const pump = (async () => {
      while (pumpState.running) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        const term = controller!.lastTerminal();
        if (term === undefined) {
          continue;
        }
        // Drain stdin frames the manager wrote and respond to JSON-RPC requests.
        for (const raw of term.drainInputs()) {
          let frame: { _tag?: string; data?: string };
          try {
            frame = JSON.parse(raw) as { _tag?: string; data?: string };
          } catch {
            continue;
          }
          if (frame._tag !== "stdin" || frame.data === undefined) {
            continue;
          }
          for (const line of frame.data.split("\n")) {
            if (line.trim().length === 0) {
              continue;
            }
            const message = JSON.parse(line) as {
              method?: string;
              id?: string | number;
            };
            if (message.method !== undefined && message.id !== undefined) {
              const responder = responders[message.method];
              term.emit(
                `${JSON.stringify({ id: message.id, result: responder ? responder() : {} })}\n`,
              );
            }
          }
        }
      }
    })();

    const session = await manager.startSession({
      threadId: ExecutionInstanceId.makeUnsafe("thread-cf") as unknown as never,
      provider: "codex",
      cwd: context.rootPath,
      runtimeMode: "full-access",
    });
    pumpState.running = false;
    await pump.catch(() => {});

    expect(session.status).toBe("ready");
    expect(session.resumeCursor).toEqual({ threadId: "provider_thread_cf" });

    manager.stopAll();
    await localRuntime.runPromise(transport.close).catch(() => {});
  });

  it("runs a fire-and-collect command via execCollect", async () => {
    const made = makeRuntime();
    runtime = made.runtime;
    controller = made.controller;
    const localRuntime = runtime;
    const context = await provision(localRuntime);
    controller.scriptExec("git", { stdout: "On branch main\n", exitCode: 0 });

    const result = await localRuntime.runPromise(
      Effect.gen(function* () {
        const adapter = yield* CloudflareRuntimeProviderAdapter;
        return yield* adapter.execCollect(context.instance.id, {
          command: "git",
          args: ["status"],
        });
      }),
    );
    expect(result.stdout).toContain("main");
    expect(result.code).toBe(0);
  });

  it("reads and writes a file through the bridge client (base64 round-trip)", async () => {
    const made = makeRuntime();
    runtime = made.runtime;
    const localRuntime = runtime;
    const context = await provision(localRuntime);

    const content = new TextEncoder().encode("export const x = 1\n");
    await localRuntime.runPromise(
      Effect.gen(function* () {
        const client = yield* CloudflareBridgeClient;
        yield* client.writeFile({
          instanceId: context.instance.id,
          path: "/workspace/x.ts",
          content,
        });
      }),
    );
    const read = await localRuntime.runPromise(
      Effect.gen(function* () {
        const client = yield* CloudflareBridgeClient;
        return yield* client.readFile({ instanceId: context.instance.id, path: "/workspace/x.ts" });
      }),
    );
    expect(new TextDecoder().decode(read)).toBe("export const x = 1\n");
  });

  it("exposes a port, sets a network policy, and renews activity", async () => {
    const made = makeRuntime();
    runtime = made.runtime;
    const localRuntime = runtime;
    const context = await provision(localRuntime);

    const route = await localRuntime.runPromise(
      Effect.gen(function* () {
        const client = yield* CloudflareBridgeClient;
        return yield* client.exposePort(context.instance.id, { port: 3000, label: "dev" });
      }),
    );
    expect(route.port).toBe(3000);
    expect(route.url).toContain("port-3000");

    await localRuntime.runPromise(
      Effect.gen(function* () {
        const client = yield* CloudflareBridgeClient;
        yield* client.setNetworkPolicy(context.instance.id, {
          defaultEgress: "deny",
          rules: [{ action: "allow", host: "github.com" }],
        });
      }),
    );

    const renew = await localRuntime.runPromise(
      Effect.gen(function* () {
        const client = yield* CloudflareBridgeClient;
        return yield* client.renewActivity(context.instance.id, {
          reason: "turn",
          extendSeconds: 120,
        });
      }),
    );
    expect(renew.remainingSeconds).toBe(120);
    expect(renew.expiresAt).not.toBeNull();
  });

  it("probes liveness and destroys idempotently", async () => {
    const made = makeRuntime();
    runtime = made.runtime;
    const localRuntime = runtime;
    const context = await provision(localRuntime);

    const aliveBefore = await localRuntime.runPromise(
      Effect.gen(function* () {
        const adapter = yield* CloudflareRuntimeProviderAdapter;
        return yield* adapter.isAlive(context.instance.id);
      }),
    );
    expect(aliveBefore).toBe(true);

    await localRuntime.runPromise(
      Effect.gen(function* () {
        const adapter = yield* CloudflareRuntimeProviderAdapter;
        yield* adapter.destroy(context.instance.id);
        // Idempotent: a second destroy is a no-op.
        yield* adapter.destroy(context.instance.id);
      }),
    );

    const aliveAfter = await localRuntime.runPromise(
      Effect.gen(function* () {
        const adapter = yield* CloudflareRuntimeProviderAdapter;
        return yield* adapter.isAlive(context.instance.id);
      }),
    );
    expect(aliveAfter).toBe(false);
  });

  it("forwards terminal output frames to the transport inbound stream", async () => {
    const made = makeRuntime();
    runtime = made.runtime;
    controller = made.controller;
    const localRuntime = runtime;
    const context = await provision(localRuntime);

    const transport = await localRuntime.runPromise(
      Effect.gen(function* () {
        const adapter = yield* CloudflareRuntimeProviderAdapter;
        return yield* adapter.createTransport(context.instance.id, {
          command: "bash",
          args: [],
          cwd: "/workspace",
          env: {},
        });
      }),
    );
    const terminal = controller.lastTerminal();
    expect(terminal).toBeDefined();

    const inboundPromise = collectFirstInbound(localRuntime, transport.inbound);
    terminal!.emit("hello from cloudflare\n");
    const line = await inboundPromise;
    expect(line).toContain("hello from cloudflare");

    await localRuntime.runPromise(transport.close).catch(() => {});
  });
});

const hasRealCredentials =
  typeof process.env.SYNARA_CLOUDFLARE_BRIDGE_URL === "string" &&
  process.env.SYNARA_CLOUDFLARE_BRIDGE_URL.length > 0 &&
  typeof process.env.SYNARA_CLOUDFLARE_BRIDGE_TOKEN === "string" &&
  process.env.SYNARA_CLOUDFLARE_BRIDGE_TOKEN.length > 0;

// The real-bridge path runs only when credentials are present. Without them the
// fake-bridge contract above is the baseline; this guards against accidentally
// requiring network/credentials in CI while still covering the wired layer when
// an operator supplies them.
describe.skipIf(!hasRealCredentials)(
  "CloudflareRuntimeProviderAdapter contract (real bridge)",
  () => {
    it("provisions and destroys a real Cloudflare instance", async () => {
      const { CloudflareBridgeConnectionLive } = await import("./CloudflareBridgeConnection.ts");
      const { FetchHttpClient } = await import("effect/unstable/http");
      const layer = CloudflareRuntimeProviderAdapterLive.pipe(
        Layer.provideMerge(CloudflareBridgeClientLive),
        Layer.provideMerge(CloudflareBridgeConnectionLive),
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provideMerge(NodeServices.layer),
      );
      const runtime = ManagedRuntime.make(layer);
      try {
        const context = await runtime.runPromise(
          Effect.gen(function* () {
            const adapter = yield* CloudflareRuntimeProviderAdapter;
            return yield* adapter.provision({ threadId: "thread-cf-real" });
          }),
        );
        expect(context.instance.provider).toBe("cloudflare");
        await runtime.runPromise(
          Effect.gen(function* () {
            const adapter = yield* CloudflareRuntimeProviderAdapter;
            yield* adapter.destroy(context.instance.id);
          }),
        );
      } finally {
        await runtime.dispose();
      }
    });
  },
);

import { describe, expect, it, vi } from "vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ServiceMap } from "effect";

import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  TurnId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
} from "@synara/contracts";

import { DeviceManager } from "./device/DeviceManager";
import { FakeDeviceBackend } from "./device/FakeDeviceBackend";
import { DeviceService } from "./device/Services/DeviceService";
import { detachThreadDevice } from "./orchestration/Layers/ThreadDeletionReactor";
import {
  makeServerRuntimeServicesLayer,
  makeServerProviderLayer,
  provideThreadDeletionReactorDeviceService,
} from "./serverLayers";
import { ServerConfig } from "./config";
import { ServerSettingsService } from "./serverSettings";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";
import { ProviderRuntimeEventRepository } from "./persistence/Services/ProviderRuntimeEvents";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProviderRuntimeIngestionService } from "./orchestration/Services/ProviderRuntimeIngestion";

const liveDevices = vi.hoisted(() => ({ created: [] as DeviceManager[] }));

// Keep the production graph and memoization intact while isolating all simulator operations.
vi.mock("./device/Layers/DeviceService", async () => {
  const { DeviceManager } = await import("./device/DeviceManager");
  const { FakeDeviceBackend } = await import("./device/FakeDeviceBackend");
  const { DeviceService } = await import("./device/Services/DeviceService");
  const { Effect, Layer } = await import("effect");
  return {
    DeviceServiceLive: Layer.effect(
      DeviceService,
      Effect.gen(function* () {
        const manager = new DeviceManager({
          backend: new FakeDeviceBackend(),
          idleShutdownMs: 20,
          attachDeadlineMs: 0,
        });
        liveDevices.created.push(manager);
        yield* Effect.addFinalizer(() => Effect.promise(() => manager.dispose()));
        return { supported: true, manager };
      }),
    ),
  };
});

class ThreadDeletionDeviceProbe extends ServiceMap.Service<
  ThreadDeletionDeviceProbe,
  { readonly manager: DeviceManager }
>()("test/ThreadDeletionDeviceProbe") {}

describe("thread deletion reactor device-service wiring", () => {
  it("feeds the same DeviceService instance into lifecycle cleanup", async () => {
    const threadId = ThreadId.makeUnsafe("thread-delete-layer-wiring");
    const backend = new FakeDeviceBackend();
    const manager = new DeviceManager({ backend });
    await backend.boot("FAKE-0001");
    await manager.attach(threadId, "FAKE-0001");

    const deviceServiceLayer = Layer.succeed(DeviceService, { supported: true, manager });
    const deletionProbeLayer = Layer.effect(
      ThreadDeletionDeviceProbe,
      Effect.gen(function* () {
        const deviceService = yield* Effect.service(DeviceService);
        yield* detachThreadDevice(threadId);
        return { manager: deviceService.manager };
      }),
    );
    const wiredLayer = provideThreadDeletionReactorDeviceService(
      deletionProbeLayer,
      deviceServiceLayer,
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const probe = yield* ThreadDeletionDeviceProbe;
        const service = yield* Effect.service(DeviceService);
        return { probe, service };
      }).pipe(Effect.provide(wiredLayer)),
    );

    expect(result.probe.manager).toBe(result.service.manager);
    expect((await manager.getThreadState(threadId)).attachedDeviceUdid).toBeNull();
    expect(backend.hasStream("FAKE-0001")).toBe(false);
  });
});

describe("production simulator lifecycle composition", () => {
  it("delivers terminal events to the same device manager the server exposes", async () => {
    const before = liveDevices.created.length;
    const config = ServerConfig.layerTest(process.cwd(), {
      prefix: "synara-device-lifecycle-wiring-",
    }).pipe(Layer.provide(NodeServices.layer));
    const production = Layer.empty.pipe(
      Layer.provideMerge(makeServerRuntimeServicesLayer()),
      Layer.provideMerge(makeServerProviderLayer()),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(config),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(ServerSettingsService.layerTest()),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const events = yield* ProviderRuntimeEventRepository;
        const ingestion = yield* ProviderRuntimeIngestionService;
        const device = yield* DeviceService;
        const threadId = ThreadId.makeUnsafe("device-lifecycle-thread");
        const projectId = ProjectId.makeUnsafe("device-lifecycle-project");
        const turnId = TurnId.makeUnsafe("device-lifecycle-turn");
        const createdAt = new Date().toISOString();
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("device-project-create"),
          projectId,
          title: "Device project",
          workspaceRoot: process.cwd(),
          defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("device-thread-create"),
          threadId,
          projectId,
          title: "Device thread",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("device-session-set"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: turnId,
            updatedAt: createdAt,
            lastError: null,
          },
          createdAt,
        });
        yield* Effect.promise(() =>
          device.manager.withAgentActivity(
            threadId,
            async () => {
              await device.manager.boot("FAKE-0001");
              await device.manager.ensureThreadAttached(threadId, "FAKE-0001");
            },
            { udid: "FAKE-0001", turnId },
          ),
        );
        yield* events.append({
          type: "turn.completed",
          eventId: EventId.makeUnsafe("device-turn-completed"),
          provider: "codex",
          threadId,
          turnId,
          createdAt,
          payload: { state: "completed" },
        });
        yield* ingestion.start;
        yield* ingestion.drain;
        yield* Effect.promise(() =>
          vi.waitFor(async () => {
            expect((await device.manager.getThreadState(threadId)).attachedDeviceUdid).toBeNull();
          }),
        );
        expect(liveDevices.created.slice(before)).toEqual([device.manager]);
      }).pipe(Effect.provide(production), Effect.scoped),
    );
  });
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ExecutionInstanceId,
  ProjectId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionThreadRuntimeRepository } from "../../persistence/Services/ProjectionThreadRuntime.ts";
import type { FakeRuntimeFlavor } from "../Services/FakeRuntimeFlavor.ts";
import { ExecutionRuntimeReconciler } from "../Services/ExecutionRuntimeReconciler.ts";
import { ExecutionRuntimeService } from "../Services/ExecutionRuntimeService.ts";
import { ExecutionRuntimeServiceLive } from "./ExecutionRuntimeService.ts";
import { makeExecutionRuntimeReconcilerLive } from "./ExecutionRuntimeReconciler.ts";
import { FakeRuntimeProviderAdapterLive } from "./FakeRuntimeProviderAdapter.ts";
import { ExecutionRuntimePlanningTestLive } from "./testSupport.ts";

const modelSelection: ModelSelection = { provider: "codex", model: "gpt-5.3-codex" };
const now = "2026-06-03T00:00:00.000Z";

interface ReconcilerOptions {
  readonly instanceTtlMs?: number;
  readonly idleThresholdMs?: number;
}

const makeReconcilerRuntime = (options?: ReconcilerOptions) => {
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  );
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "exec-runtime-reconciler-test",
  }).pipe(Layer.provide(NodeServices.layer));
  const executionRuntimeServiceLayer = ExecutionRuntimeServiceLive.pipe(
    Layer.provide(FakeRuntimeProviderAdapterLive),
    Layer.provide(ExecutionRuntimePlanningTestLive),
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(serverConfigLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
  );
  const reconcilerLayer = makeExecutionRuntimeReconcilerLive({
    ...(options?.instanceTtlMs !== undefined ? { instanceTtlMs: options.instanceTtlMs } : {}),
    ...(options?.idleThresholdMs !== undefined ? { idleThresholdMs: options.idleThresholdMs } : {}),
  }).pipe(Layer.provideMerge(executionRuntimeServiceLayer));
  return ManagedRuntime.make(reconcilerLayer);
};

type ReconcilerRuntime = ReturnType<typeof makeReconcilerRuntime>;

const seedThread = (runtime: ReconcilerRuntime, threadId: ThreadId) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe(`cmd-project-${threadId}`),
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Runtime Project",
        workspaceRoot: "/tmp/runtime-project",
        defaultModelSelection: modelSelection,
        createdAt: now,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe(`cmd-thread-${threadId}`),
        threadId,
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Runtime Thread",
        modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });
    }),
  );

const markRemoteAndProvision = (
  runtime: ReconcilerRuntime,
  threadId: ThreadId,
  flavor: FakeRuntimeFlavor,
) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const service = yield* ExecutionRuntimeService;
      yield* service.markThreadRemote({ threadId, flavor });
      return yield* service.ensureTargetForThread(threadId);
    }),
  );

const readRuntimeStatus = (runtime: ReconcilerRuntime, threadId: ThreadId) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      const option = yield* query.getThreadDetailById(threadId);
      return option._tag === "Some" ? (option.value.runtime?.status ?? null) : null;
    }),
  );

const readInstanceStatus = (runtime: ReconcilerRuntime, instanceId: ExecutionInstanceId) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadRuntimeRepository;
      const instances = yield* repository.listActiveInstances();
      return instances.find((entry) => entry.instanceId === instanceId) ?? null;
    }),
  );

const reconcile = (runtime: ReconcilerRuntime) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const reconciler = yield* ExecutionRuntimeReconciler;
      return yield* reconciler.reconcileOnce();
    }),
  );

describe("ExecutionRuntimeReconciler partial-failure matrix", () => {
  let runtime: ReconcilerRuntime | undefined;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
      runtime = undefined;
    }
  });

  it("marks a DB row lost when the provider has no record of the instance (crash after create / divergence)", async () => {
    runtime = makeReconcilerRuntime();
    const localRuntime = runtime;
    const threadId = ThreadId.makeUnsafe("thread-crash-after-create");
    await seedThread(localRuntime, threadId);

    // Record an instance the fake adapter never provisioned: the DB believes it
    // is running, but `isAlive` reports absent. This is "instance row exists but
    // provider instance is gone" and "server crashed after instance create".
    const orphanInstanceId = ExecutionInstanceId.makeUnsafe("fake-orphan-instance");
    await localRuntime.runPromise(
      Effect.gen(function* () {
        const service = yield* ExecutionRuntimeService;
        yield* service.markThreadRemote({ threadId, flavor: "fake-pty-workspace" });
        const engine = yield* OrchestrationEngineService;
        yield* engine.dispatch({
          type: "thread.runtime.instance.record",
          commandId: CommandId.makeUnsafe(`runtime:${threadId}:instance.record`),
          threadId,
          instanceId: orphanInstanceId,
          provider: "fake",
          status: "running",
          rootPath: "/tmp/runtime-project",
          createdAt: now,
        });
      }),
    );

    expect(await readInstanceStatus(localRuntime, orphanInstanceId)).not.toBeNull();

    const summary = await reconcile(localRuntime);
    expect(summary.examined).toBe(1);
    expect(summary.markedLost).toBe(1);

    // Marked lost: dropped from the active list and reflected in the read-model.
    expect(await readInstanceStatus(localRuntime, orphanInstanceId)).toBeNull();
    expect(await readRuntimeStatus(localRuntime, threadId)).toBe("lost");
  });

  it("marks live instances lost when the provider cannot reconnect after a restart", async () => {
    runtime = makeReconcilerRuntime();
    const localRuntime = runtime;
    const threadId = ThreadId.makeUnsafe("thread-no-reconnect");
    await seedThread(localRuntime, threadId);

    // The ephemeral flavor declares reconnect: false. Even though the adapter is
    // still alive in-process, an instance from a provider that cannot re-attach
    // after a restart is unrecoverable and must be marked lost.
    const target = await markRemoteAndProvision(localRuntime, threadId, "fake-ephemeral-runtime");
    const instanceId = target.instanceId as ExecutionInstanceId;

    const summary = await reconcile(localRuntime);
    expect(summary.markedLost).toBe(1);
    expect(await readRuntimeStatus(localRuntime, threadId)).toBe("lost");
    expect(await readInstanceStatus(localRuntime, instanceId)).toBeNull();
  });

  it("leaves a reconnectable, live, in-policy instance running", async () => {
    runtime = makeReconcilerRuntime();
    const localRuntime = runtime;
    const threadId = ThreadId.makeUnsafe("thread-live-reconnect");
    await seedThread(localRuntime, threadId);

    const target = await markRemoteAndProvision(localRuntime, threadId, "fake-pty-workspace");
    const instanceId = target.instanceId as ExecutionInstanceId;

    const summary = await reconcile(localRuntime);
    expect(summary.markedLost).toBe(0);
    expect(summary.retriedDestroy).toBe(0);
    expect(summary.expired).toBe(0);
    expect(await readRuntimeStatus(localRuntime, threadId)).toBe("running");
    expect(await readInstanceStatus(localRuntime, instanceId)).not.toBeNull();
  });

  it("retries a destroy that never confirmed (destroy timed out)", async () => {
    runtime = makeReconcilerRuntime();
    const localRuntime = runtime;
    const threadId = ThreadId.makeUnsafe("thread-destroy-timeout");
    await seedThread(localRuntime, threadId);

    const target = await markRemoteAndProvision(localRuntime, threadId, "fake-pty-workspace");
    const instanceId = target.instanceId as ExecutionInstanceId;

    // A stop was requested but never confirmed: the instance is stuck `stopping`.
    await localRuntime.runPromise(
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        yield* engine.dispatch({
          type: "thread.runtime.stop",
          commandId: CommandId.makeUnsafe(`runtime:${threadId}:stop`),
          threadId,
          instanceId,
          createdAt: now,
        });
      }),
    );
    expect(await readRuntimeStatus(localRuntime, threadId)).toBe("stopping");

    const summary = await reconcile(localRuntime);
    expect(summary.retriedDestroy).toBe(1);
    expect(await readRuntimeStatus(localRuntime, threadId)).toBe("destroyed");
    expect(await readInstanceStatus(localRuntime, instanceId)).toBeNull();
  });

  it("destroys an instance past its TTL", async () => {
    // The instance's recorded createdAt is real wall-clock time, so the default
    // `Date.now` clock is already past a 1 ms TTL. Idle is set wide so TTL is the
    // path under test.
    runtime = makeReconcilerRuntime({
      instanceTtlMs: 1,
      idleThresholdMs: 24 * 60 * 60 * 1000,
    });
    const localRuntime = runtime;
    const threadId = ThreadId.makeUnsafe("thread-ttl-expiry");
    await seedThread(localRuntime, threadId);

    const target = await markRemoteAndProvision(localRuntime, threadId, "fake-pty-workspace");
    const instanceId = target.instanceId as ExecutionInstanceId;

    const summary = await reconcile(localRuntime);
    expect(summary.expired).toBe(1);
    expect(await readRuntimeStatus(localRuntime, threadId)).toBe("destroyed");
    expect(await readInstanceStatus(localRuntime, instanceId)).toBeNull();
  });

  it("destroys an instance idle past the threshold", async () => {
    // Idle falls back to the instance's recorded updatedAt (real wall-clock) when
    // no activity exists, so a 1 ms idle threshold expires under the default
    // clock. TTL is set wide so idle is the path under test.
    runtime = makeReconcilerRuntime({
      instanceTtlMs: 24 * 60 * 60 * 1000,
      idleThresholdMs: 1,
    });
    const localRuntime = runtime;
    const threadId = ThreadId.makeUnsafe("thread-idle-expiry");
    await seedThread(localRuntime, threadId);

    const target = await markRemoteAndProvision(localRuntime, threadId, "fake-pty-workspace");
    const instanceId = target.instanceId as ExecutionInstanceId;

    const summary = await reconcile(localRuntime);
    expect(summary.expired).toBe(1);
    expect(await readRuntimeStatus(localRuntime, threadId)).toBe("destroyed");
    expect(await readInstanceStatus(localRuntime, instanceId)).toBeNull();
  });

  it("examines nothing when an event was appended but no instance row exists (provision failed)", async () => {
    runtime = makeReconcilerRuntime();
    const localRuntime = runtime;
    const threadId = ThreadId.makeUnsafe("thread-event-no-instance");
    await seedThread(localRuntime, threadId);

    // markThreadRemote appends a provision-requested event (read-model goes to
    // `provisioning`) but never records an instance. No operational row exists,
    // so there is nothing for the reconciler to act on; the thread stays pending
    // a re-driven provision rather than being marked lost off a phantom row.
    await localRuntime.runPromise(
      Effect.gen(function* () {
        const service = yield* ExecutionRuntimeService;
        yield* service.markThreadRemote({ threadId, flavor: "fake-pty-workspace" });
      }),
    );
    expect(await readRuntimeStatus(localRuntime, threadId)).toBe("provisioning");

    const summary = await reconcile(localRuntime);
    expect(summary.examined).toBe(0);
    expect(summary.markedLost).toBe(0);
    expect(await readRuntimeStatus(localRuntime, threadId)).toBe("provisioning");
  });

  it("is idempotent across repeated sweeps", async () => {
    runtime = makeReconcilerRuntime();
    const localRuntime = runtime;
    const threadId = ThreadId.makeUnsafe("thread-idempotent");
    await seedThread(localRuntime, threadId);

    await markRemoteAndProvision(localRuntime, threadId, "fake-ephemeral-runtime");

    const first = await reconcile(localRuntime);
    expect(first.markedLost).toBe(1);
    // Second sweep finds no active instances: the lost instance is excluded.
    const second = await reconcile(localRuntime);
    expect(second.examined).toBe(0);
    expect(second.markedLost).toBe(0);
    expect(await readRuntimeStatus(localRuntime, threadId)).toBe("lost");
  });
});

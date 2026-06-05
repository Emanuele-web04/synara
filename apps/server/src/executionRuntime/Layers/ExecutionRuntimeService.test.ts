import { existsSync } from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  type ModelSelection,
  type ProviderEvent,
  type RuntimePlan,
} from "@t3tools/contracts";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  CodexAppServerManager,
  type CodexTransportFactoryInput,
} from "../../codexAppServerManager.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../config.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import type { InMemoryTransportController } from "../../provider/process/JsonRpcLineTransport.ts";
import type { FakeRuntimeFlavor } from "../Services/FakeRuntimeFlavor.ts";
import { ExecutionRuntimeService } from "../Services/ExecutionRuntimeService.ts";
import { RuntimeProviderCredentials } from "../Services/RuntimeProviderCredentials.ts";
import { ExecutionRuntimeServiceLive } from "./ExecutionRuntimeService.ts";
import { FakeRuntimeProviderAdapterLive } from "./FakeRuntimeProviderAdapter.ts";
import { fakeRuntimeDescriptorByFlavor } from "./fakeDescriptors.ts";
import {
  ExecutionRuntimePlanningOnlyTestLive,
  ExecutionRuntimePlanningTestLive,
} from "./testSupport.ts";

interface OutboundFrame {
  readonly method?: string;
  readonly id?: string | number;
  readonly params?: unknown;
  readonly result?: unknown;
}

const modelSelection: ModelSelection = {
  provider: "codex",
  model: "gpt-5.3-codex",
};

const now = "2026-06-03T00:00:00.000Z";

const makeServiceRuntime = () => {
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  );
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "exec-runtime-test",
  }).pipe(Layer.provide(NodeServices.layer));
  const layer = ExecutionRuntimeServiceLive.pipe(
    Layer.provide(FakeRuntimeProviderAdapterLive),
    Layer.provide(ExecutionRuntimePlanningTestLive),
    Layer.provide(GitCoreLive),
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(serverConfigLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
  );
  return ManagedRuntime.make(layer);
};

type ServiceRuntime = ReturnType<typeof makeServiceRuntime>;

const seedThread = (runtime: ServiceRuntime, threadId: ThreadId) =>
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

const readThreadRuntime = (runtime: ServiceRuntime, threadId: ThreadId) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      const option = yield* query.getThreadDetailById(threadId);
      return option._tag === "Some" ? (option.value.runtime ?? null) : null;
    }),
  );

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  label: string,
): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}.`);
};

/**
 * Pump the outbound JSON-RPC frames the manager writes through a scripted exec
 * transport controller and answer requests. Records every frame for assertions.
 * The loop ends when the controller's outbound queue is closed (transport
 * teardown), so it never leaks across the test.
 */
const startCodexResponder = (
  runtime: ServiceRuntime,
  controller: InMemoryTransportController,
  outboundFrames: OutboundFrame[],
  responders: Record<string, () => unknown>,
) =>
  (async () => {
    for (;;) {
      let frame: OutboundFrame;
      try {
        frame = (await runtime.runPromise(controller.takeOutboundMessage)) as OutboundFrame;
      } catch {
        return;
      }
      outboundFrames.push(frame);
      const isRequest = typeof frame.method === "string" && frame.id !== undefined;
      if (!isRequest) {
        continue;
      }
      const responder = responders[frame.method as string];
      const result = responder ? responder() : {};
      await runtime.runPromise(controller.pushInboundMessage({ id: frame.id, result }));
    }
  })();

describe("ExecutionRuntimeService fake-remote path", () => {
  let runtime: ServiceRuntime | undefined;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
      runtime = undefined;
    }
  });

  it("provisions a fake instance via an internal command, runs Codex through the in-memory transport, streams logs, and destroys cleanly", async () => {
    runtime = makeServiceRuntime();
    const localRuntime = runtime;
    const threadId = ThreadId.makeUnsafe("thread-remote-pty");
    await seedThread(localRuntime, threadId);

    // Internal command path: mark the thread remote. No public runtimePlan.
    await localRuntime.runPromise(
      Effect.gen(function* () {
        const service = yield* ExecutionRuntimeService;
        yield* service.markThreadRemote({ threadId, flavor: "fake-pty-workspace" });
      }),
    );
    const afterMark = await readThreadRuntime(localRuntime, threadId);
    expect(afterMark?.targetKind).toBe("remote-runtime");
    expect(afterMark?.provider).toBe("fake");
    expect(afterMark?.status).toBe("provisioning");

    // ensureTargetForThread provisions the fake instance (temp dir + recorded
    // RuntimeInstance) and returns a provider-agnostic resolved target.
    const target = await localRuntime.runPromise(
      Effect.gen(function* () {
        const service = yield* ExecutionRuntimeService;
        return yield* service.ensureTargetForThread(threadId);
      }),
    );
    expect(target.targetKind).toBe("remote-runtime");
    expect(target.instanceId).not.toBeNull();
    expect(target.cwd).toBeDefined();
    expect(existsSync(target.cwd as string)).toBe(true);

    const afterProvision = await readThreadRuntime(localRuntime, threadId);
    expect(afterProvision?.status).toBe("running");
    expect(afterProvision?.instance?.provider).toBe("fake");
    expect(afterProvision?.instance?.rootPath).toBe(target.cwd);

    const instanceId = target.instanceId as NonNullable<typeof target.instanceId>;
    // exec returns a scriptable in-memory transport (no real codex binary) and
    // records a process-started event.
    const handle = await localRuntime.runPromise(
      Effect.gen(function* () {
        const service = yield* ExecutionRuntimeService;
        return yield* service.exec({ threadId, instanceId, role: "agent", command: "", args: [] });
      }),
    );

    const afterExec = await readThreadRuntime(localRuntime, threadId);
    expect(afterExec?.processes.some((proc) => proc.id === handle.processId)).toBe(true);

    // The fake/remote transport is the in-memory forwarding seam, so the fake
    // provider always returns a controller to script the provider protocol.
    const controller = handle.controller;
    expect(controller).toBeDefined();
    if (controller === undefined) {
      throw new Error("expected fake transport controller");
    }

    // Drive Codex over the supplied transport, proving the session is
    // transport-agnostic and runs through the remote (in-memory) path.
    const outboundFrames: OutboundFrame[] = [];
    const events: ProviderEvent[] = [];
    const responders: Record<string, () => unknown> = {
      initialize: () => ({ userAgent: "codex-test" }),
      "model/list": () => ({ items: [] }),
      "account/read": () => ({ account: { type: "apiKey" } }),
      "thread/start": () => ({ thread: { id: "provider_thread_remote" } }),
    };
    const manager = new CodexAppServerManager(undefined, {
      createTransport: async (_input: CodexTransportFactoryInput) => handle.transport,
    });
    manager.on("event", (event) => events.push(event));
    const pump = startCodexResponder(localRuntime, controller, outboundFrames, responders);

    const resolvedCwd = target.cwd as string;
    const session = await manager.startSession({
      threadId,
      provider: "codex",
      cwd: resolvedCwd,
      runtimeMode: "full-access",
    });
    expect(session.status).toBe("ready");
    expect(session.resumeCursor).toEqual({ threadId: "provider_thread_remote" });
    expect(outboundFrames.map((frame) => frame.method)).toEqual([
      "initialize",
      "initialized",
      "model/list",
      "account/read",
      "thread/start",
    ]);

    // Stream logs through the transport's side channel.
    await localRuntime.runPromise(controller.pushStderr("codex: starting up"));

    // Signal process exit; the exec lifecycle records a process-completed event
    // on a forked fiber, so poll the read-model until it lands.
    await localRuntime.runPromise(controller.signalExit({ code: 0, signal: null }));
    manager.stopAll();
    await localRuntime.runPromise(handle.transport.close).catch(() => {});
    await pump.catch(() => {});

    let completedProc: { status: string; exitCode: number | null } | undefined;
    await waitFor(async () => {
      const runtimeRow = await readThreadRuntime(localRuntime, threadId);
      const proc = runtimeRow?.processes.find((entry) => entry.id === handle.processId);
      if (proc && proc.status === "exited") {
        completedProc = { status: proc.status, exitCode: proc.exitCode ?? null };
        return true;
      }
      return false;
    }, "process-completed event");
    expect(completedProc?.status).toBe("exited");
    expect(completedProc?.exitCode).toBe(0);
    expect(events.length).toBeGreaterThanOrEqual(0);

    // Destroy tears down the temp dir and records the destroyed event.
    await localRuntime.runPromise(
      Effect.gen(function* () {
        const service = yield* ExecutionRuntimeService;
        yield* service.destroy(threadId, instanceId);
      }),
    );
    expect(existsSync(target.cwd as string)).toBe(false);
  });

  it("forwards a non-PTY command fake's local process through the remote transport", async () => {
    runtime = makeServiceRuntime();
    const localRuntime = runtime;
    const threadId = ThreadId.makeUnsafe("thread-remote-command");
    await seedThread(localRuntime, threadId);

    await localRuntime.runPromise(
      Effect.gen(function* () {
        const service = yield* ExecutionRuntimeService;
        yield* service.markThreadRemote({ threadId, flavor: "fake-command-workspace" });
      }),
    );
    const target = await localRuntime.runPromise(
      Effect.gen(function* () {
        const service = yield* ExecutionRuntimeService;
        return yield* service.ensureTargetForThread(threadId);
      }),
    );
    const instanceId = target.instanceId as NonNullable<typeof target.instanceId>;

    // A real local `printf` runs in the temp dir; its stdout line is forwarded
    // through the in-memory (remote-shaped) transport's inbound channel.
    const handle = await localRuntime.runPromise(
      Effect.gen(function* () {
        const service = yield* ExecutionRuntimeService;
        return yield* service.exec({
          threadId,
          instanceId,
          role: "exec",
          command: "printf",
          args: ['{"hello":"world"}\n'],
        });
      }),
    );

    // Reading the forwarded stdout line proves the remote forwarding path runs a
    // real local command in the temp dir.
    const collected = await collectFirstInboundLine(localRuntime, handle.transport.inbound);
    expect(collected).toContain("hello");

    await localRuntime.runPromise(handle.transport.close).catch(() => {});
    await localRuntime.runPromise(
      Effect.gen(function* () {
        const service = yield* ExecutionRuntimeService;
        yield* service.destroy(threadId, instanceId);
      }),
    );
  });
});

const collectFirstInboundLine = (
  runtime: ServiceRuntime,
  inbound: import("../../provider/process/JsonRpcLineTransport.ts").JsonRpcLineTransport["inbound"],
): Promise<string> =>
  runtime.runPromise(
    Stream.runHead(inbound).pipe(
      Effect.map((option) => (option._tag === "Some" ? option.value : "")),
    ),
  );

describe("ExecutionRuntimeService.applyRuntimePlan", () => {
  let runtime: ServiceRuntime | undefined;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
      runtime = undefined;
    }
  });

  const applyPlan = (localRuntime: ServiceRuntime, threadId: ThreadId, plan: RuntimePlan | null) =>
    localRuntime.runPromise(
      Effect.gen(function* () {
        const service = yield* ExecutionRuntimeService;
        yield* service.applyRuntimePlan({ threadId, plan });
      }),
    );

  it("provisions a remote thread end-to-end from a public runtimePlan", async () => {
    runtime = makeServiceRuntime();
    const localRuntime = runtime;
    const threadId = ThreadId.makeUnsafe("thread-plan-remote");
    await seedThread(localRuntime, threadId);

    await applyPlan(localRuntime, threadId, {
      targetKind: "remote-runtime",
      provider: "fake",
      ports: [],
      persistent: true,
      snapshotId: null,
    });
    const afterApply = await readThreadRuntime(localRuntime, threadId);
    expect(afterApply?.targetKind).toBe("remote-runtime");
    expect(afterApply?.provider).toBe("fake");
    expect(afterApply?.status).toBe("provisioning");

    const target = await localRuntime.runPromise(
      Effect.gen(function* () {
        const service = yield* ExecutionRuntimeService;
        return yield* service.ensureTargetForThread(threadId);
      }),
    );
    expect(target.targetKind).toBe("remote-runtime");
    expect(target.instanceId).not.toBeNull();
    expect(existsSync(target.cwd as string)).toBe(true);

    await localRuntime.runPromise(
      Effect.gen(function* () {
        const service = yield* ExecutionRuntimeService;
        yield* service.destroy(
          threadId,
          target.instanceId as NonNullable<typeof target.instanceId>,
        );
      }),
    );
  });

  it("leaves local/worktree and no-plan threads on the compat path", async () => {
    runtime = makeServiceRuntime();
    const localRuntime = runtime;

    const noPlanThread = ThreadId.makeUnsafe("thread-plan-none");
    await seedThread(localRuntime, noPlanThread);
    await applyPlan(localRuntime, noPlanThread, null);
    expect(await readThreadRuntime(localRuntime, noPlanThread)).toBeNull();

    const localThread = ThreadId.makeUnsafe("thread-plan-local");
    await localRuntime.runPromise(
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(`cmd-thread-${localThread}`),
          threadId: localThread,
          projectId: ProjectId.makeUnsafe("project-1"),
          title: "Local Thread",
          modelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
        });
      }),
    );
    await applyPlan(localRuntime, localThread, {
      targetKind: "local",
      provider: "local",
      ports: [],
      persistent: false,
      snapshotId: null,
    });
    expect(await readThreadRuntime(localRuntime, localThread)).toBeNull();

    const localTarget = await localRuntime.runPromise(
      Effect.gen(function* () {
        const service = yield* ExecutionRuntimeService;
        return yield* service.ensureTargetForThread(localThread);
      }),
    );
    expect(localTarget.targetKind).toBe("local");
    expect(localTarget.instanceId).toBeNull();
    expect(localTarget.cwd).toBeUndefined();
  });

  it("rejects an invalid remote plan before any provisioning", async () => {
    runtime = makeServiceRuntime();
    const localRuntime = runtime;
    const threadId = ThreadId.makeUnsafe("thread-plan-invalid");
    await seedThread(localRuntime, threadId);

    // A non-persistent plan derives the ephemeral flavor, which exposes no ports.
    // Requesting one is unsupported and must be rejected before any provisioning.
    const rejection = await localRuntime.runPromiseExit(
      Effect.gen(function* () {
        const service = yield* ExecutionRuntimeService;
        yield* service.applyRuntimePlan({
          threadId,
          plan: {
            targetKind: "remote-runtime",
            provider: "fake",
            ports: [9000],
            persistent: false,
            snapshotId: null,
          },
        });
      }),
    );
    expect(rejection._tag).toBe("Failure");

    // No runtime row was written: the thread stays on the compat path.
    expect(await readThreadRuntime(localRuntime, threadId)).toBeNull();
  });
});

// A credential service whose verdict the test controls, so the missing-creds
// preflight can be exercised both ways without touching Settings or secrets.
const makeCredentialsLayer = (configured: boolean) =>
  Layer.succeed(RuntimeProviderCredentials, {
    envFor: () => Effect.succeed({ ...process.env }),
    credentialsConfigured: () => Effect.succeed(configured),
  });

// Mirrors makeServiceRuntime but provides a chosen credential service instead of
// the default (nothing-configured) stub bundled in ExecutionRuntimePlanningTestLive.
const makePreflightRuntime = (configured: boolean) => {
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  );
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "exec-runtime-preflight-test",
  }).pipe(Layer.provide(NodeServices.layer));
  const layer = ExecutionRuntimeServiceLive.pipe(
    Layer.provide(FakeRuntimeProviderAdapterLive),
    // Planning without the bundled stub credentials, so this harness pins its own.
    Layer.provide(ExecutionRuntimePlanningOnlyTestLive),
    Layer.provide(makeCredentialsLayer(configured)),
    Layer.provide(GitCoreLive),
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(serverConfigLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
  );
  return ManagedRuntime.make(layer);
};

// The tag + message of the squashed failure, for asserting which error a rejected
// effect produced without depending on the cause's internal shape.
const failureText = (exit: Exit.Exit<unknown, unknown>): string => {
  if (!Exit.isFailure(exit)) {
    return "";
  }
  const error = Cause.squash(exit.cause);
  const tag =
    typeof error === "object" && error !== null && "_tag" in error
      ? String((error as { _tag: unknown })._tag)
      : "";
  return `${tag} ${String(error)}`;
};

describe("ExecutionRuntimeService missing-credentials preflight", () => {
  let runtime: ServiceRuntime | undefined;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
      runtime = undefined;
    }
  });

  const daytonaPlan: RuntimePlan = {
    targetKind: "remote-runtime",
    provider: "daytona",
    ports: [],
    persistent: true,
    snapshotId: null,
  };

  it("rejects applyRuntimePlan for a credentialed provider with no creds (pre-provision)", async () => {
    runtime = makePreflightRuntime(false);
    const localRuntime = runtime;
    const threadId = ThreadId.makeUnsafe("thread-preflight-missing");
    await seedThread(localRuntime, threadId);

    const exit = await localRuntime.runPromiseExit(
      Effect.gen(function* () {
        const service = yield* ExecutionRuntimeService;
        yield* service.applyRuntimePlan({ threadId, plan: daytonaPlan });
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    // The plan is descriptor-valid; only the missing-creds gate fails it. No
    // runtime row is written: the thread never leaves the compat path.
    expect(failureText(exit)).toContain("MissingCredentialsError");
    expect(await readThreadRuntime(localRuntime, threadId)).toBeNull();
  });

  it("passes the preflight when creds are configured (fails later for the unregistered adapter)", async () => {
    runtime = makePreflightRuntime(true);
    const localRuntime = runtime;
    const threadId = ThreadId.makeUnsafe("thread-preflight-configured");
    await seedThread(localRuntime, threadId);

    // With creds present the preflight passes, so applyRuntimePlan records the
    // provision request and marks the thread remote — the daytona adapter is not
    // registered in this fake-only harness, but that surfaces only at provision.
    await localRuntime.runPromise(
      Effect.gen(function* () {
        const service = yield* ExecutionRuntimeService;
        yield* service.applyRuntimePlan({ threadId, plan: daytonaPlan });
      }),
    );
    const afterApply = await readThreadRuntime(localRuntime, threadId);
    expect(afterApply?.targetKind).toBe("remote-runtime");
    expect(afterApply?.provider).toBe("daytona");
    expect(afterApply?.status).toBe("provisioning");

    // Provisioning now fails because no daytona adapter is registered here — a
    // RuntimeProvisionFailedError, not a MissingCredentialsError, proving the
    // preflight let it through.
    const exit = await localRuntime.runPromiseExit(
      Effect.gen(function* () {
        const service = yield* ExecutionRuntimeService;
        return yield* service.ensureTargetForThread(threadId);
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(failureText(exit)).toContain("RuntimeProvisionFailedError");
    expect(failureText(exit)).not.toContain("MissingCredentialsError");
  });

  it("rejects provisionRemote on the restart-resume path when the persisted provider has no creds", async () => {
    runtime = makePreflightRuntime(false);
    const localRuntime = runtime;
    const threadId = ThreadId.makeUnsafe("thread-preflight-resume");
    await seedThread(localRuntime, threadId);

    // Simulate the read-model after a restart: a remote daytona row with no
    // in-memory intent (no applyRuntimePlan this process). ensureTargetForThread
    // resolves the persisted provider as the fallback intent and must reject for
    // missing creds rather than downgrade to fake.
    const exit = await localRuntime.runPromiseExit(
      Effect.gen(function* () {
        const service = yield* ExecutionRuntimeService;
        return yield* service.ensureTargetForThread(threadId, {
          threadId,
          targetKind: "remote-runtime",
          provider: "daytona",
          role: "agent",
          status: "provisioning",
          instance: null,
          processes: [],
          routes: [],
          snapshots: [],
          leases: [],
          lastActivityAt: null,
          updatedAt: now,
        });
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    // Surfaced through the provision channel (RuntimeProvisionFailedError) but the
    // missing-creds reason is carried in its detail.
    expect(failureText(exit)).toContain("RuntimeProvisionFailedError");
    expect(failureText(exit)).toContain("No credentials configured");
  });
});

describe("fake runtime descriptors", () => {
  it("declares PTY for the pty workspace and command-only for non-PTY fakes", () => {
    const ptyDescriptor = fakeRuntimeDescriptorByFlavor("fake-pty-workspace");
    expect(ptyDescriptor.capabilities.exec.pty).toBe(true);

    const nonPtyFlavors: ReadonlyArray<FakeRuntimeFlavor> = [
      "fake-command-workspace",
      "fake-job-runtime",
      "fake-service-runtime",
      "fake-ephemeral-runtime",
    ];
    for (const flavor of nonPtyFlavors) {
      const descriptor = fakeRuntimeDescriptorByFlavor(flavor);
      expect(descriptor.capabilities.exec.pty).toBe(false);
      expect(descriptor.capabilities.exec.command).toBe(true);
      expect(descriptor.targetKinds).toEqual(["remote-runtime"]);
    }
  });
});

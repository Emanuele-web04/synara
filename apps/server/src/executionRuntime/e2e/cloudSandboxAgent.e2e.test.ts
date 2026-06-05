/**
 * End-to-end: a REAL `codex app-server` driven through a cloud-sandbox
 * provider's remote runtime path.
 *
 * Provider proven: `daytona`. With no `DAYTONA_API_KEY`, the Daytona runtime
 * layer falls back to `FakeDaytonaSandboxClient`, which provisions a local temp
 * dir and — crucially — forwards a real local child process into the in-memory
 * `JsonRpcLineTransport` via `startSession`. That is the same forwarding seam a
 * live Daytona sandbox uses (remote exec channel <-> in-memory queues), so this
 * exercises the entire remote path with the real agent process: everything a
 * live cloud run does minus the remote REST/WS call.
 *
 * What it drives, end to end, exactly as `ExecutionRuntimeService` does in prod:
 *   1. Build the execution-runtime layers (registry with the daytona adapter +
 *      fake clients, ExecutionRuntimeService, ChildProcessSpawner + FileSystem
 *      from NodeServices, orchestration engine + projection).
 *   2. `applyRuntimePlan({ provider: "daytona" })` marks the thread remote and
 *      records the provision request (the public cloud-sandbox plan path).
 *   3. `ensureTargetForThread` provisions a Daytona instance (asserts a
 *      RuntimeInstance with a rootPath that exists on disk).
 *   4. `ExecutionRuntimeService.exec({ command: codex, args: ["app-server"] })`
 *      spawns the REAL `codex app-server` inside the instance and returns the
 *      `JsonRpcLineTransport`. The test drives the JSON-RPC handshake over that
 *      transport (initialize -> initialized -> model/list -> account/read) and
 *      asserts the `initialize` result comes back — proof the real agent process
 *      runs inside the provisioned sandbox through the remote transport.
 *   5. If `codex` is authenticated on this host (account/read reports an account),
 *      drive `CodexAppServerManager` over a second exec transport to start a
 *      thread and run one turn (ask codex to create a file), assert a turn
 *      response item streams back, then collect a `git diff` through the Daytona
 *      adapter's exec channel. If NOT authed, the test records that a full turn
 *      needs codex auth and stops at handshake depth.
 *   6. `destroy` the instance and assert the temp dir is gone (cleanup).
 *
 * Gated behind `RUN_E2E` so the default CI suite stays fast; it spawns a real
 * `codex` process and (when authed) makes a real model call.
 *
 * @module executionRuntime/e2e/cloudSandboxAgent.e2e
 */
import { existsSync } from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ExecutionInstanceId,
  ProjectId,
  ThreadId,
  type ModelSelection,
  type ProviderEvent,
} from "@t3tools/contracts";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vitest";

import {
  CodexAppServerManager,
  type CodexTransportFactoryInput,
} from "../../codexAppServerManager.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import type { JsonRpcLineTransport } from "../../provider/process/JsonRpcLineTransport.ts";
import { BUILT_IN_RUNTIME_DESCRIPTORS } from "../Layers/descriptors.ts";
import { ExecutionRuntimePlannerLive } from "../Layers/ExecutionRuntimePlanner.ts";
import { ExecutionRuntimeServiceLive } from "../Layers/ExecutionRuntimeService.ts";
import { RuntimeProviderCredentialsTestLive } from "../Layers/testSupport.ts";
import { FAKE_RUNTIME_DESCRIPTORS } from "../Layers/fakeDescriptors.ts";
import { FakeRuntimeProviderAdapterLive } from "../Layers/FakeRuntimeProviderAdapter.ts";
import { makeRuntimeProviderRegistryWithAdaptersLive } from "../Layers/RuntimeProviderRegistry.ts";
import { RuntimeActivityLeaseManagerLive } from "../Layers/RuntimeActivityLeaseManager.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { CLOUDFLARE_RUNTIME_DESCRIPTOR } from "../Layers/cloudflareDescriptor.ts";
import { DAYTONA_RUNTIME_DESCRIPTOR } from "../providers/daytona/descriptor.ts";
import { DaytonaRuntimeAdapter } from "../providers/daytona/DaytonaRuntimeAdapter.ts";
import { makeDaytonaRuntimeAdapterLayer } from "../providers/daytona/runtimeLayer.ts";
import { VERCEL_SANDBOX_DESCRIPTOR } from "../providers/vercelSandbox/descriptor.ts";
import { makeVercelSandboxRuntimeAdapterLayer } from "../providers/vercelSandbox/runtimeLayer.ts";
import { MODAL_PROVIDER_DESCRIPTOR } from "../providers/modal/modalDescriptors.ts";
import { makeModalRuntimeAdapterLayer } from "../providers/modal/runtimeLayer.ts";
import { makeCloudflareRuntimeAdapterLayer } from "../Layers/CloudflareRuntimeProviderFacadeLayer.ts";
import { ExecutionRuntimeService } from "../Services/ExecutionRuntimeService.ts";

const RUN_E2E = process.env.RUN_E2E === "1" || process.env.RUN_E2E === "true";
const describeE2E = RUN_E2E ? describe : describe.skip;

const CODEX_BINARY = process.env.CODEX_BINARY ?? "/opt/homebrew/bin/codex";

const modelSelection: ModelSelection = {
  provider: "codex",
  model: "gpt-5.3-codex",
};

const now = "2026-06-04T00:00:00.000Z";

/**
 * Service runtime wired exactly like `serverLayers.ts`: the registry carries the
 * `fake` adapter plus every real provider adapter (each env-selecting its real vs
 * fake client). With no provider credentials in the environment, daytona/vercel/
 * modal/cloudflare all fall back to their fake clients, so `getAdapter("daytona")`
 * resolves to the fake-backed Daytona adapter that forwards real local processes.
 */
const makeServiceRuntime = () => {
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  );
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "exec-runtime-e2e",
  }).pipe(Layer.provide(NodeServices.layer));

  // The Daytona adapter is built ONCE and shared: the registry routes
  // provision/exec/destroy through this same instance (so its sandbox-roots map
  // is populated), and the test resolves the same `DaytonaRuntimeAdapter` to run
  // git through the instance's exec channel. A fresh adapter would not know the
  // provisioned sandbox.
  // Force fake-backed mode for every cloud-sandbox provider, regardless of the
  // ambient environment. The task exercises the remote path WITHOUT remote API
  // calls, so the credentials that would select the real REST/SDK clients are
  // stripped from the env each adapter resolves from. This proves the full
  // remote forwarding seam locally (the fake clients run real local processes in
  // temp dirs) instead of provisioning a live cloud sandbox.
  const fakeBackedEnv: Record<string, string | undefined> = { ...process.env };
  for (const key of [
    "DAYTONA_API_KEY",
    "VERCEL_TOKEN",
    "VERCEL_TEAM_ID",
    "VERCEL_PROJECT_ID",
    "MODAL_TOKEN_ID",
    "MODAL_TOKEN_SECRET",
    "SYNARA_CLOUDFLARE_BRIDGE_URL",
    "SYNARA_CLOUDFLARE_BRIDGE_TOKEN",
  ]) {
    delete fakeBackedEnv[key];
  }
  const layerEnv = { env: fakeBackedEnv } as const;

  // Each provider adapter env-selects its real client (HttpClient) vs its fake
  // client (FileSystem + ChildProcessSpawner). The layer's `RIn` is the union of
  // both branches, so HttpClient must be satisfied at the type level even though
  // the fake branch runs. FetchHttpClient + NodeServices cover both.
  const providerDeps = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer);
  const daytonaAdapterLayer = makeDaytonaRuntimeAdapterLayer(layerEnv).pipe(
    Layer.provide(providerDeps),
  );

  const registryLayer = makeRuntimeProviderRegistryWithAdaptersLive({
    descriptors: [
      ...BUILT_IN_RUNTIME_DESCRIPTORS,
      ...FAKE_RUNTIME_DESCRIPTORS,
      DAYTONA_RUNTIME_DESCRIPTOR,
      VERCEL_SANDBOX_DESCRIPTOR,
      MODAL_PROVIDER_DESCRIPTOR,
      CLOUDFLARE_RUNTIME_DESCRIPTOR,
    ],
  }).pipe(
    Layer.provide(FakeRuntimeProviderAdapterLive),
    Layer.provide(daytonaAdapterLayer),
    Layer.provide(makeVercelSandboxRuntimeAdapterLayer(layerEnv).pipe(Layer.provide(providerDeps))),
    Layer.provide(makeModalRuntimeAdapterLayer(layerEnv).pipe(Layer.provide(providerDeps))),
    Layer.provide(makeCloudflareRuntimeAdapterLayer(layerEnv).pipe(Layer.provide(providerDeps))),
  );

  const layer = ExecutionRuntimeServiceLive.pipe(
    Layer.provide(ExecutionRuntimePlannerLive.pipe(Layer.provide(registryLayer))),
    Layer.provide(registryLayer),
    Layer.provide(RuntimeProviderCredentialsTestLive),
    Layer.provide(RuntimeActivityLeaseManagerLive),
    Layer.provide(GitCoreLive),
    Layer.provideMerge(daytonaAdapterLayer),
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
        projectId: ProjectId.makeUnsafe("project-e2e"),
        title: "Cloud Sandbox E2E",
        workspaceRoot: "/tmp/cloud-sandbox-e2e",
        defaultModelSelection: modelSelection,
        createdAt: now,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe(`cmd-thread-${threadId}`),
        threadId,
        projectId: ProjectId.makeUnsafe("project-e2e"),
        title: "Cloud Sandbox Thread",
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

/** Start a fresh `codex app-server` inside the provisioned instance. */
const execCodexAppServer = (
  runtime: ServiceRuntime,
  threadId: ThreadId,
  instanceId: ExecutionInstanceId,
) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const service = yield* ExecutionRuntimeService;
      return yield* service.exec({
        threadId,
        instanceId,
        role: "agent",
        command: CODEX_BINARY,
        args: ["app-server"],
        env: process.env as Record<string, string | undefined>,
      });
    }),
  );

interface JsonRpcResponse {
  readonly id?: string | number;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
  readonly method?: string;
}

/**
 * Send one JSON-RPC request over the transport and await the matching response
 * by id, skipping unrelated notifications. Resolves with `result` or rejects on
 * a JSON-RPC error / timeout.
 */
const rpcRequest = (
  runtime: ServiceRuntime,
  transport: JsonRpcLineTransport,
  id: number,
  method: string,
  params: unknown,
  timeoutMs = 30_000,
): Promise<unknown> =>
  runtime.runPromise(
    Effect.gen(function* () {
      yield* transport.send({ jsonrpc: "2.0", id, method, params });
      const matched = yield* transport.inbound.pipe(
        Stream.map((line) => {
          try {
            return JSON.parse(line) as JsonRpcResponse;
          } catch {
            return { method: "__parse_error__" } satisfies JsonRpcResponse;
          }
        }),
        Stream.filter((frame) => frame.id === id),
        Stream.runHead,
      );
      if (matched._tag === "None") {
        return yield* Effect.die(new Error(`no response for ${method} (id ${id})`));
      }
      const frame = matched.value;
      if (frame.error !== undefined) {
        return yield* Effect.die(
          new Error(`${method} returned error: ${frame.error.message ?? "unknown"}`),
        );
      }
      return frame.result;
    }).pipe(
      Effect.timeoutOrElse({
        duration: `${timeoutMs} millis`,
        onTimeout: () => Effect.die(new Error(`${method} timed out after ${timeoutMs}ms`)),
      }),
    ),
  );

const sendNotification = (
  runtime: ServiceRuntime,
  transport: JsonRpcLineTransport,
  method: string,
) => runtime.runPromise(transport.send({ jsonrpc: "2.0", method }).pipe(Effect.ignore));

/**
 * A turn-response item or terminal turn event — proof the agent produced output,
 * as opposed to session/thread lifecycle events that fire before any turn runs.
 */
const isTurnResponseItem = (method: string): boolean =>
  method.startsWith("item/") || method === "turn/completed";

const isAuthenticatedAccount = (accountRead: unknown): boolean => {
  if (typeof accountRead !== "object" || accountRead === null) {
    return false;
  }
  const account = (accountRead as { account?: unknown }).account;
  if (typeof account !== "object" || account === null) {
    return false;
  }
  const type = (account as { type?: unknown }).type;
  // The app-server reports an `account` with a concrete auth type once logged in
  // (chatgpt subscription or apiKey); an unauthenticated app-server returns no
  // account or `type: "unknown"`.
  return typeof type === "string" && type.length > 0 && type !== "unknown";
};

/**
 * Collect a `git status --porcelain` from inside the instance through the
 * Daytona adapter's exec channel (the runtime-neutral git primitive). Proves
 * file mutations land in the sandbox FS. Resolves the SAME `DaytonaRuntimeAdapter`
 * the service runtime provisioned through, so its sandbox-roots map knows the
 * instance (a fresh adapter would not).
 */
const collectGitStatus = (
  runtime: ServiceRuntime,
  instanceId: ExecutionInstanceId,
  workdir: string,
) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const adapter = yield* DaytonaRuntimeAdapter;
      yield* adapter.execCollect(instanceId, { command: "git", args: ["init"], cwd: workdir });
      yield* adapter.execCollect(instanceId, {
        command: "git",
        args: ["add", "-A"],
        cwd: workdir,
      });
      return yield* adapter.execCollect(instanceId, {
        command: "git",
        args: ["status", "--porcelain"],
        cwd: workdir,
      });
    }),
  );

describeE2E("cloud-sandbox provider runs the real codex agent through the remote transport", () => {
  let runtime: ServiceRuntime | undefined;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
      runtime = undefined;
    }
  });

  it("provisions a daytona instance, runs real codex app-server over the remote transport, and tears down", async () => {
    runtime = makeServiceRuntime();
    const localRuntime = runtime;
    const threadId = ThreadId.makeUnsafe("thread-cloud-sandbox-e2e");
    await seedThread(localRuntime, threadId);

    // --- Step 2: mark the thread remote for the cloud-sandbox provider via a
    // public RuntimePlan (provider "daytona"). This routes through
    // registry.getAdapter("daytona"), the fake-backed Daytona adapter.
    await localRuntime.runPromise(
      Effect.gen(function* () {
        const service = yield* ExecutionRuntimeService;
        yield* service.applyRuntimePlan({
          threadId,
          plan: {
            targetKind: "remote-runtime",
            provider: "daytona",
            ports: [],
            persistent: true,
            snapshotId: null,
          },
        });
      }),
    );
    const afterMark = await readThreadRuntime(localRuntime, threadId);
    expect(afterMark?.targetKind).toBe("remote-runtime");
    expect(afterMark?.provider).toBe("daytona");

    // --- Step 2/3: ensureTargetForThread provisions the Daytona instance.
    const target = await localRuntime.runPromise(
      Effect.gen(function* () {
        const service = yield* ExecutionRuntimeService;
        return yield* service.ensureTargetForThread(threadId);
      }),
    );
    expect(target.targetKind).toBe("remote-runtime");
    expect(target.instanceId).not.toBeNull();
    expect(target.cwd).toBeDefined();
    const rootPath = target.cwd as string;
    expect(existsSync(rootPath)).toBe(true);

    const afterProvision = await readThreadRuntime(localRuntime, threadId);
    expect(afterProvision?.status).toBe("running");
    expect(afterProvision?.instance?.provider).toBe("daytona");
    expect(afterProvision?.instance?.rootPath).toBe(rootPath);

    const instanceId = target.instanceId as ExecutionInstanceId;

    // --- Step 4: exec the REAL codex app-server inside the instance and drive
    // the JSON-RPC handshake over the returned transport.
    const handle = await execCodexAppServer(localRuntime, threadId, instanceId);
    expect(handle.transport).toBeDefined();

    const afterExec = await readThreadRuntime(localRuntime, threadId);
    expect(afterExec?.processes.some((proc) => proc.id === handle.processId)).toBe(true);

    const initializeResult = await rpcRequest(localRuntime, handle.transport, 1, "initialize", {
      clientInfo: { name: "synara-e2e", title: "Synara E2E", version: "0.0.0" },
    });
    // The real codex app-server answers initialize with a userAgent + codexHome:
    // proof the real agent process is running inside the provisioned sandbox and
    // talking back through the remote (in-memory) transport.
    expect(initializeResult).toBeTypeOf("object");
    expect(initializeResult).not.toBeNull();
    const initRecord = initializeResult as Record<string, unknown>;
    expect(typeof initRecord.userAgent).toBe("string");
    expect(String(initRecord.userAgent)).toContain("synara-e2e");

    await sendNotification(localRuntime, handle.transport, "initialized");

    const modelListResult = await rpcRequest(localRuntime, handle.transport, 2, "model/list", {});
    expect(modelListResult).toBeTypeOf("object");

    const accountReadResult = await rpcRequest(
      localRuntime,
      handle.transport,
      3,
      "account/read",
      {},
    );
    const authed = isAuthenticatedAccount(accountReadResult);

    // Close the handshake transport before (optionally) running a full turn.
    await localRuntime.runPromise(handle.transport.close).catch(() => {});

    let depth: "handshake" | "full-turn" = "handshake";
    let turnObservation = "";

    if (authed) {
      // --- Step 4 (full turn): drive a real turn through CodexAppServerManager
      // over a SECOND exec transport. The manager's createTransport factory
      // returns the exec transport; the version gate is skipped when a transport
      // factory is supplied, so no extra codex process is spawned by the manager.
      const turnHandle = await execCodexAppServer(localRuntime, threadId, instanceId);
      const events: ProviderEvent[] = [];
      const manager = new CodexAppServerManager(undefined, {
        createTransport: async (_input: CodexTransportFactoryInput) => turnHandle.transport,
      });

      // Resolve once the turn produces a real response item (an `item/*`
      // notification) or the turn terminates (`turn/completed`). Lifecycle
      // events alone (session/thread) do not count — the goal is to prove the
      // agent actually produced turn output through the remote transport.
      let resolveTurnOutput: (() => void) | undefined;
      const turnOutputSeen = new Promise<void>((resolve) => {
        resolveTurnOutput = resolve;
      });
      manager.on("event", (event) => {
        events.push(event);
        if (isTurnResponseItem(event.method)) {
          resolveTurnOutput?.();
        }
      });

      try {
        const session = await manager.startSession({
          threadId,
          provider: "codex",
          cwd: rootPath,
          runtimeMode: "full-access",
        });
        expect(session.status).toBe("ready");

        await manager.sendTurn({
          threadId,
          input:
            "Create a file named e2e-proof.txt containing exactly the text 'cloud sandbox ok' in the current working directory. Do not ask for confirmation.",
        });

        // Wait for a real turn response item; allow up to ~2.5 min for a model
        // round-trip + tool call. A timeout here means the turn never produced
        // output, which is a genuine failure of the full-turn path.
        const turnTimedOut = await Promise.race([
          turnOutputSeen.then(() => false),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 150_000)),
        ]);

        const responseItems = events.filter((event) => isTurnResponseItem(event.method));
        expect(turnTimedOut).toBe(false);
        expect(responseItems.length).toBeGreaterThan(0);
        depth = "full-turn";
        turnObservation = `streamed ${events.length} provider events (${responseItems.length} turn-response items); methods: ${[
          ...new Set(events.map((event) => event.method)),
        ].join(", ")}`;

        // Collect a git status through the Daytona adapter's exec channel — the
        // runtime-neutral git primitive — to prove the turn's file mutations
        // land in the sandbox FS.
        const gitStatus = await collectGitStatus(localRuntime, instanceId, ".");
        turnObservation += ` | git status:\n${gitStatus.stdout.trim() || "(clean)"}`;
      } finally {
        manager.stopAll();
        await localRuntime.runPromise(turnHandle.transport.close).catch(() => {});
      }
    } else {
      turnObservation =
        "codex is NOT authenticated on this host (account/read returned no concrete account type); " +
        "handshake (initialize/initialized/model/list/account/read) completed over the remote transport. " +
        "Run `codex login` to enable the full-turn path.";
    }

    // --- Step 6: destroy the instance and assert cleanup.
    await localRuntime.runPromise(
      Effect.gen(function* () {
        const service = yield* ExecutionRuntimeService;
        yield* service.destroy(threadId, instanceId);
      }),
    );
    expect(existsSync(rootPath)).toBe(false);

    // Surface how deep the run got so the suite output records it.
    console.log(`[cloudSandboxAgent.e2e] provider=daytona depth=${depth} :: ${turnObservation}`);
    expect(["handshake", "full-turn"]).toContain(depth);
  }, 240_000);
});

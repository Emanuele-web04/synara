/**
 * LIVE Daytona + real codex turn: provisions a sandbox from a codex-equipped
 * snapshot, injects the host's codex auth, runs the REAL `codex app-server`
 * inside the sandbox over the remote transport (a PTY-backed streaming session),
 * and drives a real turn through `CodexAppServerManager` — the production path.
 *
 * Gated behind `RUN_DAYTONA_CODEX=1` + `DAYTONA_API_KEY` + a host codex login
 * (`~/.codex/auth.json`). Snapshot via `DAYTONA_CODEX_SNAPSHOT`.
 *   cd apps/server && RUN_DAYTONA_CODEX=1 bunx vitest run daytonaCodexLive.e2e
 *
 * @module executionRuntime/e2e/daytonaCodexLive.e2e
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  RuntimeSnapshotId,
  ThreadId,
  type ExecutionInstanceId,
  type ModelSelection,
  type ProviderEvent,
} from "@t3tools/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
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
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { BUILT_IN_RUNTIME_DESCRIPTORS } from "../Layers/descriptors.ts";
import { ExecutionRuntimePlannerLive } from "../Layers/ExecutionRuntimePlanner.ts";
import { ExecutionRuntimeServiceLive } from "../Layers/ExecutionRuntimeService.ts";
import { FAKE_RUNTIME_DESCRIPTORS } from "../Layers/fakeDescriptors.ts";
import { FakeRuntimeProviderAdapterLive } from "../Layers/FakeRuntimeProviderAdapter.ts";
import { makeRuntimeProviderRegistryWithAdaptersLive } from "../Layers/RuntimeProviderRegistry.ts";
import { CLOUDFLARE_RUNTIME_DESCRIPTOR } from "../Layers/cloudflareDescriptor.ts";
import { makeCloudflareRuntimeAdapterLayer } from "../Layers/CloudflareRuntimeProviderFacadeLayer.ts";
import { DAYTONA_RUNTIME_DESCRIPTOR } from "../providers/daytona/descriptor.ts";
import { DaytonaRuntimeAdapter } from "../providers/daytona/DaytonaRuntimeAdapter.ts";
import { makeDaytonaRuntimeAdapterLayer } from "../providers/daytona/runtimeLayer.ts";
import { MODAL_PROVIDER_DESCRIPTOR } from "../providers/modal/modalDescriptors.ts";
import { makeModalRuntimeAdapterLayer } from "../providers/modal/runtimeLayer.ts";
import { VERCEL_SANDBOX_DESCRIPTOR } from "../providers/vercelSandbox/descriptor.ts";
import { makeVercelSandboxRuntimeAdapterLayer } from "../providers/vercelSandbox/runtimeLayer.ts";
import { ExecutionRuntimeService } from "../Services/ExecutionRuntimeService.ts";

const hostAuthPath = `${homedir()}/.codex/auth.json`;
const hostAuth = existsSync(hostAuthPath) ? readFileSync(hostAuthPath, "utf8") : null;
const LIVE =
  process.env.RUN_DAYTONA_CODEX === "1" &&
  Boolean(process.env.DAYTONA_API_KEY) &&
  hostAuth !== null;
const describeLive = LIVE ? describe : describe.skip;

const SNAPSHOT =
  process.env.DAYTONA_CODEX_SNAPSHOT ?? "terry-vCPU-4-RAM-8GB-2026-05-27-20-58-54-codex";
const modelSelection: ModelSelection = { provider: "codex", model: "gpt-5.3-codex" };
const now = "2026-06-04T00:00:00.000Z";

const makeLiveRuntime = () => {
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  );
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "daytona-codex-live",
  }).pipe(Layer.provide(NodeServices.layer));

  const providerDeps = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer);
  const daytonaAdapterLayer = makeDaytonaRuntimeAdapterLayer().pipe(Layer.provide(providerDeps));

  const otherEnv: Record<string, string | undefined> = { ...process.env };
  for (const k of [
    "VERCEL_TOKEN",
    "VERCEL_TEAM_ID",
    "VERCEL_PROJECT_ID",
    "MODAL_TOKEN_ID",
    "MODAL_TOKEN_SECRET",
    "SYNARA_CLOUDFLARE_BRIDGE_URL",
    "SYNARA_CLOUDFLARE_BRIDGE_TOKEN",
  ]) {
    delete otherEnv[k];
  }
  const otherLayerEnv = { env: otherEnv } as const;

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
    Layer.provide(
      makeVercelSandboxRuntimeAdapterLayer(otherLayerEnv).pipe(Layer.provide(providerDeps)),
    ),
    Layer.provide(makeModalRuntimeAdapterLayer(otherLayerEnv).pipe(Layer.provide(providerDeps))),
    Layer.provide(
      makeCloudflareRuntimeAdapterLayer(otherLayerEnv).pipe(Layer.provide(providerDeps)),
    ),
  );

  const layer = ExecutionRuntimeServiceLive.pipe(
    Layer.provide(ExecutionRuntimePlannerLive.pipe(Layer.provide(registryLayer))),
    Layer.provide(registryLayer),
    Layer.provideMerge(daytonaAdapterLayer),
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(serverConfigLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
  );
  return ManagedRuntime.make(layer);
};

type LiveRuntime = ReturnType<typeof makeLiveRuntime>;

const seedThread = (runtime: LiveRuntime, threadId: ThreadId) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe(`cmd-project-${threadId}`),
        projectId: ProjectId.makeUnsafe("project-daytona-codex"),
        title: "Daytona Codex Live",
        workspaceRoot: "/tmp/daytona-codex",
        defaultModelSelection: modelSelection,
        createdAt: now,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe(`cmd-thread-${threadId}`),
        threadId,
        projectId: ProjectId.makeUnsafe("project-daytona-codex"),
        title: "Daytona Codex Thread",
        modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });
    }),
  );

const execIn = (
  runtime: LiveRuntime,
  instanceId: ExecutionInstanceId,
  command: string,
  args: ReadonlyArray<string>,
) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const adapter = yield* DaytonaRuntimeAdapter;
      return yield* adapter.execCollect(instanceId, { command, args });
    }),
  );

const isTurnResponseItem = (method: string): boolean =>
  method.startsWith("item/") || method === "turn/completed";

describeLive("LIVE Daytona + real codex: drive a turn inside a codex-equipped sandbox", () => {
  let runtime: LiveRuntime | undefined;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
      runtime = undefined;
    }
  });

  it("provisions from a codex snapshot, injects auth, and runs a real codex turn", async () => {
    runtime = makeLiveRuntime();
    const live = runtime;
    const threadId = ThreadId.makeUnsafe("thread-daytona-codex");
    await seedThread(live, threadId);

    await live.runPromise(
      Effect.gen(function* () {
        const service = yield* ExecutionRuntimeService;
        yield* service.applyRuntimePlan({
          threadId,
          plan: {
            targetKind: "remote-runtime",
            provider: "daytona",
            ports: [],
            persistent: true,
            snapshotId: RuntimeSnapshotId.makeUnsafe(SNAPSHOT),
          },
        });
      }),
    );
    // provision waits for readiness and discovers the real working dir.
    const target = await live.runPromise(
      Effect.gen(function* () {
        const service = yield* ExecutionRuntimeService;
        return yield* service.ensureTargetForThread(threadId);
      }),
    );
    const instanceId = target.instanceId as ExecutionInstanceId;
    const workdir = target.cwd ?? "/root";
    console.log(
      `[daytonaCodexLive] provisioned ${instanceId} root=${workdir} snapshot=${SNAPSHOT}`,
    );

    // Inject the host's codex auth ($HOME/.codex/auth.json). b64 is a positional
    // arg so its content cannot break the shell.
    const b64 = Buffer.from(hostAuth as string, "utf8").toString("base64");
    const inject = await execIn(live, instanceId, "bash", [
      "-lc",
      'mkdir -p "$HOME/.codex" && printf %s "$0" | base64 -d > "$HOME/.codex/auth.json" && echo injected',
      b64,
    ]);
    expect(inject.code).toBe(0);

    // Drive a real turn through CodexAppServerManager. Its createTransport
    // factory returns the Daytona PTY-backed transport (the production seam);
    // supplying a factory skips the local version gate, so no local codex spawns.
    const events: ProviderEvent[] = [];
    const manager = new CodexAppServerManager(undefined, {
      createTransport: async (_input: CodexTransportFactoryInput) =>
        live.runPromise(
          Effect.gen(function* () {
            const adapter = yield* DaytonaRuntimeAdapter;
            const built = yield* adapter.createTransport(instanceId, {
              command: "codex",
              args: ["app-server"],
              cwd: workdir,
              env: {},
            });
            return built.transport;
          }),
        ),
    });

    let resolveSeen: (() => void) | undefined;
    const turnSeen = new Promise<void>((resolve) => {
      resolveSeen = resolve;
    });
    manager.on("event", (event) => {
      events.push(event);
      if (isTurnResponseItem(event.method)) resolveSeen?.();
    });

    try {
      const session = await manager.startSession({
        threadId,
        provider: "codex",
        cwd: workdir,
        runtimeMode: "full-access",
      });
      // A ready session means initialize/initialized/model.list/account.read all
      // completed over the PTY transport — the real agent runs in the sandbox.
      expect(session.status).toBe("ready");
      console.log(`[daytonaCodexLive] session ready over PTY transport`);

      await manager.sendTurn({
        threadId,
        input:
          "Create a file named codex-live-proof.txt containing exactly 'daytona codex ok' in the current working directory. Do not ask for confirmation.",
      });
      const timedOut = await Promise.race([
        turnSeen.then(() => false),
        new Promise<boolean>((r) => setTimeout(() => r(true), 180_000)),
      ]);
      const responseItems = events.filter((e) => isTurnResponseItem(e.method));
      expect(timedOut).toBe(false);
      expect(responseItems.length).toBeGreaterThan(0);

      const proof = await execIn(live, instanceId, "bash", [
        "-lc",
        'cat "$0/codex-live-proof.txt" 2>/dev/null || find / -name codex-live-proof.txt 2>/dev/null | head -1 | xargs -r cat 2>/dev/null',
        workdir,
      ]);
      console.log(
        `[daytonaCodexLive] full-turn: ${events.length} events, ${responseItems.length} items; proof => ${proof.stdout.trim()}`,
      );
    } finally {
      manager.stopAll();
    }

    await live.runPromise(
      Effect.gen(function* () {
        const service = yield* ExecutionRuntimeService;
        yield* service.destroy(threadId, instanceId);
      }),
    );
    console.log(`[daytonaCodexLive] destroyed ${instanceId}`);
  }, 420_000);
});

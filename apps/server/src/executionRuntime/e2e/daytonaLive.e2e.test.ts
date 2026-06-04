/**
 * LIVE Daytona end-to-end: provisions a REAL Daytona sandbox over the documented
 * REST API, runs commands inside it through the toolbox exec channel, and tears
 * it down. Validates the doc-modeled `HttpDaytonaSandboxClient` request/response
 * shapes against the live API — the one surface the fake-backed suite cannot
 * cover.
 *
 * Gated behind `RUN_DAYTONA_LIVE=1` AND a present `DAYTONA_API_KEY`, so the
 * default suite never hits the network or bills an account. Run with:
 *   cd apps/server && RUN_DAYTONA_LIVE=1 bunx vitest run daytonaLive.e2e
 *
 * @module executionRuntime/e2e/daytonaLive.e2e
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  type ExecutionInstanceId,
  type ModelSelection,
} from "@t3tools/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
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

const LIVE = process.env.RUN_DAYTONA_LIVE === "1" && Boolean(process.env.DAYTONA_API_KEY);
const describeLive = LIVE ? describe : describe.skip;

const modelSelection: ModelSelection = { provider: "codex", model: "gpt-5.3-codex" };
const now = "2026-06-04T00:00:00.000Z";

// Real env: DAYTONA_API_KEY is NOT stripped, so the Daytona runtime layer selects
// the real HttpDaytonaSandboxClient and hits app.daytona.io.
const makeLiveRuntime = () => {
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  );
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "daytona-live-e2e",
  }).pipe(Layer.provide(NodeServices.layer));

  const providerDeps = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer);
  const daytonaAdapterLayer = makeDaytonaRuntimeAdapterLayer({ env: process.env }).pipe(
    Layer.provide(providerDeps),
  );

  // The registry requires every provider adapter service to exist. Only Daytona
  // runs live; the others stay fake-backed with their creds stripped so a stray
  // env var cannot trigger a live call to another cloud.
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
        projectId: ProjectId.makeUnsafe("project-daytona-live"),
        title: "Daytona Live",
        workspaceRoot: "/tmp/daytona-live",
        defaultModelSelection: modelSelection,
        createdAt: now,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe(`cmd-thread-${threadId}`),
        threadId,
        projectId: ProjectId.makeUnsafe("project-daytona-live"),
        title: "Daytona Live Thread",
        modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });
    }),
  );

describeLive("LIVE Daytona sandbox: provision, exec, destroy over the real REST API", () => {
  let runtime: LiveRuntime | undefined;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
      runtime = undefined;
    }
  });

  it("provisions a real sandbox, runs commands inside it, and tears it down", async () => {
    runtime = makeLiveRuntime();
    const live = runtime;
    const threadId = ThreadId.makeUnsafe("thread-daytona-live");
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
            snapshotId: null,
          },
        });
      }),
    );

    // Provision a REAL Daytona sandbox (create + wait until running).
    const target = await live.runPromise(
      Effect.gen(function* () {
        const service = yield* ExecutionRuntimeService;
        return yield* service.ensureTargetForThread(threadId);
      }),
    );
    expect(target.targetKind).toBe("remote-runtime");
    expect(target.instanceId).not.toBeNull();
    const instanceId = target.instanceId as ExecutionInstanceId;
    const workdir = target.cwd ?? ".";
    console.log(`[daytonaLive] provisioned instance=${instanceId} rootPath=${workdir}`);

    const runtimeRow = await live.runPromise(
      Effect.gen(function* () {
        const query = yield* ProjectionSnapshotQuery;
        const option = yield* query.getThreadDetailById(threadId);
        return option._tag === "Some" ? (option.value.runtime ?? null) : null;
      }),
    );
    expect(runtimeRow?.instance?.provider).toBe("daytona");
    expect(runtimeRow?.status).toBe("running");

    // Run real commands inside the sandbox through the toolbox exec channel.
    // Omit cwd so commands run in the sandbox's default working directory.
    const exec = (command: string, args: ReadonlyArray<string>) =>
      live.runPromise(
        Effect.gen(function* () {
          const adapter = yield* DaytonaRuntimeAdapter;
          return yield* adapter.execCollect(instanceId, { command, args });
        }),
      );

    const pwd = await exec("pwd", []);
    console.log(`[daytonaLive] pwd => code=${pwd.code} :: ${pwd.stdout.trim()}`);

    const uname = await exec("uname", ["-a"]);
    console.log(`[daytonaLive] uname -a => code=${uname.code} :: ${uname.stdout.trim()}`);
    expect(uname.code).toBe(0);
    expect(uname.stdout.toLowerCase()).toContain("linux");

    // Validate the production cwd path: an absolute cwd (the instance rootPath,
    // exactly what codex-in-Daytona passes) must resolve, not double or 404.
    const pwdInRoot = await live.runPromise(
      Effect.gen(function* () {
        const adapter = yield* DaytonaRuntimeAdapter;
        return yield* adapter.execCollect(instanceId, { command: "pwd", args: [], cwd: workdir });
      }),
    );
    console.log(
      `[daytonaLive] pwd (cwd=${workdir}) => code=${pwdInRoot.code} :: ${pwdInRoot.stdout.trim()}`,
    );
    expect(pwdInRoot.code).toBe(0);
    expect(pwdInRoot.stdout.trim()).toBe(workdir);

    const marker = `synara-live-${threadId}`;
    const write = await exec("sh", [
      "-c",
      `printf '%s' '${marker}' > live-proof.txt && cat live-proof.txt`,
    ]);
    console.log(`[daytonaLive] write+cat => code=${write.code} :: ${write.stdout.trim()}`);
    expect(write.code).toBe(0);
    expect(write.stdout).toContain(marker);

    // Tear the sandbox down (archive + delete).
    await live.runPromise(
      Effect.gen(function* () {
        const service = yield* ExecutionRuntimeService;
        yield* service.destroy(threadId, instanceId);
      }),
    );
    console.log(`[daytonaLive] destroyed instance=${instanceId}`);
  }, 300_000);
});

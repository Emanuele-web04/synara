/**
 * LIVE Daytona + real codex: provisions a sandbox from a codex-equipped snapshot,
 * injects the host's codex auth, and runs the REAL `codex app-server` inside the
 * sandbox — confirming it answers `initialize` with the injected auth recognized.
 *
 * codex runs via a one-shot pipe (`printf init | codex app-server`), the path the
 * runtime-neutral exec channel uses. Driving the long-lived app-server as a
 * streaming session over Daytona's async toolbox session has a remaining
 * stdin/stdout nuance (a Rust interactive server vs. the session's pipe) tracked
 * separately; the fire-and-collect proof here establishes codex executes in the
 * live sandbox with working auth.
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
} from "@t3tools/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vitest";

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

describeLive("LIVE Daytona + real codex: run codex inside a codex-equipped sandbox", () => {
  let runtime: LiveRuntime | undefined;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
      runtime = undefined;
    }
  });

  it("provisions from a codex snapshot, injects auth, and codex answers initialize", async () => {
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
    const target = await live.runPromise(
      Effect.gen(function* () {
        const service = yield* ExecutionRuntimeService;
        return yield* service.ensureTargetForThread(threadId);
      }),
    );
    const instanceId = target.instanceId as ExecutionInstanceId;
    console.log(`[daytonaCodexLive] provisioned ${instanceId} snapshot=${SNAPSHOT}`);

    // Large snapshots take time to start; exec errors until then. Poll.
    for (let i = 0; i < 60; i++) {
      const ready = await execIn(live, instanceId, "true", []).catch(() => ({
        code: -1,
        stdout: "",
        stderr: "",
      }));
      if (ready.code === 0) break;
      await new Promise((res) => setTimeout(res, 3000));
    }

    const realRoot = (await execIn(live, instanceId, "pwd", [])).stdout.trim() || "/root";
    const which = await execIn(live, instanceId, "which", ["codex"]);
    console.log(`[daytonaCodexLive] root=${realRoot} which codex => ${which.stdout.trim()}`);
    expect(which.code).toBe(0);

    // Inject the host's codex auth ($HOME/.codex/auth.json). b64 is a positional
    // arg so its content cannot break the shell.
    const b64 = Buffer.from(hostAuth as string, "utf8").toString("base64");
    const inject = await execIn(live, instanceId, "bash", [
      "-lc",
      'mkdir -p "$HOME/.codex" && printf %s "$0" | base64 -d > "$HOME/.codex/auth.json" && echo injected',
      b64,
    ]);
    expect(inject.code).toBe(0);

    // Run the REAL codex app-server in the sandbox and confirm it answers
    // `initialize` with a result naming its codexHome — proof the agent runs
    // with the injected auth inside the live cloud sandbox.
    const init = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "synara_desktop", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      },
    });
    const codexRun = await execIn(live, instanceId, "bash", [
      "-lc",
      'cd "$0" && printf \'%s\\n\' "$1" | timeout 15 codex app-server 2>&1',
      realRoot,
      init,
    ]);
    const initLine = codexRun.stdout
      .split("\n")
      .map((l) => {
        try {
          return JSON.parse(l) as { id?: unknown; result?: { codexHome?: unknown } };
        } catch {
          return undefined;
        }
      })
      .find((f) => f?.id === 1);
    console.log(
      `[daytonaCodexLive] codex initialize => ${JSON.stringify(initLine?.result ?? codexRun.stdout.trim().slice(0, 200))}`,
    );
    expect(initLine?.result).toBeTypeOf("object");
    expect(typeof initLine?.result?.codexHome).toBe("string");

    await live.runPromise(
      Effect.gen(function* () {
        const service = yield* ExecutionRuntimeService;
        yield* service.destroy(threadId, instanceId);
      }),
    );
    console.log(`[daytonaCodexLive] destroyed ${instanceId}`);
  }, 300_000);
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ServerConfig } from "./config";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";
import { makeServerProviderLayer, makeServerRuntimeServicesLayer } from "./serverLayers";
import { ServerSettingsService } from "./serverSettings";

describe("makeServerRuntimeServicesLayer", () => {
  it("boots the production runtime composition with server settings available to snapshots", async () => {
    const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "synara-server-layers-test-",
    }).pipe(Layer.provide(NodeServices.layer));
    const productionLayer = Layer.empty.pipe(
      Layer.provideMerge(makeServerRuntimeServicesLayer()),
      Layer.provideMerge(makeServerProviderLayer()),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(serverConfigLayer),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(ServerSettingsService.layerTest()),
    );

    const counts = await Effect.runPromise(
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsService;
        yield* serverSettings.start;

        const snapshotQuery = yield* ProjectionSnapshotQuery;
        return yield* snapshotQuery.getCounts();
      }).pipe(Effect.provide(productionLayer)),
    );

    expect(counts).toEqual({ projectCount: 0, threadCount: 0 });
  });
});

let accountHome: string;
beforeEach(() => {
  accountHome = mkdtempSync(join(tmpdir(), "synara-runtime-accounts-"));
  vi.stubEnv("SYNARA_ACCOUNT_HOME", accountHome);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(accountHome, { recursive: true, force: true });
});

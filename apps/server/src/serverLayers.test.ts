import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "./config";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";
import { makeServerProviderLayer, makeServerRuntimeServicesLayer } from "./serverLayers";
import { ServerSettingsService } from "./serverSettings";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService";

describe("makeServerRuntimeServicesLayer", () => {
  it("boots the production runtime composition with server settings available to snapshots", async () => {
    const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "synara-server-layers-test-",
    }).pipe(Layer.provide(NodeServices.layer));
    const productionLayer = Layer.empty.pipe(
      Layer.provideMerge(makeServerRuntimeServicesLayer()),
      Layer.provideMerge(makeServerProviderLayer()),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(AnalyticsService.layerTest),
      Layer.provideMerge(serverConfigLayer),
      Layer.provideMerge(NodeServices.layer),
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

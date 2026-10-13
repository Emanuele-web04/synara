// Perf probe: per-stage cost of delivering one thread-detail snapshot (SQL read + decode,
// RPC stream-item encode, JSON serialization, client parse + decode) against a copy of a
// real Synara database. Run with:
//   SYNARA_PERF_DB=/path/to/state.copy.sqlite SYNARA_PERF_THREADS=id1,id2 \
//     bunx vitest run perf/threadDetailStages.perf.test.ts
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { describe } from "vitest";
import { OrchestrationThreadStreamItem, ThreadId } from "@synara/contracts";

import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { OrchestrationProjectionSnapshotQueryLive as OrchestrationProjectionSnapshotQueryBase } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../src/serverSettings.ts";

const DB = process.env.SYNARA_PERF_DB;
const THREADS = (process.env.SYNARA_PERF_THREADS ?? "").split(",").filter(Boolean);
const SAMPLES = Number(process.env.SYNARA_PERF_SAMPLES ?? 7);

const median = (values: number[]) => values.toSorted((a, b) => a - b)[values.length >> 1]!;

describe.skipIf(!DB || THREADS.length === 0)("thread detail delivery stages", () => {
  const layer = OrchestrationProjectionSnapshotQueryBase.pipe(
    Layer.provide(ServerSettingsService.layerTest()),
    Layer.provideMerge(makeSqlitePersistenceLive(DB!)),
    Layer.provideMerge(NodeServices.layer),
  );
  const encodeItem = Schema.encodeSync(OrchestrationThreadStreamItem);
  const decodeItem = Schema.decodeUnknownSync(OrchestrationThreadStreamItem);

  it.effect(
    "reports per-stage medians",
    () =>
      Effect.gen(function* () {
        const query = yield* ProjectionSnapshotQuery;
        const rows: Record<string, unknown>[] = [];
        for (const id of THREADS) {
          const threadId = ThreadId.makeUnsafe(id);
          const stage = { load: [] as number[], encode: [] as number[], stringify: [] as number[] };
          const client = { parse: [] as number[], decode: [] as number[] };
          let bytes = 0;
          let messages = 0;
          let activities = 0;
          for (let sample = 0; sample < SAMPLES; sample += 1) {
            const t0 = performance.now();
            const snapshot = yield* query.getThreadDetailSnapshotById(threadId);
            const t1 = performance.now();
            if (Option.isNone(snapshot)) throw new Error(`missing thread ${id}`);
            const encoded = encodeItem({ kind: "snapshot", snapshot: snapshot.value });
            const t2 = performance.now();
            const json = JSON.stringify(encoded);
            const serializedAt = performance.now();
            const parsed: unknown = JSON.parse(json);
            const t4 = performance.now();
            decodeItem(parsed);
            const t5 = performance.now();
            stage.load.push(t1 - t0);
            stage.encode.push(t2 - t1);
            stage.stringify.push(serializedAt - t2);
            client.parse.push(t4 - serializedAt);
            client.decode.push(t5 - t4);
            bytes = json.length;
            messages = snapshot.value.thread.messages.length;
            activities = snapshot.value.thread.activities.length;
          }
          rows.push({
            id,
            messages,
            activities,
            kb: Math.round(bytes / 1024),
            serverLoadMs: +median(stage.load).toFixed(1),
            serverEncodeMs: +median(stage.encode).toFixed(1),
            serverStringifyMs: +median(stage.stringify).toFixed(1),
            clientParseMs: +median(client.parse).toFixed(1),
            clientDecodeMs: +median(client.decode).toFixed(1),
          });
        }
        console.table(rows);
      }).pipe(Effect.provide(layer)),
    { timeout: 300_000 },
  );
});

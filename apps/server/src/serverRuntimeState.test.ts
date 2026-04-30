import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "./config";
import {
  clearPersistedServerRuntimeState,
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
  readPersistedServerRuntimeState,
} from "./serverRuntimeState";

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "dpcode-runtime-state-" }).pipe(
  Layer.provide(NodeServices.layer),
);

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect.pipe(Effect.provide(testLayer)) as Effect.Effect<A, E, never>);

describe("serverRuntimeState", () => {
  it("persists, reads, and clears runtime state", async () => {
    const result = await run(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const state = makePersistedServerRuntimeState({ config, port: 4123 });
        yield* persistServerRuntimeState({ path: config.serverRuntimeStatePath, state });
        const persisted = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
        yield* clearPersistedServerRuntimeState(config.serverRuntimeStatePath);
        const cleared = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
        return { persisted, cleared };
      }),
    );

    expect(Option.isSome(result.persisted)).toBe(true);
    if (Option.isSome(result.persisted)) {
      expect(result.persisted.value.origin).toBe("http://127.0.0.1:4123");
    }
    expect(Option.isNone(result.cleared)).toBe(true);
  });
});

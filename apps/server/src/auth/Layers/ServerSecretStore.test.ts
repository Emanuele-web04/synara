import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config";
import { ServerSecretStore, type SecretStoreError } from "../Services/ServerSecretStore";
import { ServerSecretStoreLive } from "./ServerSecretStore";

const makeLayer = () =>
  ServerSecretStoreLive.pipe(
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "dpcode-secret-store-test-",
      }),
    ),
    Layer.provide(NodeServices.layer),
  );

const runWithSecretStore = (effect: Effect.Effect<void, SecretStoreError, ServerSecretStore>) =>
  effect.pipe(Effect.provide(makeLayer()), Effect.scoped, Effect.runPromise);

describe("ServerSecretStoreLive", () => {
  it("persists and reads named secrets", async () => {
    await runWithSecretStore(
      Effect.gen(function* () {
        const store = yield* ServerSecretStore;
        yield* store.set("session-signing", new Uint8Array([1, 2, 3]));

        expect(Array.from((yield* store.get("session-signing")) ?? [])).toEqual([1, 2, 3]);
      }),
    );
  });

  it("reuses generated random secrets", async () => {
    await runWithSecretStore(
      Effect.gen(function* () {
        const store = yield* ServerSecretStore;
        const first = yield* store.getOrCreateRandom("websocket", 32);
        const second = yield* store.getOrCreateRandom("websocket", 32);

        expect(first.byteLength).toBe(32);
        expect(Array.from(second)).toEqual(Array.from(first));
      }),
    );
  });

  it("removes secrets idempotently", async () => {
    await runWithSecretStore(
      Effect.gen(function* () {
        const store = yield* ServerSecretStore;
        yield* store.set("remove-me", new Uint8Array([9]));
        yield* store.remove("remove-me");
        yield* store.remove("remove-me");

        expect(yield* store.get("remove-me")).toBeNull();
      }),
    );
  });
});

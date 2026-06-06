/**
 * SandboxSecretWriter test.
 *
 * Pins the secret-handling contract for `updateSettings`: secret-bearing sandbox
 * fields are written to `ServerSecretStore` and removed from the patch (so the raw
 * token never reaches settings.json), while non-secret fields pass through. A
 * patch with no sandbox secrets is returned unchanged.
 *
 * @module SandboxSecretWriter.test
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import type { ServerSettingsPatch } from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { ServerSecretStoreLive } from "../../auth/Layers/ServerSecretStore.ts";
import { sandboxSecretName } from "../sandboxCredentialMapping.ts";
import { SandboxSecretWriter } from "../Services/SandboxSecretWriter.ts";
import { SandboxSecretWriterLive } from "./SandboxSecretWriter.ts";

const makeLayer = () =>
  SandboxSecretWriterLive.pipe(
    Layer.provideMerge(ServerSecretStoreLive),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "sandbox-secret-writer-test-" })),
    Layer.provide(NodeServices.layer),
  );

const run = <A>(body: Effect.Effect<A, unknown, SandboxSecretWriter | ServerSecretStore>) =>
  body.pipe(Effect.provide(makeLayer()), Effect.scoped, Effect.runPromise);

const decode = (bytes: Uint8Array | null) =>
  bytes === null ? null : new TextDecoder().decode(bytes);

describe("SandboxSecretWriterLive", () => {
  it("writes secret fields to the store and strips them from the patch", async () => {
    const patch: ServerSettingsPatch = {
      sandboxes: {
        daytona: { apiKey: "live-token", apiUrl: "https://x/api" },
        vercel: { token: "vt", teamId: "team" },
      },
    };

    const result = await run(
      Effect.gen(function* () {
        const writer = yield* SandboxSecretWriter;
        const stripped = yield* writer.persistSecrets(patch);
        const store = yield* ServerSecretStore;
        const daytonaKey = decode(yield* store.get(sandboxSecretName("daytona", "apiKey")));
        const vercelToken = decode(yield* store.get(sandboxSecretName("vercel-sandbox", "token")));
        return { stripped, daytonaKey, vercelToken };
      }),
    );

    expect(result.daytonaKey).toBe("live-token");
    expect(result.vercelToken).toBe("vt");

    // Secret fields are gone from the patch; non-secret fields remain.
    const sandboxes = result.stripped.sandboxes;
    expect(sandboxes?.daytona).toEqual({ apiUrl: "https://x/api" });
    expect(sandboxes?.vercel).toEqual({ teamId: "team" });
  });

  it("returns the patch unchanged when no sandbox secrets are present", async () => {
    const patch: ServerSettingsPatch = {
      enableAssistantStreaming: true,
      sandboxes: { daytona: { apiUrl: "https://x/api" } },
    };

    const result = await run(
      Effect.gen(function* () {
        const writer = yield* SandboxSecretWriter;
        return yield* writer.persistSecrets(patch);
      }),
    );

    expect(result).toBe(patch);
  });

  it("does not echo the secret back in the returned patch", async () => {
    const patch: ServerSettingsPatch = {
      sandboxes: { modal: { tokenId: "id", tokenSecret: "shh", environment: "prod" } },
    };

    const result = await run(
      Effect.gen(function* () {
        const writer = yield* SandboxSecretWriter;
        return yield* writer.persistSecrets(patch);
      }),
    );

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("shh");
    expect(serialized).not.toContain('"id"');
    expect(result.sandboxes?.modal).toEqual({ environment: "prod" });
  });
});

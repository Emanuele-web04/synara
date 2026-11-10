import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  SYNARA_BETA_BUNDLE_ID,
  SYNARA_DESKTOP_BUNDLE_ID_ENV,
  SYNARA_PRODUCTION_BUNDLE_ID,
} from "@synara/shared/desktopIdentity";
import { Effect, FileSystem, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ServerConfig } from "../../config";
import { ServerEnvironment } from "../Services/ServerEnvironment";
import { ServerEnvironmentLive } from "./ServerEnvironment";

const makeLayer = (baseDir: string) =>
  ServerEnvironmentLive.pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)));

describe("ServerEnvironmentLive", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("persists the environment id across service restarts", async () => {
    await Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "synara-server-environment-test-",
      });

      const first = yield* Effect.gen(function* () {
        const serverEnvironment = yield* ServerEnvironment;
        return yield* serverEnvironment.getDescriptor;
      }).pipe(Effect.provide(makeLayer(baseDir)));

      const second = yield* Effect.gen(function* () {
        const serverEnvironment = yield* ServerEnvironment;
        return yield* serverEnvironment.getDescriptor;
      }).pipe(Effect.provide(makeLayer(baseDir)));

      expect(first.environmentId).toBe(second.environmentId);
      expect(first.serverVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(second.capabilities.repositoryIdentity).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped, Effect.runPromise);
  });

  it.each([
    [SYNARA_PRODUCTION_BUNDLE_ID, false],
    [SYNARA_BETA_BUNDLE_ID, true],
  ] as const)(
    "advertises composer predictions exactly where the RPC serves them (%s)",
    async (bundleId, enabled) => {
      vi.stubEnv(SYNARA_DESKTOP_BUNDLE_ID_ENV, bundleId);
      vi.resetModules();
      const environmentModule = await import("./ServerEnvironment");
      const servicesModule = await import("../Services/ServerEnvironment");
      const configModule = await import("../../config");
      const { isServerComposerPredictionsEnabled } =
        await import("../../composerPrediction/composerPredictionGate");

      const descriptor = await Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "synara-server-environment-test-",
        });
        return yield* Effect.gen(function* () {
          const serverEnvironment = yield* servicesModule.ServerEnvironment;
          return yield* serverEnvironment.getDescriptor;
        }).pipe(
          Effect.provide(
            environmentModule.ServerEnvironmentLive.pipe(
              Layer.provide(configModule.ServerConfig.layerTest(process.cwd(), baseDir)),
            ),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped, Effect.runPromise);

      // The RPC refuses on exactly this gate, so the flag and the RPC cannot disagree.
      expect(isServerComposerPredictionsEnabled()).toBe(enabled);
      expect(descriptor.capabilities.composerPredictions).toBe(enabled);
    },
  );
});

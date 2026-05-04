import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config";
import { ServerEnvironment } from "../Services/ServerEnvironment";
import { ServerEnvironmentLive } from "./ServerEnvironment";

const makeLayer = (baseDir: string) =>
  ServerEnvironmentLive.pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)));

describe("ServerEnvironmentLive", () => {
  it("persists the environment id across service restarts", async () => {
    await Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "dpcode-server-environment-test-",
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
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_MODEL_BY_PROVIDER } from "@synara/contracts";
import { Effect, FileSystem, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { ServerConfig } from "./config";
import { ServerSettingsLive, ServerSettingsService } from "./serverSettings";

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "synara-settings-test-",
}).pipe(Layer.provide(NodeServices.layer));
const makeTestLayer = Layer.merge(NodeServices.layer, serverConfigLayer);
const testLayer = Layer.merge(makeTestLayer, ServerSettingsLive.pipe(Layer.provide(makeTestLayer)));

const runWithSettings = <A, E>(
  effect: Effect.Effect<A, E, ServerSettingsService | ServerConfig | FileSystem.FileSystem>,
) => Effect.runPromise(effect.pipe(Effect.provide(testLayer)) as Effect.Effect<A, E, never>);

describe("ServerSettingsService", () => {
  it("loads defaults when settings file does not exist", async () => {
    const settings = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        yield* service.start;
        return yield* service.getSettings;
      }),
    );

    expect(settings.providers.codex.binaryPath).toBe("codex");
    expect(settings.providers.grok.binaryPath).toBe("grok");
    expect(settings.defaultThreadEnvMode).toBe("local");
    expect(settings.enableProviderUpdateChecks).toBe(true);
  });

  it("persists updates and reloads them", async () => {
    const result = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const { settingsPath } = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* service.start;

        const updated = yield* service.updateSettings({
          enableAssistantStreaming: true,
          enableProviderUpdateChecks: false,
          providers: {
            codex: {
              binaryPath: "/usr/local/bin/codex",
              customModels: ["gpt-custom"],
            },
          },
        });
        const raw = yield* fs.readFileString(settingsPath);
        return { updated, parsed: JSON.parse(raw) as unknown };
      }),
    );

    expect(result.updated.enableAssistantStreaming).toBe(true);
    expect(result.updated.enableProviderUpdateChecks).toBe(false);
    expect(result.updated.providers.codex.binaryPath).toBe("/usr/local/bin/codex");
    expect(result.parsed).toMatchObject({
      enableAssistantStreaming: true,
      enableProviderUpdateChecks: false,
      providers: {
        codex: {
          binaryPath: "/usr/local/bin/codex",
          customModels: ["gpt-custom"],
        },
      },
    });
  });

  it("resolves text generation selection away from disabled providers", async () => {
    const settings = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        return yield* service.getSettings;
      }).pipe(
        Effect.provide(
          ServerSettingsService.layerTest({
            textGenerationModelSelection: {
              provider: "gemini",
              model: DEFAULT_MODEL_BY_PROVIDER.gemini,
            },
            providers: {
              gemini: { enabled: false },
            },
          }),
        ),
      ),
    );

    expect(settings.textGenerationModelSelection.provider).toBe("codex");
    expect(settings.textGenerationModelSelection.model).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
  });
});

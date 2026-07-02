import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_MODEL_BY_PROVIDER, DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import {
  deriveProviderInstances,
  providerStartOptionsFromInstance,
} from "@t3tools/shared/providerInstances";
import { Effect, FileSystem, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { ServerConfig } from "./config";
import {
  redactServerSettingsForClient,
  ServerSettingsLive,
  ServerSettingsService,
} from "./serverSettings";

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "dpcode-settings-test-",
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
              instanceId: "gemini",
              model: DEFAULT_MODEL_BY_PROVIDER.gemini,
            },
            providers: {
              gemini: { enabled: false },
            },
          }),
        ),
      ),
    );

    expect(settings.textGenerationModelSelection.instanceId).toBe("codex");
    expect(settings.textGenerationModelSelection.model).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
  });

  it("keeps enabled text generation provider instances even when the legacy provider is disabled", async () => {
    const settings = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        return yield* service.getSettings;
      }).pipe(
        Effect.provide(
          ServerSettingsService.layerTest({
            textGenerationModelSelection: {
              instanceId: "claude_work",
              model: DEFAULT_MODEL_BY_PROVIDER.claudeAgent,
            },
            providers: {
              claudeAgent: { enabled: false },
            },
            providerInstances: {
              claude_work: {
                driver: "claudeAgent",
                enabled: true,
                config: { homePath: "/tmp/claude-work" },
              },
            },
          }),
        ),
      ),
    );

    expect(settings.textGenerationModelSelection).toMatchObject({
      instanceId: "claude_work",
      model: DEFAULT_MODEL_BY_PROVIDER.claudeAgent,
    });
  });

  it("resolves text generation patches through the selected provider instance", async () => {
    const settings = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        return yield* service.updateSettings({
          providerInstances: {
            work: {
              driver: "claudeAgent",
              enabled: true,
              config: { homePath: "/tmp/claude-work" },
            },
          },
          textGenerationModelSelection: {
            instanceId: "work",
            model: "custom-model",
          },
        });
      }).pipe(Effect.provide(ServerSettingsService.layerTest())),
    );

    expect(settings.textGenerationModelSelection).toMatchObject({
      instanceId: "work",
      model: "custom-model",
    });
  });

  it("maps legacy provider-only text generation patches to the provider default instance", async () => {
    const settings = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        yield* service.updateSettings({
          providerInstances: {
            codex_work: {
              driver: "codex",
              enabled: true,
              config: { homePath: "/tmp/codex-work" },
            },
          },
          textGenerationModelSelection: {
            instanceId: "codex_work",
            model: "custom-work-model",
          },
        });
        return yield* service.updateSettings({
          textGenerationModelSelection: {
            provider: "codex",
            model: "gpt-5.4",
          },
        });
      }).pipe(Effect.provide(ServerSettingsService.layerTest())),
    );

    expect(settings.textGenerationModelSelection).toMatchObject({
      instanceId: "codex",
      model: "gpt-5.4",
    });
  });

  it("falls back from disabled text generation instances to a supported enabled instance", async () => {
    const settings = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        return yield* service.getSettings;
      }).pipe(
        Effect.provide(
          ServerSettingsService.layerTest({
            textGenerationModelSelection: {
              instanceId: "claude_work",
              model: DEFAULT_MODEL_BY_PROVIDER.claudeAgent,
            },
            providers: {
              codex: { enabled: false },
              claudeAgent: { enabled: false },
            },
            providerInstances: {
              claude_work: {
                driver: "claudeAgent",
                enabled: false,
                config: { homePath: "/tmp/claude-work" },
              },
              // Enabled, but gemini has no text-generation implementation, so
              // the fallback must skip it for a supported driver.
              gemini_work: {
                driver: "gemini",
                enabled: true,
                config: { binaryPath: "gemini" },
              },
            },
          }),
        ),
      ),
    );

    expect(settings.textGenerationModelSelection).toMatchObject({
      instanceId: "cursor",
      model: DEFAULT_MODEL_BY_PROVIDER.cursor,
    });
  });

  it("replaces the providerInstances map on settings updates", async () => {
    const settings = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        yield* service.updateSettings({
          providerInstances: {
            claude_work: {
              driver: "claudeAgent",
              enabled: true,
              config: { homePath: "/tmp/claude-work" },
            },
            codex_work: {
              driver: "codex",
              enabled: true,
              config: { homePath: "/tmp/codex-work" },
            },
          },
        });
        return yield* service.updateSettings({
          providerInstances: {
            claude_work: {
              driver: "claudeAgent",
              enabled: true,
              config: { homePath: "/tmp/claude-work-2" },
            },
          },
        });
      }).pipe(Effect.provide(ServerSettingsService.layerTest())),
    );

    expect(settings.providerInstances.claude_work?.config).toMatchObject({
      homePath: "/tmp/claude-work-2",
    });
    expect(settings.providerInstances.codex_work).toBeUndefined();
  });

  it("redacts sensitive provider-instance environment and config values for clients", () => {
    const settings = redactServerSettingsForClient({
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        grok_work: {
          driver: "grok",
          enabled: true,
          environment: [{ name: "XAI_API_KEY", value: "secret-token", sensitive: true }],
          config: { binaryPath: "/opt/grok" },
        },
        opencode_work: {
          driver: "opencode",
          enabled: true,
          config: {
            serverUrl: "http://127.0.0.1:4096",
            serverPassword: "opencode-secret",
          },
        },
      },
    });

    expect(settings.providerInstances.grok_work?.environment).toEqual([
      { name: "XAI_API_KEY", value: "", sensitive: true, valueRedacted: true },
    ]);
    expect(settings.providerInstances.opencode_work?.config).toEqual({
      serverUrl: "http://127.0.0.1:4096",
      serverPassword: "",
      serverPasswordRedacted: true,
    });
  });

  it("preserves redacted provider-instance environment values on writeback", async () => {
    const settings = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        yield* service.updateSettings({
          providerInstances: {
            grok_work: {
              driver: "grok",
              enabled: true,
              environment: [{ name: "XAI_API_KEY", value: "secret-token", sensitive: true }],
              config: { binaryPath: "/opt/grok" },
            },
          },
        });
        return yield* service.updateSettings({
          providerInstances: {
            grok_work: {
              driver: "grok",
              displayName: "Grok Work",
              enabled: true,
              environment: [
                { name: "XAI_API_KEY", value: "", sensitive: true, valueRedacted: true },
              ],
              config: { binaryPath: "/opt/grok" },
            },
          },
        });
      }).pipe(Effect.provide(ServerSettingsService.layerTest())),
    );

    expect(settings.providerInstances.grok_work?.environment).toEqual([
      { name: "XAI_API_KEY", value: "secret-token", sensitive: true },
    ]);
    const grokWork = deriveProviderInstances(settings).find(
      (instance) => instance.instanceId === "grok_work",
    );
    expect(grokWork).toBeDefined();
    expect(grokWork ? providerStartOptionsFromInstance(grokWork) : undefined).toMatchObject({
      grok: { environment: { XAI_API_KEY: "secret-token" } },
    });
    expect(
      redactServerSettingsForClient(settings).providerInstances.grok_work?.environment,
    ).toEqual([{ name: "XAI_API_KEY", value: "", sensitive: true, valueRedacted: true }]);
  });

  it("persists sensitive provider-instance environment values in the secret store", async () => {
    const result = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const { settingsPath } = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* service.start;

        const updated = yield* service.updateSettings({
          providerInstances: {
            grok_work: {
              driver: "grok",
              enabled: true,
              environment: [{ name: "XAI_API_KEY", value: "secret-token", sensitive: true }],
            },
          },
        });
        const raw = yield* fs.readFileString(settingsPath);
        return { updated, parsed: JSON.parse(raw) as any, raw };
      }),
    );

    expect(result.raw).not.toContain("secret-token");
    expect(result.updated.providerInstances.grok_work?.environment).toEqual([
      { name: "XAI_API_KEY", value: "secret-token", sensitive: true },
    ]);
    expect(result.parsed.providerInstances.grok_work.environment).toEqual([
      { name: "XAI_API_KEY", value: "", sensitive: true, valueRedacted: true },
    ]);
  });

  it("preserves redacted provider-instance config secrets on writeback", async () => {
    const settings = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        yield* service.updateSettings({
          providerInstances: {
            opencode_work: {
              driver: "opencode",
              enabled: true,
              config: {
                serverUrl: "http://127.0.0.1:4096",
                serverPassword: "opencode-secret",
              },
            },
          },
        });
        return yield* service.updateSettings({
          providerInstances: {
            opencode_work: {
              driver: "opencode",
              displayName: "OpenCode Work",
              enabled: true,
              config: {
                serverUrl: "http://127.0.0.1:4096",
                serverPassword: "",
                serverPasswordRedacted: true,
              },
            },
          },
        });
      }).pipe(Effect.provide(ServerSettingsService.layerTest())),
    );

    expect(settings.providerInstances.opencode_work?.config).toEqual({
      serverUrl: "http://127.0.0.1:4096",
      serverPassword: "opencode-secret",
    });
    expect(redactServerSettingsForClient(settings).providerInstances.opencode_work?.config).toEqual(
      {
        serverUrl: "http://127.0.0.1:4096",
        serverPassword: "",
        serverPasswordRedacted: true,
      },
    );
  });

  it("persists sensitive provider-instance config values in the secret store", async () => {
    const result = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const { settingsPath } = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* service.start;

        const updated = yield* service.updateSettings({
          providerInstances: {
            opencode_work: {
              driver: "opencode",
              enabled: true,
              config: {
                serverUrl: "http://127.0.0.1:4096",
                serverPassword: "opencode-secret",
              },
            },
          },
        });
        const raw = yield* fs.readFileString(settingsPath);
        return { updated, parsed: JSON.parse(raw) as any, raw };
      }),
    );

    expect(result.raw).not.toContain("opencode-secret");
    expect(result.updated.providerInstances.opencode_work?.config).toEqual({
      serverUrl: "http://127.0.0.1:4096",
      serverPassword: "opencode-secret",
    });
    expect(result.parsed.providerInstances.opencode_work.config).toEqual({
      serverUrl: "http://127.0.0.1:4096",
      serverPassword: "",
      serverPasswordRedacted: true,
    });
  });
});

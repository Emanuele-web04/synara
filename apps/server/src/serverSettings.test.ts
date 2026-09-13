import * as NodeServices from "@effect/platform-node/NodeServices";
import { dirname } from "node:path";
import {
  DEFAULT_DROID_GIT_TEXT_GENERATION_MODEL,
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
} from "@synara/contracts";
import {
  deriveProviderInstances,
  providerStartOptionsFromInstance,
} from "@synara/shared/providerInstances";
import { Effect, FileSystem, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { ServerConfig } from "./config";
import {
  redactServerSettingsForClient,
  ServerSettingsLive,
  ServerSettingsService,
} from "./serverSettings";

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
              enabled: false,
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
    expect(result.updated.providers.codex.enabled).toBe(false);
    expect(result.updated.providers.codex.binaryPath).toBe("/usr/local/bin/codex");
    expect(result.parsed).toMatchObject({
      revision: 1,
      migrationVersion: 2,
      settings: {
        enableAssistantStreaming: true,
        enableProviderUpdateChecks: false,
        providers: {
          codex: {
            enabled: false,
            binaryPath: "/usr/local/bin/codex",
            customModels: ["gpt-custom"],
          },
        },
      },
    });
  });

  it("migrates the previous Git writing default to GPT-5.6 Luna", async () => {
    const result = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const { settingsPath } = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(dirname(settingsPath), { recursive: true });
        yield* fs.writeFileString(
          settingsPath,
          JSON.stringify({
            revision: 7,
            migrationVersion: 1,
            settings: {
              textGenerationModelSelection: {
                provider: "codex",
                model: "gpt-5.4-mini",
              },
            },
          }),
        );

        yield* service.start;
        const settings = yield* service.getSettings;
        const persisted = JSON.parse(yield* fs.readFileString(settingsPath)) as {
          migrationVersion: number;
          settings: { textGenerationModelSelection: { model: string } };
        };
        return { settings, persisted };
      }),
    );

    expect(result.settings.textGenerationModelSelection.model).toBe(
      DEFAULT_GIT_TEXT_GENERATION_MODEL,
    );
    expect(result.persisted.migrationVersion).toBe(2);
    expect(result.persisted.settings.textGenerationModelSelection.model).toBe(
      DEFAULT_GIT_TEXT_GENERATION_MODEL,
    );
  });

  it("migrates a removed Kilo text-generation selection to OpenCode", async () => {
    const result = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const { settingsPath } = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(dirname(settingsPath), { recursive: true });
        yield* fs.writeFileString(
          settingsPath,
          JSON.stringify({
            revision: 3,
            migrationVersion: 2,
            settings: {
              enableProviderUpdateChecks: false,
              textGenerationModelSelection: {
                provider: "kilo",
                model: "kilo/kilo-auto/free",
              },
              providers: {
                kilo: {
                  enabled: true,
                  binaryPath: "/opt/kilo",
                  serverUrl: "http://127.0.0.1:4096",
                  customModels: ["provider/shared-model"],
                },
                opencode: {
                  enabled: false,
                  binaryPath: "/opt/opencode",
                  customModels: ["provider/opencode-model"],
                },
              },
            },
          }),
        );

        yield* service.start;
        const settings = yield* service.getSettings;
        const settingsFileExists = yield* fs.exists(settingsPath);
        return { settings, settingsFileExists };
      }),
    );

    // The rest of the settings and the OpenCode-compatible model survive.
    expect(result.settingsFileExists).toBe(true);
    expect(result.settings.enableProviderUpdateChecks).toBe(false);
    expect(result.settings.textGenerationModelSelection).toMatchObject({
      provider: "opencode",
      model: "kilo/kilo-auto/free",
    });
    expect(result.settings.providers.opencode).toMatchObject({
      enabled: true,
      binaryPath: "/opt/opencode",
      customModels: ["provider/opencode-model", "provider/shared-model"],
    });
    expect(result.settings.providers.opencode.serverUrl).toBe("");
  });

  it("keeps provider passwords server-only and returns configured flags to clients", async () => {
    const result = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const { settingsPath } = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* service.start;
        const view = yield* service.updateSettingsView({
          providers: {
            opencode: { serverPassword: "opencode-secret" },
          },
        });
        const internal = yield* service.getSettings;
        const persisted = yield* fs.readFileString(settingsPath);
        return { view, internal, persisted };
      }),
    );

    expect(result.internal.providers.opencode.serverPasswordConfigured).toBe(true);
    expect(result.view.providers.opencode).toMatchObject({ serverPasswordConfigured: true });
    expect(JSON.stringify(result.internal)).not.toContain("opencode-secret");
    expect(JSON.stringify(result.view)).not.toContain("opencode-secret");
    expect(JSON.stringify(result.view)).not.toContain('"serverPassword"');
    expect(result.persisted).not.toContain("opencode-secret");
  });

  it.each([
    {
      name: "resolves text generation selection away from disabled providers",
      overrides: {
        textGenerationModelSelection: {
          provider: "antigravity" as const,
          model: DEFAULT_MODEL_BY_PROVIDER.antigravity,
        },
        providers: { antigravity: { enabled: false } },
      },
      expectedProvider: "codex" as const,
    },
    {
      name: "falls back only to providers with dedicated Git text generation",
      overrides: {
        textGenerationModelSelection: {
          provider: "codex" as const,
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
        },
        providers: {
          codex: { enabled: false },
          claudeAgent: { enabled: true },
          cursor: { enabled: false },
          opencode: { enabled: true },
        },
      },
      expectedProvider: "opencode" as const,
    },
    {
      name: "normalizes enabled but unsupported Git text generation selections",
      overrides: {
        textGenerationModelSelection: {
          provider: "claudeAgent" as const,
          model: DEFAULT_MODEL_BY_PROVIDER.claudeAgent,
        },
      },
      expectedProvider: "codex" as const,
    },
    {
      name: "falls back to droid when all ordered providers are disabled",
      overrides: {
        textGenerationModelSelection: {
          provider: "opencode" as const,
          model: DEFAULT_MODEL_BY_PROVIDER.opencode,
        },
        providers: {
          codex: { enabled: false },
          cursor: { enabled: false },
          opencode: { enabled: false },
          droid: { enabled: true },
        },
      },
      expectedProvider: "droid" as const,
    },
  ])("$name", async ({ overrides, expectedProvider }) => {
    const settings = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        return yield* service.getSettings;
      }).pipe(Effect.provide(ServerSettingsService.layerTest(overrides))),
    );

    expect(settings.textGenerationModelSelection.provider).toBe(expectedProvider);
    expect(settings.textGenerationModelSelection.model).toBe(
      expectedProvider === "droid"
        ? DEFAULT_DROID_GIT_TEXT_GENERATION_MODEL
        : DEFAULT_MODEL_BY_PROVIDER[expectedProvider],
    );
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
              provider: "claudeAgent",
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
      provider: "claudeAgent",
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
            provider: "codex",
            instanceId: "work",
            model: "custom-model",
          },
        });
      }).pipe(Effect.provide(ServerSettingsService.layerTest())),
    );

    expect(settings.textGenerationModelSelection).toMatchObject({
      provider: "claudeAgent",
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
              provider: "claudeAgent",
              instanceId: "claude_work",
              model: DEFAULT_MODEL_BY_PROVIDER.claudeAgent,
            },
            providers: {
              codex: { enabled: false },
              claudeAgent: { enabled: false },
              cursor: { enabled: false },
            },
            providerInstances: {
              claude_work: {
                driver: "claudeAgent",
                enabled: false,
                config: { homePath: "/tmp/claude-work" },
              },
              // Enabled, but Gemini has no text-generation implementation, so
              // fallback must continue to the next supported driver.
              gemini_work: {
                driver: "gemini",
                enabled: true,
                config: { binaryPath: "gemini" },
              },
              cursor_work: {
                driver: "cursor",
                enabled: true,
                config: { binaryPath: "cursor-agent" },
              },
            },
          }),
        ),
      ),
    );

    expect(settings.textGenerationModelSelection).toMatchObject({
      provider: "cursor",
      instanceId: "cursor_work",
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

  it("persists sensitive provider-instance environment values outside settings.json", async () => {
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
        return { updated, persisted: JSON.parse(raw) as unknown, raw };
      }),
    );

    expect(result.raw).not.toContain("secret-token");
    expect(result.updated.providerInstances.grok_work?.environment).toEqual([
      { name: "XAI_API_KEY", value: "secret-token", sensitive: true },
    ]);
    expect(result.persisted).toMatchObject({
      settings: {
        providerInstances: {
          grok_work: {
            environment: [
              { name: "XAI_API_KEY", value: "", sensitive: true, valueRedacted: true },
            ],
          },
        },
      },
    });
  });

  it("forces known provider credential environment variables into secret storage", async () => {
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
              environment: [{ name: "XAI_API_KEY", value: "secret-token", sensitive: false }],
            },
          },
        });
        const raw = yield* fs.readFileString(settingsPath);
        return { updated, raw };
      }),
    );

    expect(result.raw).not.toContain("secret-token");
    expect(result.updated.providerInstances.grok_work?.environment).toEqual([
      { name: "XAI_API_KEY", value: "secret-token", sensitive: true },
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

  it("migrates plaintext provider-instance secrets from disk into redacted settings", async () => {
    const result = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const { settingsPath } = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(settingsPath.slice(0, settingsPath.lastIndexOf("/")), {
          recursive: true,
        });
        yield* fs.writeFileString(
          settingsPath,
          JSON.stringify({
            ...DEFAULT_SERVER_SETTINGS,
            providerInstances: {
              grok_work: {
                driver: "grok",
                enabled: true,
                environment: [{ name: "XAI_API_KEY", value: "secret-token", sensitive: true }],
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
          }),
        );

        yield* service.start;
        const settings = yield* service.getSettings;
        const raw = yield* fs.readFileString(settingsPath);
        return { settings, parsed: JSON.parse(raw) as any, raw };
      }),
    );

    expect(result.settings.providerInstances.grok_work?.environment).toEqual([
      { name: "XAI_API_KEY", value: "secret-token", sensitive: true },
    ]);
    expect(result.settings.providerInstances.opencode_work?.config).toEqual({
      serverUrl: "http://127.0.0.1:4096",
      serverPassword: "opencode-secret",
    });
    expect(result.raw).not.toContain("secret-token");
    expect(result.raw).not.toContain("opencode-secret");
    expect(result.parsed.providerInstances.grok_work.environment).toEqual([
      { name: "XAI_API_KEY", value: "", sensitive: true, valueRedacted: true },
    ]);
    expect(result.parsed.providerInstances.opencode_work.config).toEqual({
      serverUrl: "http://127.0.0.1:4096",
      serverPassword: "",
      serverPasswordRedacted: true,
    });
  });
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_MODEL_BY_PROVIDER, DEFAULT_SERVER_SETTINGS } from "@synara/contracts";
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
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        kilo: {
          ...DEFAULT_SERVER_SETTINGS.providers.kilo,
          serverUrl: "http://127.0.0.1:4097",
          serverPassword: "kilo-secret",
          serverPasswordSecretRef: "provider-secret-v2-internal-kilo",
        },
        opencode: {
          ...DEFAULT_SERVER_SETTINGS.providers.opencode,
          serverUrl: "http://127.0.0.1:4098",
          serverPassword: "legacy-opencode-secret",
          serverPasswordSecretRef: "provider-secret-v2-internal-opencode",
        },
      },
      providerInstances: {
        grok_work: {
          driver: "grok",
          enabled: true,
          environment: [
            {
              name: "XAI_API_KEY",
              value: "secret-token",
              sensitive: true,
              valueSecretRef: "provider-secret-v2-internal-environment",
            },
          ],
          config: { binaryPath: "/opt/grok" },
        },
        opencode_work: {
          driver: "opencode",
          enabled: true,
          config: {
            serverUrl: "http://127.0.0.1:4096",
            serverPassword: "opencode-secret",
            serverPasswordSecretRef: "provider-secret-v2-internal-config",
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
    expect(settings.providers.kilo).toMatchObject({
      serverUrl: "http://127.0.0.1:4097",
      serverPassword: "",
      serverPasswordRedacted: true,
    });
    expect(settings.providers.opencode).toMatchObject({
      serverUrl: "http://127.0.0.1:4098",
      serverPassword: "",
      serverPasswordRedacted: true,
    });
    expect(settings.providers.kilo.serverPasswordSecretRef).toBeUndefined();
    expect(settings.providers.opencode.serverPasswordSecretRef).toBeUndefined();
  });

  it("preserves redacted legacy server passwords on writeback", async () => {
    const settings = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        yield* service.updateSettings({
          providers: {
            opencode: {
              serverUrl: "http://127.0.0.1:4096",
              serverPassword: "opencode-secret",
            },
          },
        });
        return yield* service.updateSettings({
          providers: {
            opencode: {
              serverUrl: "http://127.0.0.1:4097",
              serverPassword: "",
              serverPasswordRedacted: true,
            },
          },
        });
      }).pipe(Effect.provide(ServerSettingsService.layerTest())),
    );

    expect(settings.providers.opencode).toMatchObject({
      serverUrl: "http://127.0.0.1:4097",
      serverPassword: "opencode-secret",
    });
    expect(redactServerSettingsForClient(settings).providers.opencode).toMatchObject({
      serverUrl: "http://127.0.0.1:4097",
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
      {
        name: "XAI_API_KEY",
        value: "",
        sensitive: true,
        valueRedacted: true,
        valueSecretRef: expect.stringMatching(/^provider-secret-v2-/),
      },
    ]);
  });

  it("persists legacy server passwords in the secret store", async () => {
    const result = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const { settingsPath } = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* service.start;

        const updated = yield* service.updateSettings({
          providers: {
            kilo: {
              serverUrl: "http://127.0.0.1:4097",
              serverPassword: "kilo-secret",
            },
            opencode: {
              serverUrl: "http://127.0.0.1:4098",
              serverPassword: "opencode-secret",
            },
          },
        });
        const raw = yield* fs.readFileString(settingsPath);
        return { updated, parsed: JSON.parse(raw) as any, raw };
      }),
    );

    expect(result.raw).not.toContain("kilo-secret");
    expect(result.raw).not.toContain("opencode-secret");
    expect(result.updated.providers.kilo.serverPassword).toBe("kilo-secret");
    expect(result.updated.providers.opencode.serverPassword).toBe("opencode-secret");
    expect(result.parsed.providers.kilo).toMatchObject({
      serverUrl: "http://127.0.0.1:4097",
      serverPassword: "",
      serverPasswordRedacted: true,
      serverPasswordSecretRef: expect.stringMatching(/^provider-secret-v2-/),
    });
    expect(result.parsed.providers.opencode).toMatchObject({
      serverUrl: "http://127.0.0.1:4098",
      serverPassword: "",
      serverPasswordRedacted: true,
      serverPasswordSecretRef: expect.stringMatching(/^provider-secret-v2-/),
    });
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
      serverPasswordSecretRef: expect.stringMatching(/^provider-secret-v2-/),
    });
  });

  it("materializes versioned secret references from disk", async () => {
    const settings = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const { secretsDir, settingsPath } = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const legacyRef = "provider-secret-v2-fixture-legacy";
        const environmentRef = "provider-secret-v2-fixture-environment";
        const configRef = "provider-secret-v2-fixture-config";

        yield* fs.makeDirectory(secretsDir, { recursive: true });
        yield* fs.writeFileString(`${secretsDir}/${legacyRef}.bin`, "legacy-secret");
        yield* fs.writeFileString(`${secretsDir}/${environmentRef}.bin`, "environment-secret");
        yield* fs.writeFileString(`${secretsDir}/${configRef}.bin`, "config-secret");
        yield* fs.writeFileString(
          settingsPath,
          JSON.stringify({
            ...DEFAULT_SERVER_SETTINGS,
            providers: {
              ...DEFAULT_SERVER_SETTINGS.providers,
              opencode: {
                ...DEFAULT_SERVER_SETTINGS.providers.opencode,
                serverPassword: "",
                serverPasswordRedacted: true,
                serverPasswordSecretRef: legacyRef,
              },
            },
            providerInstances: {
              grok_work: {
                driver: "grok",
                enabled: true,
                environment: [
                  {
                    name: "XAI_API_KEY",
                    value: "",
                    sensitive: true,
                    valueRedacted: true,
                    valueSecretRef: environmentRef,
                  },
                ],
              },
              opencode_work: {
                driver: "opencode",
                enabled: true,
                config: {
                  serverPassword: "",
                  serverPasswordRedacted: true,
                  serverPasswordSecretRef: configRef,
                },
              },
            },
          }),
        );

        yield* service.start;
        return yield* service.getSettings;
      }),
    );

    expect(settings.providers.opencode.serverPassword).toBe("legacy-secret");
    expect(settings.providerInstances.grok_work?.environment).toEqual([
      { name: "XAI_API_KEY", value: "environment-secret", sensitive: true },
    ]);
    expect(settings.providerInstances.opencode_work?.config).toEqual({
      serverPassword: "config-secret",
    });
  });

  it("preserves redacted secrets while migrating neighboring plaintext", async () => {
    const result = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const { secretsDir, settingsPath } = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const stableConfigRef = [
          "provider-config",
          Buffer.from("opencode_work", "utf8").toString("base64url"),
          Buffer.from("serverPassword", "utf8").toString("base64url"),
        ].join("-");

        yield* fs.makeDirectory(secretsDir, { recursive: true });
        yield* fs.writeFileString(`${secretsDir}/${stableConfigRef}.bin`, "preserved-secret");
        yield* fs.writeFileString(
          settingsPath,
          JSON.stringify({
            ...DEFAULT_SERVER_SETTINGS,
            providerInstances: {
              grok_work: {
                driver: "grok",
                enabled: true,
                environment: [{ name: "XAI_API_KEY", value: "plaintext-trigger", sensitive: true }],
              },
              opencode_work: {
                driver: "opencode",
                enabled: true,
                config: {
                  serverPassword: "",
                  serverPasswordRedacted: true,
                },
              },
            },
          }),
        );

        yield* service.start;
        const settings = yield* service.getSettings;
        const parsed = JSON.parse(yield* fs.readFileString(settingsPath)) as any;
        const stableSecretStillExists = yield* fs.exists(`${secretsDir}/${stableConfigRef}.bin`);
        return { parsed, settings, stableSecretStillExists };
      }),
    );

    expect(result.settings.providerInstances.opencode_work?.config).toEqual({
      serverPassword: "preserved-secret",
    });
    expect(result.parsed.providerInstances.opencode_work.config).toMatchObject({
      serverPassword: "",
      serverPasswordRedacted: true,
      serverPasswordSecretRef: expect.stringMatching(/^provider-secret-v2-/),
    });
    expect(result.stableSecretStillExists).toBe(false);
  });

  it("keeps old referenced secrets intact when the settings commit fails", async () => {
    const patchFor = (suffix: "old" | "new") => ({
      providers: {
        opencode: {
          serverPassword: `legacy-${suffix}`,
        },
      },
      providerInstances: {
        grok_work: {
          driver: "grok" as const,
          enabled: true,
          environment: [
            {
              name: "XAI_API_KEY",
              value: `environment-${suffix}`,
              sensitive: true,
            },
          ],
        },
        opencode_work: {
          driver: "opencode" as const,
          enabled: true,
          config: {
            serverPassword: `config-${suffix}`,
          },
        },
      },
    });

    const result = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const { secretsDir, settingsPath } = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const stateDir = settingsPath.slice(0, settingsPath.lastIndexOf("/"));
        const readSecretFiles = () =>
          Effect.gen(function* () {
            const files = yield* fs.readDirectory(secretsDir);
            const values: Record<string, string> = {};
            for (const file of files) {
              if (!file.endsWith(".bin")) continue;
              values[file.slice(0, -4)] = yield* fs.readFileString(`${secretsDir}/${file}`);
            }
            return values;
          });

        yield* service.start;
        yield* service.updateSettings(patchFor("old"));
        const rawBefore = yield* fs.readFileString(settingsPath);
        const parsedBefore = JSON.parse(rawBefore) as any;
        const oldRefs = [
          parsedBefore.providers.opencode.serverPasswordSecretRef,
          parsedBefore.providerInstances.grok_work.environment[0].valueSecretRef,
          parsedBefore.providerInstances.opencode_work.config.serverPasswordSecretRef,
        ] as string[];

        yield* fs.chmod(stateDir, 0o500);
        const failedExit = yield* Effect.exit(service.updateSettings(patchFor("new"))).pipe(
          Effect.ensuring(fs.chmod(stateDir, 0o700).pipe(Effect.orDie)),
        );
        const rawAfterFailedWrite = yield* fs.readFileString(settingsPath);
        const settingsAfterFailedWrite = yield* service.getSettings;
        const secretsAfterFailedWrite = yield* readSecretFiles();

        yield* service.updateSettings(patchFor("new"));
        const parsedAfterRetry = JSON.parse(yield* fs.readFileString(settingsPath)) as any;
        const secretsAfterRetry = yield* readSecretFiles();

        return {
          failedExit,
          oldRefs,
          parsedAfterRetry,
          rawAfterFailedWrite,
          rawBefore,
          secretsAfterFailedWrite,
          secretsAfterRetry,
          settingsAfterFailedWrite,
        };
      }),
    );

    expect(result.failedExit._tag).toBe("Failure");
    expect(result.rawAfterFailedWrite).toBe(result.rawBefore);
    expect(result.settingsAfterFailedWrite.providers.opencode.serverPassword).toBe("legacy-old");
    expect(
      result.settingsAfterFailedWrite.providerInstances.grok_work?.environment?.[0]?.value,
    ).toBe("environment-old");
    expect(result.settingsAfterFailedWrite.providerInstances.opencode_work?.config).toMatchObject({
      serverPassword: "config-old",
    });

    const failedValues = Object.values(result.secretsAfterFailedWrite);
    expect(failedValues).toEqual(
      expect.arrayContaining(["legacy-old", "environment-old", "config-old"]),
    );
    expect(failedValues).not.toContain("legacy-new");
    expect(failedValues).not.toContain("environment-new");
    expect(failedValues).not.toContain("config-new");
    expect(result.secretsAfterFailedWrite[result.oldRefs[0]!]).toBe("legacy-old");
    expect(result.secretsAfterFailedWrite[result.oldRefs[1]!]).toBe("environment-old");
    expect(result.secretsAfterFailedWrite[result.oldRefs[2]!]).toBe("config-old");

    const newRefs = [
      result.parsedAfterRetry.providers.opencode.serverPasswordSecretRef,
      result.parsedAfterRetry.providerInstances.grok_work.environment[0].valueSecretRef,
      result.parsedAfterRetry.providerInstances.opencode_work.config.serverPasswordSecretRef,
    ] as string[];
    expect(newRefs[0]).not.toBe(result.oldRefs[0]);
    expect(newRefs[1]).not.toBe(result.oldRefs[1]);
    expect(newRefs[2]).not.toBe(result.oldRefs[2]);
    expect(result.secretsAfterRetry[result.oldRefs[0]!]).toBeUndefined();
    expect(result.secretsAfterRetry[result.oldRefs[1]!]).toBeUndefined();
    expect(result.secretsAfterRetry[result.oldRefs[2]!]).toBeUndefined();
    expect(result.secretsAfterRetry[newRefs[0]!]).toBe("legacy-new");
    expect(result.secretsAfterRetry[newRefs[1]!]).toBe("environment-new");
    expect(result.secretsAfterRetry[newRefs[2]!]).toBe("config-new");
  });

  it("retries obsolete versioned secret cleanup after a transient removal failure", async () => {
    const result = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const { secretsDir, settingsPath } = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;

        yield* service.start;
        yield* service.updateSettings({
          providers: { opencode: { serverPassword: "old-secret" } },
        });
        const parsed = JSON.parse(yield* fs.readFileString(settingsPath)) as any;
        const oldReference = parsed.providers.opencode.serverPasswordSecretRef as string;
        const oldPath = `${secretsDir}/${oldReference}.bin`;
        const blockerPath = `${oldPath}/blocker`;

        yield* fs.remove(oldPath);
        yield* fs.makeDirectory(oldPath);
        yield* fs.writeFileString(blockerPath, "block cleanup");

        const updated = yield* service.updateSettings({
          providers: { opencode: { serverPassword: "new-secret" } },
        });
        const blockedPathSurvived = yield* fs.exists(oldPath);

        yield* fs.remove(blockerPath);
        yield* fs.remove(oldPath, { recursive: true });
        yield* fs.writeFileString(oldPath, "stale-secret");
        yield* service.updateSettings({ enableAssistantStreaming: false });
        const stalePathSurvivedRetry = yield* fs.exists(oldPath);

        return { blockedPathSurvived, stalePathSurvivedRetry, updated };
      }),
    );

    expect(result.updated.providers.opencode.serverPassword).toBe("new-secret");
    expect(result.blockedPathSurvived).toBe(true);
    expect(result.stalePathSurvivedRetry).toBe(false);
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
            providers: {
              ...DEFAULT_SERVER_SETTINGS.providers,
              kilo: {
                ...DEFAULT_SERVER_SETTINGS.providers.kilo,
                serverUrl: "http://127.0.0.1:4097",
                serverPassword: "kilo-secret",
              },
            },
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
    expect(result.settings.providers.kilo).toMatchObject({
      serverUrl: "http://127.0.0.1:4097",
      serverPassword: "kilo-secret",
    });
    expect(result.raw).not.toContain("secret-token");
    expect(result.raw).not.toContain("opencode-secret");
    expect(result.raw).not.toContain("kilo-secret");
    expect(result.parsed.providerInstances.grok_work.environment).toEqual([
      {
        name: "XAI_API_KEY",
        value: "",
        sensitive: true,
        valueRedacted: true,
        valueSecretRef: expect.stringMatching(/^provider-secret-v2-/),
      },
    ]);
    expect(result.parsed.providerInstances.opencode_work.config).toEqual({
      serverUrl: "http://127.0.0.1:4096",
      serverPassword: "",
      serverPasswordRedacted: true,
      serverPasswordSecretRef: expect.stringMatching(/^provider-secret-v2-/),
    });
    expect(result.parsed.providers.kilo).toMatchObject({
      serverUrl: "http://127.0.0.1:4097",
      serverPassword: "",
      serverPasswordRedacted: true,
      serverPasswordSecretRef: expect.stringMatching(/^provider-secret-v2-/),
    });
  });
});

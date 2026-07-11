import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  ClaudeTextGeneration,
  CodexTextGeneration,
  CursorTextGeneration,
  KiloTextGeneration,
  OpenCodeTextGeneration,
  type TextGenerationShape,
  TextGeneration,
} from "../Services/TextGeneration.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderTextGenerationLive } from "./ProviderTextGeneration.ts";

function createTextGenerationDouble(label: string) {
  const generateCommitMessage = vi.fn<TextGenerationShape["generateCommitMessage"]>(() =>
    Effect.succeed({
      subject: `${label} commit`,
      body: "",
    }),
  );
  const generatePrContent = vi.fn<TextGenerationShape["generatePrContent"]>(() =>
    Effect.succeed({
      title: `${label} pr`,
      body: "",
    }),
  );
  const generateDiffSummary = vi.fn<TextGenerationShape["generateDiffSummary"]>(() =>
    Effect.succeed({
      summary: `${label} summary`,
    }),
  );
  const generateBranchName = vi.fn<TextGenerationShape["generateBranchName"]>(() =>
    Effect.succeed({
      branch: `${label}-branch`,
    }),
  );
  const generateThreadTitle = vi.fn<TextGenerationShape["generateThreadTitle"]>(() =>
    Effect.succeed({
      title: `${label} title`,
    }),
  );
  const generateThreadRecap = vi.fn<TextGenerationShape["generateThreadRecap"]>(() =>
    Effect.succeed({
      recap: `${label} recap`,
    }),
  );
  const generateAutomationIntent = vi.fn<TextGenerationShape["generateAutomationIntent"]>(() =>
    Effect.succeed({
      isAutomation: true,
      confidence: 1,
      language: null,
      name: `${label} automation`,
      taskPrompt: "Check the site",
      schedule: { type: "interval", everySeconds: 3600 },
      mode: "heartbeat",
      completionPolicy: { type: "none" },
      missingFields: [],
      needsConfirmation: false,
      reason: null,
    }),
  );
  const evaluateAutomationCompletion = vi.fn<TextGenerationShape["evaluateAutomationCompletion"]>(
    () =>
      Effect.succeed({
        stopMatched: false,
        confidence: 0.2,
        reason: `${label} completion`,
      }),
  );

  return {
    service: {
      generateCommitMessage,
      generatePrContent,
      generateDiffSummary,
      generateBranchName,
      generateThreadTitle,
      generateThreadRecap,
      generateAutomationIntent,
      evaluateAutomationCompletion,
    } satisfies TextGenerationShape,
    generateCommitMessage,
    generatePrContent,
    generateDiffSummary,
    generateBranchName,
    generateThreadTitle,
    generateThreadRecap,
    generateAutomationIntent,
    evaluateAutomationCompletion,
  };
}

function makeProviderTextGenerationTestLayer(
  settings: Parameters<typeof ServerSettingsService.layerTest>[0] = {},
) {
  const claude = createTextGenerationDouble("claude");
  const codex = createTextGenerationDouble("codex");
  const cursor = createTextGenerationDouble("cursor");
  const kilo = createTextGenerationDouble("kilo");
  const opencode = createTextGenerationDouble("opencode");
  const layer = ProviderTextGenerationLive.pipe(
    Layer.provide(Layer.succeed(ClaudeTextGeneration, claude.service)),
    Layer.provide(Layer.succeed(CodexTextGeneration, codex.service)),
    Layer.provide(Layer.succeed(CursorTextGeneration, cursor.service)),
    Layer.provide(Layer.succeed(KiloTextGeneration, kilo.service)),
    Layer.provide(Layer.succeed(OpenCodeTextGeneration, opencode.service)),
    Layer.provide(ServerSettingsService.layerTest(settings)),
  );

  return { layer, claude, codex, cursor, kilo, opencode };
}

describe("ProviderTextGenerationLive", () => {
  it("routes standard git-writing models to Codex", async () => {
    const { layer, codex, cursor, opencode } = makeProviderTextGenerationTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        return yield* textGeneration.generateDiffSummary({
          cwd: "/repo",
          patch: "diff --git a/file.ts b/file.ts",
          model: "gpt-5.4-mini",
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result.summary).toBe("codex summary");
    expect(codex.generateDiffSummary).toHaveBeenCalledTimes(1);
    expect(cursor.generateDiffSummary).not.toHaveBeenCalled();
    expect(opencode.generateDiffSummary).not.toHaveBeenCalled();
  });

  it("keeps canonical Codex text generation on Codex when settings try to retarget its id", async () => {
    const { layer, claude, codex } = makeProviderTextGenerationTestLayer({
      providerInstances: {
        codex: {
          driver: "claudeAgent",
          enabled: true,
          config: { binaryPath: "/malicious/claude" },
        },
      },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        return yield* textGeneration.generateDiffSummary({
          cwd: "/repo",
          patch: "diff --git a/file.ts b/file.ts",
          modelSelection: {
            instanceId: "codex",
            model: "gpt-5.4-mini",
          },
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result.summary).toBe("codex summary");
    expect(codex.generateDiffSummary).toHaveBeenCalledTimes(1);
    expect(claude.generateDiffSummary).not.toHaveBeenCalled();
  });

  it("routes OpenCode provider/model slugs to OpenCode", async () => {
    const { layer, codex, cursor, opencode } = makeProviderTextGenerationTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        return yield* textGeneration.generateDiffSummary({
          cwd: "/repo",
          patch: "diff --git a/file.ts b/file.ts",
          model: "openai/gpt-5",
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result.summary).toBe("opencode summary");
    expect(opencode.generateDiffSummary).toHaveBeenCalledTimes(1);
    expect(codex.generateDiffSummary).not.toHaveBeenCalled();
    expect(cursor.generateDiffSummary).not.toHaveBeenCalled();
  });

  it("routes explicit Kilo model selections through Kilo text generation", async () => {
    const { layer, codex, kilo, opencode } = makeProviderTextGenerationTestLayer();

    await Effect.runPromise(
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        yield* textGeneration.generateDiffSummary({
          cwd: "/repo",
          patch: "diff --git a/file.ts b/file.ts",
          modelSelection: {
            instanceId: "kilo",
            model: "kilo/kilo-auto/free",
          },
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(kilo.generateDiffSummary).toHaveBeenCalledTimes(1);
    expect(opencode.generateDiffSummary).not.toHaveBeenCalled();
    expect(codex.generateDiffSummary).not.toHaveBeenCalled();
  });

  it("routes explicit OpenCode model selections and preserves provider options", async () => {
    const { layer, codex, cursor, opencode } = makeProviderTextGenerationTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        return yield* textGeneration.generateThreadTitle({
          cwd: "/repo",
          message: "Plan the deployment work",
          modelSelection: {
            instanceId: "opencode",
            model: "openai/gpt-5",
            options: [
              { id: "agent", value: "plan" },
              { id: "variant", value: "balanced" },
            ],
          },
          providerOptions: {
            opencode: {
              binaryPath: "/custom/bin/opencode",
              serverUrl: "http://127.0.0.1:4096",
              serverPassword: "secret",
            },
          },
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result.title).toBe("opencode title");
    expect(opencode.generateThreadTitle).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSelection: expect.objectContaining({
          instanceId: "opencode",
          model: "openai/gpt-5",
          options: [
            { id: "agent", value: "plan" },
            { id: "variant", value: "balanced" },
          ],
        }),
        providerOptions: {
          opencode: {
            binaryPath: "/custom/bin/opencode",
            serverUrl: "http://127.0.0.1:4096",
            serverPassword: "secret",
          },
        },
      }),
    );
    expect(codex.generateThreadTitle).not.toHaveBeenCalled();
    expect(cursor.generateThreadTitle).not.toHaveBeenCalled();
  });

  it("routes explicit Cursor model selections and preserves provider options", async () => {
    const { layer, codex, cursor, opencode } = makeProviderTextGenerationTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        return yield* textGeneration.generateThreadTitle({
          cwd: "/repo",
          message: "Plan the Cursor integration work",
          modelSelection: {
            instanceId: "cursor",
            model: "composer-2",
            options: [
              { id: "reasoningEffort", value: "high" },
              { id: "fastMode", value: true },
            ],
          },
          providerOptions: {
            cursor: {
              binaryPath: "/custom/bin/agent",
              apiEndpoint: "http://127.0.0.1:3947",
            },
          },
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result.title).toBe("cursor title");
    expect(cursor.generateThreadTitle).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSelection: expect.objectContaining({
          instanceId: "cursor",
          model: "composer-2",
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "fastMode", value: true },
          ],
        }),
        providerOptions: {
          cursor: {
            binaryPath: "/custom/bin/agent",
            apiEndpoint: "http://127.0.0.1:3947",
          },
        },
      }),
    );
    expect(codex.generateThreadTitle).not.toHaveBeenCalled();
    expect(opencode.generateThreadTitle).not.toHaveBeenCalled();
  });

  it("routes automation intent generation through the selected provider", async () => {
    const { layer, codex, cursor, opencode } = makeProviderTextGenerationTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        return yield* textGeneration.generateAutomationIntent({
          cwd: "/repo",
          message: "every 6h check the Amazon listing",
          defaultMode: "heartbeat",
          nowIso: "2026-06-19T10:00:00.000Z",
          modelSelection: {
            instanceId: "cursor",
            model: "composer-2",
          },
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result.name).toBe("cursor automation");
    expect(cursor.generateAutomationIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "every 6h check the Amazon listing",
        defaultMode: "heartbeat",
      }),
    );
    expect(codex.generateAutomationIntent).not.toHaveBeenCalled();
    expect(opencode.generateAutomationIntent).not.toHaveBeenCalled();
  });

  it("routes automation completion evaluation through the selected provider", async () => {
    const { layer, codex, cursor, opencode } = makeProviderTextGenerationTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        return yield* textGeneration.evaluateAutomationCompletion({
          cwd: "/repo",
          automationName: "Watch PR",
          automationPrompt: "Check PR readiness.",
          stopWhen: "the PR is ready",
          runUserMessage: "Check PR readiness.",
          runAssistantText: "Still working.",
          modelSelection: {
            instanceId: "cursor",
            model: "composer-2",
          },
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result.reason).toBe("cursor completion");
    expect(cursor.evaluateAutomationCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        stopWhen: "the PR is ready",
      }),
    );
    expect(codex.evaluateAutomationCompletion).not.toHaveBeenCalled();
    expect(opencode.evaluateAutomationCompletion).not.toHaveBeenCalled();
  });

  it("routes text generation by exact provider instance and merges its provider options", async () => {
    const { layer, claude, codex } = makeProviderTextGenerationTestLayer({
      providerInstances: {
        claude_work: {
          driver: "claudeAgent",
          displayName: "Claude Work",
          enabled: true,
          environment: [{ name: "ANTHROPIC_AUTH_TOKEN", value: "work-token", sensitive: true }],
          config: {
            binaryPath: "/opt/claude",
            homePath: "/tmp/claude-work",
          },
        },
      },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        return yield* textGeneration.generateThreadTitle({
          cwd: "/repo",
          message: "Name the account-isolated work",
          modelSelection: {
            instanceId: "claude_work",
            model: "claude-sonnet-4",
          },
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result.title).toBe("claude title");
    expect(claude.generateThreadTitle).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-sonnet-4",
        modelSelection: expect.objectContaining({
          instanceId: "claude_work",
          model: "claude-sonnet-4",
        }),
        providerOptions: {
          claudeAgent: {
            binaryPath: "/opt/claude",
            homePath: "/tmp/claude-work",
            environment: { ANTHROPIC_AUTH_TOKEN: "work-token" },
          },
        },
      }),
    );
    expect(codex.generateThreadTitle).not.toHaveBeenCalled();
  });

  it("rejects disabled provider instances", async () => {
    const { layer, claude } = makeProviderTextGenerationTestLayer({
      providerInstances: {
        claude_disabled: {
          driver: "claudeAgent",
          enabled: false,
          config: {},
        },
      },
    });

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;
          return yield* textGeneration.generateThreadTitle({
            cwd: "/repo",
            message: "This should not run",
            modelSelection: {
              instanceId: "claude_disabled",
              model: "claude-sonnet-4",
            },
          });
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow("Provider instance 'claude_disabled' is disabled.");
    expect(claude.generateThreadTitle).not.toHaveBeenCalled();
  });
});

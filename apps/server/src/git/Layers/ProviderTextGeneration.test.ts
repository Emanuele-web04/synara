import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  CodexTextGeneration,
  CursorTextGeneration,
  OpenCodeTextGeneration,
  type TextGenerationShape,
  TextGeneration,
} from "../Services/TextGeneration.ts";
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

  return {
    service: {
      generateCommitMessage,
      generatePrContent,
      generateDiffSummary,
      generateBranchName,
      generateThreadTitle,
    } satisfies TextGenerationShape,
    generateCommitMessage,
    generatePrContent,
    generateDiffSummary,
    generateBranchName,
    generateThreadTitle,
  };
}

function makeProviderTextGenerationTestLayer() {
  const codex = createTextGenerationDouble("codex");
  const cursor = createTextGenerationDouble("cursor");
  const opencode = createTextGenerationDouble("opencode");
  const layer = ProviderTextGenerationLive.pipe(
    Layer.provide(Layer.succeed(CodexTextGeneration, codex.service)),
    Layer.provide(Layer.succeed(CursorTextGeneration, cursor.service)),
    Layer.provide(Layer.succeed(OpenCodeTextGeneration, opencode.service)),
  );

  return { layer, codex, cursor, opencode };
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

  it("routes explicit OpenCode model selections and preserves provider options", async () => {
    const { layer, codex, cursor, opencode } = makeProviderTextGenerationTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        return yield* textGeneration.generateThreadTitle({
          cwd: "/repo",
          message: "Plan the deployment work",
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5",
            options: {
              agent: "plan",
              variant: "balanced",
            },
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
        modelSelection: {
          provider: "opencode",
          model: "openai/gpt-5",
          options: {
            agent: "plan",
            variant: "balanced",
          },
        },
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
            provider: "cursor",
            model: "composer-2",
            options: {
              reasoningEffort: "high",
              fastMode: true,
            },
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
        modelSelection: {
          provider: "cursor",
          model: "composer-2",
          options: {
            reasoningEffort: "high",
            fastMode: true,
          },
        },
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
});

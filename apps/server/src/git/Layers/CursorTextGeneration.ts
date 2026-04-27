import { Effect, Layer, Option, Ref, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { CursorModelSelection, ProviderStartOptions } from "@t3tools/contracts";
import { sanitizeGeneratedThreadTitle } from "@t3tools/shared/chatThreads";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import {
  applyCursorAcpModelSelection,
  makeCursorAcpRuntime,
  type CursorAcpRuntimeCursorSettings,
} from "../../provider/acp/CursorAcpSupport.ts";
import { TextGenerationError } from "../Errors.ts";
import {
  CursorTextGeneration,
  type TextGenerationShape,
  TextGeneration,
} from "../Services/TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildDiffSummaryPrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
  extractJsonObject,
  sanitizeCommitSubject,
  sanitizeDiffSummary,
  sanitizePrTitle,
} from "../textGenerationShared.ts";

const CURSOR_TIMEOUT_MS = 180_000;

type CursorTextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateDiffSummary"
  | "generateBranchName"
  | "generateThreadTitle";

function mapCursorAcpError(
  operation: CursorTextGenerationOperation,
  detail: string,
  cause: unknown,
): TextGenerationError {
  return new TextGenerationError({
    operation,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function isTextGenerationError(error: unknown): error is TextGenerationError {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "TextGenerationError"
  );
}

function resolveCursorModelSelection(input: {
  readonly model?: string;
  readonly modelSelection?: { readonly provider: string; readonly model: string; readonly options?: unknown };
}): CursorModelSelection | null {
  if (input.modelSelection?.provider === "cursor") {
    return input.modelSelection as CursorModelSelection;
  }

  return null;
}

function resolveCursorSettings(
  providerOptions: ProviderStartOptions | undefined,
): CursorAcpRuntimeCursorSettings | undefined {
  const cursorOptions = providerOptions?.cursor;
  if (!cursorOptions) return undefined;
  return {
    ...(cursorOptions.binaryPath ? { binaryPath: cursorOptions.binaryPath } : {}),
    ...(cursorOptions.apiEndpoint ? { apiEndpoint: cursorOptions.apiEndpoint } : {}),
  };
}

const makeCursorTextGeneration = Effect.gen(function* () {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runCursorJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
    providerOptions,
  }: {
    operation: CursorTextGenerationOperation;
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: CursorModelSelection;
    providerOptions?: ProviderStartOptions;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const outputRef = yield* Ref.make("");
      const runtime = yield* makeCursorAcpRuntime({
        cursorSettings: resolveCursorSettings(providerOptions),
        childProcessSpawner: commandSpawner,
        cwd,
        clientInfo: { name: "dp-code-git-text", version: "0.0.0" },
      });

      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (update.sessionUpdate !== "agent_message_chunk") {
          return Effect.void;
        }
        const content = update.content;
        if (content.type !== "text") {
          return Effect.void;
        }
        return Ref.update(outputRef, (current) => current + content.text);
      });

      const promptResult = yield* Effect.gen(function* () {
        yield* runtime.start();
        yield* Effect.ignore(runtime.setMode("ask"));
        yield* applyCursorAcpModelSelection({
          runtime,
          model: modelSelection.model,
          options: modelSelection.options,
          mapError: ({ cause, configId, step }) =>
            mapCursorAcpError(
              operation,
              step === "set-config-option"
                ? `Failed to set Cursor ACP config option "${configId}" for text generation.`
                : "Failed to set Cursor ACP base model for text generation.",
              cause,
            ),
        });

        return yield* runtime.prompt({
          prompt: [{ type: "text", text: prompt }],
        });
      }).pipe(
        Effect.timeoutOption(CURSOR_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: "Cursor Agent request timed out.",
                }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : mapCursorAcpError(operation, "Cursor ACP request failed.", cause),
        ),
      );

      const rawResult = (yield* Ref.get(outputRef)).trim();
      if (!rawResult) {
        return yield* new TextGenerationError({
          operation,
          detail:
            promptResult.stopReason === "cancelled"
              ? "Cursor ACP request was cancelled."
              : "Cursor Agent returned empty output.",
        });
      }

      return yield* Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson))(
        extractJsonObject(rawResult),
      ).pipe(
        Effect.catchTag("SchemaError", (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Cursor Agent returned invalid structured output.",
              cause,
            }),
          ),
        ),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : mapCursorAcpError(operation, "Cursor ACP text generation failed.", cause),
      ),
      Effect.scoped,
    );

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "CursorTextGeneration.generateCommitMessage",
  )(function* (input) {
    const modelSelection = resolveCursorModelSelection(input);
    if (!modelSelection) {
      return yield* new TextGenerationError({
        operation: "generateCommitMessage",
        detail: "Invalid Cursor model selection.",
      });
    }

    const { prompt, outputSchemaJson } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });
    const generated = yield* runCursorJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      modelSelection,
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    });

    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "CursorTextGeneration.generatePrContent",
  )(function* (input) {
    const modelSelection = resolveCursorModelSelection(input);
    if (!modelSelection) {
      return yield* new TextGenerationError({
        operation: "generatePrContent",
        detail: "Invalid Cursor model selection.",
      });
    }

    const { prompt, outputSchemaJson } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });
    const generated = yield* runCursorJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      modelSelection,
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    });

    return {
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    };
  });

  const generateDiffSummary: TextGenerationShape["generateDiffSummary"] = Effect.fn(
    "CursorTextGeneration.generateDiffSummary",
  )(function* (input) {
    const modelSelection = resolveCursorModelSelection(input);
    if (!modelSelection) {
      return yield* new TextGenerationError({
        operation: "generateDiffSummary",
        detail: "Invalid Cursor model selection.",
      });
    }

    const { prompt, outputSchemaJson } = buildDiffSummaryPrompt({
      patch: input.patch,
    });
    const generated = yield* runCursorJson({
      operation: "generateDiffSummary",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      modelSelection,
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    });

    return {
      summary: sanitizeDiffSummary(generated.summary),
    };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "CursorTextGeneration.generateBranchName",
  )(function* (input) {
    const modelSelection = resolveCursorModelSelection(input);
    if (!modelSelection) {
      return yield* new TextGenerationError({
        operation: "generateBranchName",
        detail: "Invalid Cursor model selection.",
      });
    }

    const { prompt, outputSchemaJson } = buildBranchNamePrompt({
      message: input.message,
      ...(input.attachments ? { attachments: input.attachments } : {}),
    });
    const generated = yield* runCursorJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      modelSelection,
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    });

    return {
      branch: sanitizeBranchFragment(generated.branch),
    };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "CursorTextGeneration.generateThreadTitle",
  )(function* (input) {
    const modelSelection = resolveCursorModelSelection(input);
    if (!modelSelection) {
      return yield* new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "Invalid Cursor model selection.",
      });
    }

    const { prompt, outputSchemaJson } = buildThreadTitlePrompt({
      message: input.message,
      ...(input.attachments ? { attachments: input.attachments } : {}),
    });
    const generated = yield* runCursorJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      modelSelection,
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    });

    return {
      title: sanitizeGeneratedThreadTitle(generated.title),
    };
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateDiffSummary,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});

export const CursorTextGenerationServiceLive = Layer.effect(
  CursorTextGeneration,
  makeCursorTextGeneration,
);

export const CursorTextGenerationLive = Layer.effect(TextGeneration, makeCursorTextGeneration);

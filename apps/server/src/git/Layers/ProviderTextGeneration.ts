import type { ModelSelection, ProviderKind, ProviderStartOptions } from "@t3tools/contracts";
import {
  inferLegacyProviderKindFromModel,
  mergeProviderStartOptions,
  providerStartOptionsFromInstance,
  resolveModelSelectionInstanceId,
  resolveProviderInstance,
} from "@t3tools/shared/providerInstances";
import { Effect, Layer } from "effect";

import { ServerSettingsService } from "../../serverSettings.ts";
import { TextGenerationError } from "../Errors.ts";
import {
  ClaudeTextGeneration,
  CodexTextGeneration,
  CursorTextGeneration,
  KiloTextGeneration,
  OpenCodeTextGeneration,
  type TextGenerationOperation,
  type TextGenerationShape,
  TextGeneration,
} from "../Services/TextGeneration.ts";

interface RoutableTextGenerationInput {
  readonly model?: string;
  readonly modelSelection?: ModelSelection;
  readonly providerOptions?: ProviderStartOptions;
}

function inferTextGenerationProviderFromModel(model: string): ProviderKind {
  const inferredProvider = inferLegacyProviderKindFromModel(model);
  if (inferredProvider !== "codex") {
    return inferredProvider;
  }
  return model.includes("/") ? "opencode" : "codex";
}

function textGenerationModelSelectionForInput(
  input: RoutableTextGenerationInput,
  fallback: ModelSelection,
): ModelSelection {
  if (input.modelSelection) {
    return input.modelSelection;
  }
  if (input.model?.trim()) {
    const model = input.model.trim();
    return {
      instanceId: inferTextGenerationProviderFromModel(model),
      model,
    } as ModelSelection;
  }
  return fallback;
}

const makeProviderTextGeneration = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  const claudeTextGeneration = yield* ClaudeTextGeneration;
  const codexTextGeneration = yield* CodexTextGeneration;
  const cursorTextGeneration = yield* CursorTextGeneration;
  const kiloTextGeneration = yield* KiloTextGeneration;
  const openCodeTextGeneration = yield* OpenCodeTextGeneration;

  const implementationForDriver = (
    operation: TextGenerationOperation,
    driver: ProviderKind,
  ): Effect.Effect<TextGenerationShape, TextGenerationError> => {
    switch (driver) {
      case "claudeAgent":
        return Effect.succeed(claudeTextGeneration);
      case "codex":
        return Effect.succeed(codexTextGeneration);
      case "cursor":
        return Effect.succeed(cursorTextGeneration);
      case "kilo":
        return Effect.succeed(kiloTextGeneration);
      case "opencode":
        return Effect.succeed(openCodeTextGeneration);
      case "gemini":
      case "grok":
      case "pi":
        return Effect.fail(
          new TextGenerationError({
            operation,
            detail: `Provider '${driver}' does not support text generation yet.`,
          }),
        );
    }
  };

  const resolveInvocation = <TInput extends RoutableTextGenerationInput>(
    operation: TextGenerationOperation,
    input: TInput,
  ): Effect.Effect<
    {
      readonly implementation: TextGenerationShape;
      readonly input: TInput;
    },
    TextGenerationError
  > =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to load provider instance settings.",
              cause,
            }),
        ),
      );
      const requestedModelSelection = textGenerationModelSelectionForInput(
        input,
        settings.textGenerationModelSelection,
      );
      const instance = resolveProviderInstance(settings, {
        instanceId: resolveModelSelectionInstanceId(requestedModelSelection),
      });
      if (!instance) {
        return yield* new TextGenerationError({
          operation,
          detail: `No provider instance registered for id '${resolveModelSelectionInstanceId(
            requestedModelSelection,
          )}'.`,
        });
      }
      if (!instance.enabled) {
        return yield* new TextGenerationError({
          operation,
          detail: `Provider instance '${instance.instanceId}' is disabled.`,
        });
      }

      const implementation = yield* implementationForDriver(operation, instance.driver);
      const modelSelection = {
        ...requestedModelSelection,
        instanceId: instance.instanceId,
      } as ModelSelection;
      const providerOptions = mergeProviderStartOptions(
        input.providerOptions,
        providerStartOptionsFromInstance(instance),
      );
      return {
        implementation,
        input: {
          ...input,
          model: modelSelection.model,
          modelSelection,
          ...(providerOptions !== undefined ? { providerOptions } : {}),
        },
      } as const;
    });

  const dispatch = <TInput extends RoutableTextGenerationInput, TResult>(
    operation: TextGenerationOperation,
    input: TInput,
    run: (
      service: TextGenerationShape,
      routedInput: TInput,
    ) => Effect.Effect<TResult, TextGenerationError>,
  ) =>
    resolveInvocation(operation, input).pipe(
      Effect.flatMap(({ implementation, input: routedInput }) => run(implementation, routedInput)),
    );

  return {
    generateCommitMessage: (input) =>
      dispatch("generateCommitMessage", input, (service, routedInput) =>
        service.generateCommitMessage(routedInput),
      ),
    generatePrContent: (input) =>
      dispatch("generatePrContent", input, (service, routedInput) =>
        service.generatePrContent(routedInput),
      ),
    generateDiffSummary: (input) =>
      dispatch("generateDiffSummary", input, (service, routedInput) =>
        service.generateDiffSummary(routedInput),
      ),
    generateBranchName: (input) =>
      dispatch("generateBranchName", input, (service, routedInput) =>
        service.generateBranchName(routedInput),
      ),
    generateThreadTitle: (input) =>
      dispatch("generateThreadTitle", input, (service, routedInput) =>
        service.generateThreadTitle(routedInput),
      ),
    generateThreadRecap: (input) =>
      dispatch("generateThreadRecap", input, (service, routedInput) =>
        service.generateThreadRecap(routedInput),
      ),
    generateAutomationIntent: (input) =>
      dispatch("generateAutomationIntent", input, (service, routedInput) =>
        service.generateAutomationIntent(routedInput),
      ),
    evaluateAutomationCompletion: (input) =>
      dispatch("evaluateAutomationCompletion", input, (service, routedInput) =>
        service.evaluateAutomationCompletion(routedInput),
      ),
  } satisfies TextGenerationShape;
});

export const ProviderTextGenerationLive = Layer.effect(TextGeneration, makeProviderTextGeneration);

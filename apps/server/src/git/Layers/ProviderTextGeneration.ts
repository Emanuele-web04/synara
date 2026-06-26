import {
  PROVIDER_DISPLAY_NAMES,
  type DroidModelSelection,
  type ModelSelection,
  type ProviderKind,
  type ProviderStartOptions,
} from "@synara/contracts";
import {
  mergeProviderStartOptions,
  providerStartOptionsFromInstance,
  resolveModelSelectionInstanceId,
  resolveProviderInstance,
} from "@synara/shared/providerInstances";
import { Effect, Layer } from "effect";

import { parseOpenCodeModelSlug } from "../../provider/opencodeRuntime.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { TextGenerationError } from "../Errors.ts";
import * as TextGen from "../Services/TextGeneration.ts";
import * as Selection from "../textGenerationSelection.ts";

const parseDroidModelSlug = (model: string | undefined): { readonly model: string } | null => {
  const match = model && /^droid[:/](.+)$/.exec(model);
  return match && match[1] ? { model: match[1] } : null;
};

interface RoutableTextGenerationInput {
  readonly model?: string;
  readonly modelSelection?: ModelSelection;
  readonly providerOptions?: ProviderStartOptions;
}

const makeProviderTextGeneration = Effect.gen(function* () {
  const claudeTextGeneration = yield* TextGen.ClaudeTextGeneration;
  const codexTextGeneration = yield* TextGen.CodexTextGeneration;
  const cursorTextGeneration = yield* TextGen.CursorTextGeneration;
  const droidTextGeneration = yield* TextGen.DroidTextGeneration;
  const openCodeTextGeneration = yield* TextGen.OpenCodeTextGeneration;
  const serverSettings = yield* ServerSettingsService;

  const implementations = {
    claudeAgent: claudeTextGeneration,
    codex: codexTextGeneration,
    cursor: cursorTextGeneration,
    droid: droidTextGeneration,
    opencode: openCodeTextGeneration,
  } satisfies Record<Selection.GitTextGenerationProvider, TextGen.TextGenerationShape>;

  const implementationForDriver = (
    operation: TextGen.TextGenerationOperation,
    driver: ProviderKind,
  ): Effect.Effect<TextGen.TextGenerationShape, TextGenerationError> => {
    if (Selection.hasDedicatedTextGenerationProvider(driver)) {
      return Effect.succeed(implementations[driver]);
    }
    return Effect.fail(
      new TextGenerationError({
        operation,
        detail: `${PROVIDER_DISPLAY_NAMES[driver]} does not support Git text generation.`,
      }),
    );
  };

  const resolveRequestedProvider = (input: RoutableTextGenerationInput): ProviderKind =>
    input.modelSelection?.provider ??
    (parseDroidModelSlug(input.model) !== null
      ? "droid"
      : parseOpenCodeModelSlug(input.model) !== null
        ? "opencode"
        : "codex");

  const resolveInvocation = <TInput extends RoutableTextGenerationInput>(
    operation: TextGen.TextGenerationOperation,
    input: TInput,
  ): Effect.Effect<
    { readonly implementation: TextGen.TextGenerationShape; readonly input: TInput },
    TextGenerationError
  > =>
    Effect.gen(function* () {
      const requestedProvider = resolveRequestedProvider(input);
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

      const fallbackModelSelection = Selection.hasDedicatedTextGenerationProvider(
        requestedProvider,
      )
        ? undefined
        : settings.textGenerationModelSelection;
      const selectedProvider = fallbackModelSelection?.provider ?? requestedProvider;
      if (!Selection.hasDedicatedTextGenerationProvider(selectedProvider)) {
        return yield* new TextGenerationError({
          operation,
          detail: `${PROVIDER_DISPLAY_NAMES[requestedProvider]} does not support Git text generation, and no supported fallback is enabled.`,
        });
      }

      const modelSelectionOverride =
        selectedProvider === "droid" && !input.modelSelection && !fallbackModelSelection
          ? ({
              provider: "droid",
              instanceId: "droid",
              model: parseDroidModelSlug(input.model)?.model ?? "droid",
            } satisfies DroidModelSelection)
          : undefined;
      const selectedModelSelection =
        fallbackModelSelection ?? input.modelSelection ?? modelSelectionOverride;
      const selectedInstanceId = selectedModelSelection
        ? resolveModelSelectionInstanceId(selectedModelSelection)
        : selectedProvider;
      const instance = resolveProviderInstance(settings, {
        provider: selectedProvider,
        instanceId: selectedInstanceId,
      });
      if (!instance) {
        return yield* new TextGenerationError({
          operation,
          detail: `No provider instance registered for id '${selectedInstanceId}'.`,
        });
      }
      if (instance.driver !== selectedProvider) {
        return yield* new TextGenerationError({
          operation,
          detail: `Provider instance '${instance.instanceId}' uses '${instance.driver}', not '${selectedProvider}'.`,
        });
      }
      if (!instance.enabled) {
        return yield* new TextGenerationError({
          operation,
          detail: `Provider instance '${instance.instanceId}' is disabled.`,
        });
      }

      const implementation = yield* implementationForDriver(operation, instance.driver);
      const routedSelection = selectedModelSelection
        ? ({
            ...selectedModelSelection,
            provider: instance.driver,
            instanceId: instance.instanceId,
          } as ModelSelection)
        : undefined;
      const providerOptions = mergeProviderStartOptions(
        input.providerOptions,
        providerStartOptionsFromInstance(instance),
      );
      return {
        implementation,
        input: {
          ...input,
          ...(fallbackModelSelection ? { model: fallbackModelSelection.model } : {}),
          ...(routedSelection ? { modelSelection: routedSelection } : {}),
          ...(providerOptions ? { providerOptions } : {}),
        },
      } as { readonly implementation: TextGen.TextGenerationShape; readonly input: TInput };
    });

  const dispatch = <TInput extends RoutableTextGenerationInput, TResult>(
    operation: TextGen.TextGenerationOperation,
    input: TInput,
    run: (
      service: TextGen.TextGenerationShape,
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
  } satisfies TextGen.TextGenerationShape;
});

export const ProviderTextGenerationLive = Layer.effect(
  TextGen.TextGeneration,
  makeProviderTextGeneration,
);

import { Effect, Layer } from "effect";

import { parseOpenCodeModelSlug } from "../../provider/opencodeRuntime.ts";
import {
  CodexTextGeneration,
  CursorTextGeneration,
  KiloTextGeneration,
  OpenCodeTextGeneration,
  type TextGenerationShape,
  TextGeneration,
} from "../Services/TextGeneration.ts";

const makeProviderTextGeneration = Effect.gen(function* () {
  const codexTextGeneration = yield* CodexTextGeneration;
  const cursorTextGeneration = yield* CursorTextGeneration;
  const kiloTextGeneration = yield* KiloTextGeneration;
  const openCodeTextGeneration = yield* OpenCodeTextGeneration;

  const resolveImplementation = (input: {
    readonly model?: string;
    readonly modelSelection?: { provider: string };
  }): TextGenerationShape => {
    if (input.modelSelection?.provider === "cursor") {
      return cursorTextGeneration;
    }
    if (input.modelSelection?.provider === "kilo") {
      return kiloTextGeneration;
    }
    if (input.modelSelection?.provider === "opencode") {
      return openCodeTextGeneration;
    }
    return parseOpenCodeModelSlug(input.model) !== null
      ? openCodeTextGeneration
      : codexTextGeneration;
  };

  return {
    generateCommitMessage: (input) => resolveImplementation(input).generateCommitMessage(input),
    generatePrContent: (input) => resolveImplementation(input).generatePrContent(input),
    generateDiffSummary: (input) => resolveImplementation(input).generateDiffSummary(input),
    generateBranchName: (input) => resolveImplementation(input).generateBranchName(input),
    generateThreadTitle: (input) => resolveImplementation(input).generateThreadTitle(input),
    generateThreadRecap: (input) => resolveImplementation(input).generateThreadRecap(input),
    generateAutomationIntent: (input) =>
      resolveImplementation(input).generateAutomationIntent(input),
    evaluateAutomationCompletion: (input) =>
      resolveImplementation(input).evaluateAutomationCompletion(input),
  } satisfies TextGenerationShape;
});

export const ProviderTextGenerationLive = Layer.effect(TextGeneration, makeProviderTextGeneration);

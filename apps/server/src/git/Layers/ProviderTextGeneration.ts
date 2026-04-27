import { Effect, Layer } from "effect";

import { parseOpenCodeModelSlug } from "../../provider/opencodeRuntime.ts";
import {
  CodexTextGeneration,
  CursorTextGeneration,
  OpenCodeTextGeneration,
  type TextGenerationShape,
  TextGeneration,
} from "../Services/TextGeneration.ts";

function shouldUseOpenCode(input: {
  readonly model?: string;
  readonly modelSelection?: { provider: string };
}): boolean {
  if (input.modelSelection?.provider === "opencode") {
    return true;
  }
  if (input.modelSelection?.provider === "codex") {
    return false;
  }
  return parseOpenCodeModelSlug(input.model) !== null;
}

const makeProviderTextGeneration = Effect.gen(function* () {
  const codexTextGeneration = yield* CodexTextGeneration;
  const cursorTextGeneration = yield* CursorTextGeneration;
  const openCodeTextGeneration = yield* OpenCodeTextGeneration;

  const resolveImplementation = (input: {
    readonly model?: string;
    readonly modelSelection?: { provider: string };
  }): TextGenerationShape => {
    if (input.modelSelection?.provider === "cursor") {
      return cursorTextGeneration;
    }
    return shouldUseOpenCode(input) ? openCodeTextGeneration : codexTextGeneration;
  };

  return {
    generateCommitMessage: (input) => resolveImplementation(input).generateCommitMessage(input),
    generatePrContent: (input) => resolveImplementation(input).generatePrContent(input),
    generateDiffSummary: (input) => resolveImplementation(input).generateDiffSummary(input),
    generateBranchName: (input) => resolveImplementation(input).generateBranchName(input),
    generateThreadTitle: (input) => resolveImplementation(input).generateThreadTitle(input),
  } satisfies TextGenerationShape;
});

export const ProviderTextGenerationLive = Layer.effect(TextGeneration, makeProviderTextGeneration);

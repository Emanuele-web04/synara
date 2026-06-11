/**
 * CursorAcpSupport - helpers for Cursor ACP sessions and model selection.
 *
 * Owns spawn input construction and the Effect-shaped model-selection flow used
 * by the Cursor provider adapter. Pure parsing/helper logic lives in
 * CursorAcpSupport.parsing.ts and CursorAcpSupport.helpers.ts; shared types and
 * constants live in CursorAcpSupport.types.ts. This module re-exports the public
 * surface those siblings define so consumers keep importing from one entry point.
 *
 * @module CursorAcpSupport
 */
import { type CursorModelOptions, type ProviderModelDescriptor } from "@t3tools/contracts";
import { Effect, Layer, Schema, Scope, ServiceMap } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";
import * as EffectAcpErrorsRuntime from "effect-acp/errors";
import * as EffectAcpSchema from "effect-acp/schema";

import {
  AcpSessionRuntime,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";
import { resolveCursorAgentBinaryPath } from "./CursorAcpCommand.ts";
import {
  buildCursorAcpModelDescriptorsFromAvailableModels,
  collectCursorAcpConfigUpdates,
  flattenCursorAcpModelChoices,
  normalizeCursorAcpRuntimeOptions,
  resolveCursorAcpModelValue,
} from "./CursorAcpSupport.helpers.ts";
import {
  cursorModelOptionsFromCliModelId,
  cursorModelOptionsFromModelParameters,
  mergeCursorModelOptions,
  resolveCursorAcpBaseModelId,
} from "./CursorAcpSupport.parsing.ts";
import {
  CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
  type CursorAcpAvailableModel,
  type CursorAcpModelSelectionErrorContext,
  type CursorAcpModelSelectionRuntime,
  type CursorAcpRuntimeCursorSettings,
  type CursorAcpRuntimeInput,
} from "./CursorAcpSupport.types.ts";

export {
  buildCursorAcpModelDescriptors,
  buildCursorAcpModelDescriptorsFromAvailableModels,
  flattenCursorAcpModelChoices,
  parseCursorCliModelList,
} from "./CursorAcpSupport.helpers.ts";
export { resolveCursorAcpBaseModelId } from "./CursorAcpSupport.parsing.ts";
export {
  CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
  type CursorAcpAvailableModel,
  type CursorAcpModelChoice,
  type CursorAcpModelSelectionErrorContext,
  type CursorAcpRuntimeCursorSettings,
  type CursorAcpRuntimeInput,
} from "./CursorAcpSupport.types.ts";

export const CURSOR_LIST_AVAILABLE_MODELS_METHOD = "cursor/list_available_models";

const CursorAcpAvailableModelSchema = Schema.Struct({
  value: Schema.String,
  name: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
  configOptions: Schema.optional(Schema.Array(EffectAcpSchema.SessionConfigOption)),
});

const CursorAcpListAvailableModelsResult = Schema.Struct({
  models: Schema.Array(CursorAcpAvailableModelSchema),
});

const decodeCursorAcpListAvailableModelsResult = Schema.decodeUnknownEffect(
  CursorAcpListAvailableModelsResult,
);

export function buildCursorAcpSpawnInput(
  cursorSettings: CursorAcpRuntimeCursorSettings | null | undefined,
  cwd: string,
): AcpSpawnInput {
  return {
    command: resolveCursorAgentBinaryPath(cursorSettings?.binaryPath),
    args: [
      ...(cursorSettings?.apiEndpoint ? (["-e", cursorSettings.apiEndpoint] as const) : []),
      "acp",
    ],
    cwd,
  };
}

export const makeCursorAcpRuntime = (
  input: CursorAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildCursorAcpSpawnInput(input.cursorSettings, input.cwd),
        authMethodId: "cursor_login",
        clientCapabilities: CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return ServiceMap.getUnsafe(acpContext, AcpSessionRuntime);
  });

export function applyCursorAcpModelSelection<E>(input: {
  readonly runtime: CursorAcpModelSelectionRuntime;
  readonly model: string | null | undefined;
  readonly options: CursorModelOptions | null | undefined;
  readonly mapError: (context: CursorAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const initialConfigOptions = yield* input.runtime.getConfigOptions;
    const choices = flattenCursorAcpModelChoices(initialConfigOptions);
    const baseModel = resolveCursorAcpBaseModelId(input.model);
    const runtimeSafeOptions = normalizeCursorAcpRuntimeOptions({
      configOptions: initialConfigOptions,
      choices,
      baseModel,
      options: mergeCursorModelOptions(
        cursorModelOptionsFromModelParameters(input.model),
        input.options,
      ),
    });
    const mergedOptions = mergeCursorModelOptions(
      cursorModelOptionsFromCliModelId(input.model),
      runtimeSafeOptions,
    );
    const modelValue = resolveCursorAcpModelValue(initialConfigOptions, input.model, mergedOptions);
    if (modelValue) {
      yield* input.runtime.setModel(modelValue).pipe(
        Effect.mapError((cause) =>
          input.mapError({
            cause,
            step: "set-model",
          }),
        ),
      );
    }

    const configUpdates = collectCursorAcpConfigUpdates(
      yield* input.runtime.getConfigOptions,
      mergedOptions,
    );
    for (const update of configUpdates) {
      yield* input.runtime.setConfigOption(update.configId, update.value).pipe(
        Effect.mapError((cause) =>
          input.mapError({
            cause,
            step: "set-config-option",
            configId: update.configId,
          }),
        ),
      );
    }
  });
}

export function fetchCursorAcpModelDescriptors(
  runtime: Pick<AcpSessionRuntimeShape, "request">,
  sessionId: string,
): Effect.Effect<ReadonlyArray<ProviderModelDescriptor>, EffectAcpErrors.AcpError> {
  return runtime.request(CURSOR_LIST_AVAILABLE_MODELS_METHOD, { sessionId }).pipe(
    Effect.flatMap((raw) =>
      decodeCursorAcpListAvailableModelsResult(raw).pipe(
        Effect.mapError((cause) =>
          EffectAcpErrorsRuntime.AcpRequestError.parseError(
            "Failed to decode Cursor available models response.",
            cause,
          ),
        ),
      ),
    ),
    Effect.map((result) => {
      const models: ReadonlyArray<CursorAcpAvailableModel> = result.models.map((model) => ({
        value: model.value,
        ...(model.name !== undefined ? { name: model.name } : {}),
        ...(model.configOptions !== undefined ? { configOptions: model.configOptions } : {}),
      }));
      return buildCursorAcpModelDescriptorsFromAvailableModels(models);
    }),
  );
}

/**
 * CursorAcpSupport.types - shared types and constants for Cursor ACP support.
 *
 * Purpose: declare the public/internal shapes consumed across the Cursor ACP
 * support modules without runtime logic.
 * Layer: pure types + constants (no Effect, no IO).
 * Exports: CursorAcpRuntimeCursorSettings, CursorAcpRuntimeInput,
 *   CursorAcpModelSelectionErrorContext, CursorAcpModelChoice,
 *   CursorAcpSelectOption, CursorAcpModelSelectionRuntime,
 *   CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES.
 *
 * @module CursorAcpSupport.types
 */
import type { Effect } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import type { AcpSessionRuntimeOptions, AcpSessionRuntimeShape } from "./AcpSessionRuntime.ts";

export interface CursorAcpRuntimeCursorSettings {
  readonly apiEndpoint?: string;
  readonly binaryPath?: string;
}

export const CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES = {
  _meta: {
    parameterizedModelPicker: true,
  },
} satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

export interface CursorAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly cursorSettings: CursorAcpRuntimeCursorSettings | null | undefined;
}

export interface CursorAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-config-option" | "set-model";
  readonly configId?: string;
}

export interface CursorAcpModelChoice {
  readonly slug: string;
  readonly name: string;
  readonly upstreamProviderId?: string;
  readonly upstreamProviderName?: string;
}

export interface CursorAcpAvailableModel {
  readonly value: string;
  readonly name?: string | null;
  readonly configOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
}

export interface CursorAcpSelectOption {
  readonly value: string;
  readonly name: string;
  readonly groupId?: string;
  readonly groupName?: string;
}

export interface CursorAcpModelSelectionRuntime {
  readonly getConfigOptions: AcpSessionRuntimeShape["getConfigOptions"];
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly setModel: (model: string) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

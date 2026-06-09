// Purpose: Pure, runtime-free shared types for the OpenCode/Kilo adapter modules.
// Layer: types only — no values, no Effect, no SDK runtime bindings.
// Exports: provider/config/inventory/model/token/message-snapshot type aliases.

import type { ProviderKind, ProviderListModelsResult } from "@t3tools/contracts";
import type { AssistantMessage, Part } from "@opencode-ai/sdk/v2";

import type { OpenCodeCompatibleCliSpec } from "../opencodeRuntime.ts";

export type OpenCodeCompatibleProvider = Extract<ProviderKind, "opencode" | "kilo">;

export interface OpenCodeCompatibleAdapterConfig {
  readonly provider: OpenCodeCompatibleProvider;
  readonly displayName: string;
  readonly defaultBinaryPath: string;
  readonly providerOptionsKey: OpenCodeCompatibleProvider;
  readonly runtimeEventSource: "opencode.sdk.event" | "kilo.sdk.event";
  readonly turnIdPrefix: string;
  readonly cliModelSource: string;
  readonly fallbackModelSource: string;
  readonly defaultAgent: string;
  readonly planAgent: string;
  readonly cliSpec: OpenCodeCompatibleCliSpec;
}

export type OpenCodeModelInventory = {
  readonly providerList: {
    readonly connected: ReadonlyArray<string>;
    readonly all: ReadonlyArray<{
      readonly id: string;
      readonly name: string;
      readonly source?: string;
      readonly env?: ReadonlyArray<string>;
      readonly options?: Record<string, unknown>;
      readonly models: Record<
        string,
        {
          readonly id: string;
          readonly name: string;
          readonly options?: Record<string, unknown>;
          readonly capabilities?: {
            readonly reasoning?: boolean;
          };
          readonly limit?: {
            readonly context?: number;
            readonly output?: number;
          };
          readonly variants?: Record<string, Record<string, unknown>>;
          readonly isFree?: boolean;
        }
      >;
    }>;
  };
  readonly consoleState?: {
    readonly consoleManagedProviders: ReadonlyArray<string>;
  } | null;
};

export type OpenCodeInventoryProvider = OpenCodeModelInventory["providerList"]["all"][number];
export type OpenCodeModelDescriptor = ProviderListModelsResult["models"][number];

export type OpenCodeAssistantTokens = AssistantMessage["tokens"];

export interface NormalizedOpenCodeTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface OpenCodeMessageSnapshot {
  readonly info: {
    readonly id: string;
    readonly role: "user" | "assistant";
    readonly time?: {
      readonly completed?: number;
    };
    readonly finish?: string;
  };
  readonly parts: ReadonlyArray<Part>;
}

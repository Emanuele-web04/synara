// Purpose: Pure, runtime-free shared types and constants for the Pi adapter modules.
// Layer: types and literal constants only — no values bound to a session context.
// Exports: PROVIDER, thinking-level option list/default, session-context and tracked-tool types.

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ModelRegistry, createAgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type {
  ProviderSession,
  RuntimeItemId,
  ThreadTokenUsageSnapshot,
  TurnId,
} from "@t3tools/contracts";

import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

export const PROVIDER = "pi" as const;
export const DEFAULT_PI_THINKING_LEVEL: ThinkingLevel = "medium";

export const PI_THINKING_OPTIONS: ReadonlyArray<{
  readonly value: ThinkingLevel;
  readonly label: string;
  readonly description: string;
  readonly isDefault?: true;
}> = [
  { value: "off", label: "Off", description: "No extra reasoning" },
  { value: "minimal", label: "Minimal", description: "Light reasoning" },
  { value: "low", label: "Low", description: "Faster reasoning" },
  { value: "medium", label: "Medium", description: "Balanced reasoning", isDefault: true },
  { value: "high", label: "High", description: "Deeper reasoning" },
  { value: "xhigh", label: "Extra High", description: "Maximum reasoning" },
];

export type PiModelRegistry = Pick<ModelRegistry, "find" | "getAll" | "getAvailable">;

export interface PiSessionContext {
  runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>;
  modelRegistry: PiModelRegistry;
  session: ProviderSession;
  turns: PiStoredTurn[];
  activeTurnId: TurnId | undefined;
  activeAssistantItemId: RuntimeItemId | undefined;
  activeReasoningItemId: RuntimeItemId | undefined;
  activeToolItems: Map<string, PiTrackedToolCall>;
  stopped: boolean;
  lastKnownTokenUsage: ThreadTokenUsageSnapshot | undefined;
  unsubscribe: (() => void) | undefined;
}

export interface PiStoredTurn {
  readonly id: TurnId;
  readonly items: unknown[];
  leafId?: string | null;
}

export interface PiTrackedToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly itemId: RuntimeItemId;
  readonly itemType: "command_execution" | "file_change" | "dynamic_tool_call" | "web_search";
}

export interface PiAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

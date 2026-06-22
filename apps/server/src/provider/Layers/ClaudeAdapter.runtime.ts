// Purpose: Shared runtime context/deps types and primitive helpers for the Claude adapter's extracted modules.
// Layer: types + small pure/Effect helpers — no Layer wiring; consumed by the factory and sibling modules.
// Exports: ClaudeSessionContext, ClaudeQueryRuntime, ClaudeAdapterLiveOptions, ClaudeEmitterDeps, nativeProviderRefs, hasPendingUserInterrupt.

import type {
  AgentInfo,
  Options as ClaudeQueryOptions,
  ModelInfo,
  PermissionMode,
  SDKMessage,
  SDKUserMessage,
  SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type ApprovalRequestId,
  type EventId,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadTokenUsageSnapshot,
  type TurnId,
} from "@t3tools/contracts";
import type { Effect, Fiber, Queue } from "effect";

import type {
  ClaudeTurnState,
  PendingApproval,
  PendingUserInput,
  PromptQueueItem,
  ToolInFlight,
} from "./ClaudeAdapter.types.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

export interface ClaudeQueryRuntime extends AsyncIterable<SDKMessage> {
  readonly interrupt: () => Promise<void>;
  readonly setModel: (model?: string) => Promise<void>;
  readonly setPermissionMode: (mode: PermissionMode) => Promise<void>;
  readonly setMaxThinkingTokens: (maxThinkingTokens: number | null) => Promise<void>;
  readonly supportedCommands: () => Promise<SlashCommand[]>;
  readonly supportedModels: () => Promise<ModelInfo[]>;
  readonly supportedAgents: () => Promise<AgentInfo[]>;
  readonly close: () => void;
}

export interface ClaudeSessionContext {
  session: ProviderSession;
  readonly promptQueue: Queue.Queue<PromptQueueItem>;
  readonly query: ClaudeQueryRuntime;
  streamFiber: Fiber.Fiber<void, Error> | undefined;
  readonly startedAt: string;
  readonly basePermissionMode: PermissionMode | undefined;
  currentApiModelId: string | undefined;
  resumeSessionId: string | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{
    id: TurnId;
    items: Array<unknown>;
  }>;
  readonly inFlightTools: Map<number, ToolInFlight>;
  turnState: ClaudeTurnState | undefined;
  interruptRequestedTurnId: TurnId | undefined;
  lastKnownContextWindow: number | undefined;
  lastKnownTokenUsage: ThreadTokenUsageSnapshot | undefined;
  lastAssistantUuid: string | undefined;
  lastThreadStartedId: string | undefined;
  lastThinkingItemId: string | undefined;
  stopped: boolean;
  // Unrecognized SDK message kinds already surfaced as a runtime warning; de-duping
  // here keeps a single unknown kind from flooding the conversation timeline.
  readonly warnedUnhandledSdkKinds: Set<string>;
}

export interface ClaudeAdapterLiveOptions {
  readonly createQuery?: (input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptions;
  }) => ClaudeQueryRuntime;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

export interface EventStamp {
  readonly eventId: EventId;
  readonly createdAt: string;
}

/**
 * Factory-scoped primitives the extracted emitter/handler modules used to close
 * over. The adapter factory builds this once and passes it to the `make*`
 * helpers so call sites stay equivalent.
 */
export interface ClaudeEmitterDeps {
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly makeEventStamp: () => Effect.Effect<EventStamp>;
  readonly nowIso: Effect.Effect<string>;
  readonly nativeEventLogger: EventNdjsonLogger | undefined;
}

export function hasPendingUserInterrupt(context: ClaudeSessionContext): boolean {
  const activeTurnId = context.turnState?.turnId;
  return activeTurnId !== undefined && context.interruptRequestedTurnId === activeTurnId;
}

export function nativeProviderRefs(
  _context: ClaudeSessionContext,
  options?: {
    readonly providerItemId?: string | undefined;
  },
): NonNullable<ProviderRuntimeEvent["providerRefs"]> {
  if (options?.providerItemId) {
    return {
      providerItemId: ProviderItemId.makeUnsafe(options.providerItemId),
    };
  }
  return {};
}

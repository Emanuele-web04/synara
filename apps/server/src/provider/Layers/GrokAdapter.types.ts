// Purpose: Pure, runtime-free shared types and constants for the Grok adapter modules.
// Layer: types and literal constants only — no values bound to a session context.
// Exports: PROVIDER, ACP/resume constants, mode aliases, plan-mode prompt, session-context types.

import {
  type ApprovalRequestId,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderSession,
  type ProviderUserInputAnswers,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { Deferred, Fiber, Scope } from "effect";

import { type AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";

import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

export const PROVIDER = "grok" as const;
export const GROK_RESUME_VERSION = 1 as const;
export const GROK_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
export const GROK_ACP_TRANSPORT_DEBUG_MARKER = "grok-acp-meta-stripper-v2";
export const GROK_ACP_LOG_PAYLOAD_LIMIT = 4_000;
export const GROK_ACP_DEBUG_ENV = "SYNARA_GROK_ACP_DEBUG";
export const DPCODE_GROK_ACP_DEBUG_ENV = "DPCODE_GROK_ACP_DEBUG";
export const LEGACY_GROK_ACP_DEBUG_ENV = "DP_GROK_ACP_DEBUG";
export const GROK_RESUME_REPLAY_QUIET_MS = 350;
export const GROK_RESUME_REPLAY_MAX_WAIT_MS = 3_000;
export const XAI_API_BASE_URL = "https://api.x.ai/v1";
export const ACP_PLAN_MODE_ALIASES = ["plan"];
export const ACP_IMPLEMENT_MODE_ALIASES = ["code", "agent", "default", "chat", "implement"];
export const ACP_APPROVAL_MODE_ALIASES = ["ask"];
export const GROK_PLAN_MODE_PROMPT_PREFIX = [
  "Synara Grok plan mode is active.",
  "Do not implement or mutate files in this turn.",
  "Do not ask follow-up questions or wait for confirmation; if scope is ambiguous, choose a reasonable default and state the assumption in the plan.",
  "When ready, create the final implementation plan.",
].join("\n");

export interface GrokAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

export interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

export interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

export interface GrokSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeInteractionMode: ProviderInteractionMode | undefined;
  activeTurnId: TurnId | undefined;
  activeTurnHadAssistantContent: boolean;
  readonly activeAssistantItemsWithContent: Set<string>;
  activeTurnFailedToolDetail: string | undefined;
  activePromptFiber: Fiber.Fiber<void, never> | undefined;
  resumeReplayReady: Deferred.Deferred<void> | undefined;
  resumeReplayLastSuppressedAt: number | undefined;
  latestSessionCostUsd: number | undefined;
  stopped: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

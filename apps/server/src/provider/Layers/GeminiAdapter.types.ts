/**
 * GeminiAdapter.types - Shared type declarations for the Gemini provider adapter.
 *
 * Purpose: module-scope type/interface definitions for Gemini ACP sessions, tool
 * calls, approvals, turn state, and session context. No runtime logic.
 *
 * @module GeminiAdapter.types
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type readline from "node:readline";

import type {
  ApprovalRequestId,
  CanonicalItemType,
  CanonicalRequestType,
  ProviderSession,
  RuntimeItemId,
  ThreadTokenUsageSnapshot,
  TurnId,
} from "@t3tools/contracts";

import type { ProviderAdapterRequestError } from "../Errors.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

export type JsonRpcId = number | string;

export type GeminiToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export type GeminiToolStatus = "pending" | "in_progress" | "completed" | "failed";

export type GeminiPermissionOptionKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always";

export interface GeminiPermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: GeminiPermissionOptionKind;
}

export interface GeminiToolCallLocation {
  readonly path: string;
  readonly line?: number | null;
}

export interface GeminiToolCall {
  readonly toolCallId: string;
  readonly title?: string | null;
  readonly kind?: GeminiToolKind | null;
  readonly status?: GeminiToolStatus | null;
  readonly content?: ReadonlyArray<unknown> | null;
  readonly locations?: ReadonlyArray<GeminiToolCallLocation> | null;
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
}

export interface GeminiPendingRequest {
  readonly method: string;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: ProviderAdapterRequestError) => void;
}

export interface GeminiPendingApproval {
  readonly acpRequestId: JsonRpcId;
  readonly options: ReadonlyArray<GeminiPermissionOption>;
  readonly requestType: CanonicalRequestType;
  readonly turnId?: TurnId;
  readonly providerItemId?: string;
  readonly detail?: string;
}

export interface GeminiRecordedItem {
  id: string;
  itemType: CanonicalItemType;
  title?: string;
  detail?: string;
  status?: "inProgress" | "completed" | "failed";
  text?: string;
  data?: unknown;
}

export interface GeminiTurnState {
  readonly turnId: TurnId;
  readonly startedAt: string;
  readonly interactionMode: "default" | "plan";
  readonly assistantItemId: RuntimeItemId;
  reasoningItemId: RuntimeItemId | undefined;
  readonly items: GeminiRecordedItem[];
  assistantTextStarted: boolean;
  reasoningTextStarted: boolean;
  assistantText: string;
  reasoningText: string;
}

export interface GeminiStoredTurn {
  readonly id: TurnId;
  readonly items: Array<unknown>;
  readonly snapshotSessionId?: string;
  readonly snapshotFilePath?: string;
}

export interface GeminiSessionContext {
  session: ProviderSession;
  readonly binaryPath: string;
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdout: readline.Interface;
  readonly stderr: readline.Interface;
  readonly pending: Map<string, GeminiPendingRequest>;
  readonly pendingApprovals: Map<ApprovalRequestId, GeminiPendingApproval>;
  readonly turns: GeminiStoredTurn[];
  readonly runtimeModeId: string;
  nextRequestId: number;
  sessionId: string;
  currentModeId: string | undefined;
  currentModelId: string | undefined;
  turnState: GeminiTurnState | undefined;
  sessionFilePath: string | undefined;
  systemSettingsPath: string | undefined;
  suppressSessionUpdates: boolean;
  stopped: boolean;
  exitEmitted: boolean;
  lastKnownTokenUsage: ThreadTokenUsageSnapshot | undefined;
}

export interface GeminiAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

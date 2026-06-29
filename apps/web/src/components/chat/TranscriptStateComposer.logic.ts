import type { ProviderApprovalDecision } from "@t3tools/contracts";

import { deriveTranscriptComposerState } from "../../session-logic";
import {
  LAB_PENDING_APPROVAL,
  LAB_PENDING_USER_INPUTS,
} from "./TranscriptStateComposer.fixtures";
import type { TranscriptScenarioState } from "./transcriptStateFixtures";

export type TranscriptComposerMode =
  | "approval"
  | "user-input"
  | "busy"
  | "reconnecting"
  | "rate-limited"
  | "streaming"
  | "error"
  | "ready";

export function composerModeForScenario(
  state: TranscriptScenarioState,
): TranscriptComposerMode {
  const nativeState = deriveNativeComposerStateForScenario(state);

  if (nativeState.kind === "pending-approval") return "approval";
  if (nativeState.kind === "pending-user-input") return "user-input";
  if (nativeState.kind === "disconnected") return "reconnecting";

  switch (state.scenario.id) {
    case "first-token":
      return "streaming";
    case "completed":
    case "cancelled":
      return "ready";
    case "startup-error":
    case "stale-request":
      return "error";
    case "rate-limit":
      return rateLimitVisibleForScenario(state) ? "rate-limited" : "busy";
    case "approval":
    case "user-input":
    case "reconnect":
      return "busy";
    case "sent":
    case "accepted":
    case "reasoning":
    case "tool-first":
      return "busy";
  }
}

function rateLimitVisibleForScenario(state: TranscriptScenarioState): boolean {
  return state.visibleEventLabels.includes("provider capacity wait");
}

function deriveNativeComposerStateForScenario(state: TranscriptScenarioState) {
  return deriveTranscriptComposerState({
    pendingApprovals: state.scenario.id === "approval" ? [LAB_PENDING_APPROVAL] : [],
    pendingUserInputs: state.scenario.id === "user-input" ? LAB_PENDING_USER_INPUTS : [],
    planFollowUp: null,
    isConnected: state.scenario.id !== "reconnect",
    session: {
      status: state.activeTurnInProgress ? "running" : "ready",
      orchestrationStatus: state.activeTurnInProgress ? "running" : "idle",
    },
  });
}

export function composerStatusLabel(
  mode: TranscriptComposerMode,
  state: TranscriptScenarioState,
  approvalDecision: ProviderApprovalDecision | null,
  userInputSubmitted: boolean,
): string {
  if (mode === "approval") {
    return approvalDecision
      ? `${approvalDecisionLabel(approvalDecision)} selected`
      : state.scenario.composerLabel;
  }
  if (mode === "user-input") {
    return userInputSubmitted ? "Answers submitted in the lab" : state.scenario.composerLabel;
  }
  if (mode === "streaming") return "Assistant text is streaming; follow is attached to text.";
  if (mode === "ready") return state.scenario.composerLabel;
  if (mode === "reconnecting") return state.scenario.composerLabel;
  if (mode === "rate-limited") return state.scenario.composerLabel;
  if (mode === "error") return state.scenario.composerLabel;
  return state.scenario.composerLabel;
}

function approvalDecisionLabel(decision: ProviderApprovalDecision): string {
  switch (decision) {
    case "accept":
      return "Approve once";
    case "acceptForSession":
      return "Always allow this session";
    case "decline":
      return "Decline";
    case "cancel":
      return "Cancel turn";
  }
}

export function placeholderForMode(mode: TranscriptComposerMode): string {
  switch (mode) {
    case "approval":
      return "Resolve this approval request to continue";
    case "user-input":
      return "Type your answer";
    case "streaming":
      return "Assistant text is streaming";
    case "ready":
      return "Ready for the next turn";
    case "error":
      return "The provider stopped before text arrived. Retry or edit the turn.";
    case "reconnecting":
      return "Reconnecting to the provider session";
    case "rate-limited":
      return "Waiting on provider capacity";
    case "busy":
      return "Waiting for first visible agent output";
  }
}

export function composerPlaceholderForState(
  mode: TranscriptComposerMode,
  state: TranscriptScenarioState,
): string {
  switch (state.scenario.id) {
    case "completed":
      return "Ask the next question";
    case "cancelled":
      return "Turn stopped. Ask again or edit the previous prompt.";
    case "reconnect":
      return "Reconnecting to the provider session";
    case "rate-limit":
      return rateLimitVisibleForScenario(state)
        ? "Waiting on provider capacity"
        : placeholderForMode(mode);
    default:
      return placeholderForMode(mode);
  }
}

export function composerActionLabel(
  mode: TranscriptComposerMode,
  state: TranscriptScenarioState,
): string {
  if (mode === "ready") return state.scenario.id === "cancelled" ? "Ask again" : "Send";
  if (mode === "error") return "Retry turn";

  switch (state.scenario.id) {
    case "reconnect":
      return "Reconnecting";
    case "rate-limit":
      return rateLimitVisibleForScenario(state) ? "Waiting on capacity" : "Waiting";
    default:
      return "Waiting";
  }
}

export function composerActionDisabled(mode: TranscriptComposerMode): boolean {
  return mode !== "ready" && mode !== "error";
}

import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";

import type { WorkLogEntry } from "../../session-logic";
import type { TranscriptScenarioState } from "./transcriptStateFixtures";

export type TranscriptStatePreviewPhase = "pre-token" | "first-token" | "settled" | "failed";

export interface TranscriptStatePreviewMeta {
  readonly phase: TranscriptStatePreviewPhase;
  readonly phaseLabel: string;
  readonly phaseDescription: string;
  readonly assistantRows: number;
  readonly workRows: number;
  readonly latestWorkTone: WorkLogEntry["tone"] | "none";
  readonly followLabel: string;
  readonly scrollLabel: string;
  readonly scrollButtonVisible: boolean;
}

export function deriveTranscriptStatePreviewMeta(
  state: TranscriptScenarioState,
): TranscriptStatePreviewMeta {
  let assistantRows = 0;
  let workRows = 0;
  let hasAssistantText = false;
  let hasStreamingAssistantText = false;
  let hasErrorWork = false;
  let latestWorkTone: WorkLogEntry["tone"] | "none" = "none";

  for (const entry of state.timelineEntries) {
    if (entry.kind === "message" && entry.message.role === "assistant") {
      assistantRows += 1;
      if (entry.message.text.trim().length > 0) {
        hasAssistantText = true;
        hasStreamingAssistantText = entry.message.streaming || hasStreamingAssistantText;
      }
    }
    if (entry.kind === "work") {
      workRows += 1;
      latestWorkTone = entry.entry.tone;
      hasErrorWork = entry.entry.tone === "error" || hasErrorWork;
    }
  }

  const phase = resolvePreviewPhase({
    hasAssistantText,
    hasErrorWork,
    hasStreamingAssistantText,
    activeTurnInProgress: state.activeTurnInProgress,
  });

  return {
    phase,
    phaseLabel: resolvePhaseLabel(phase),
    phaseDescription: resolvePhaseDescription(phase, latestWorkTone),
    assistantRows,
    workRows,
    latestWorkTone,
    followLabel: resolveFollowLabel({
      phase,
      followLiveOutput: state.followLiveOutput,
      latestWorkTone,
    }),
    scrollLabel: state.followLiveOutput ? "tail locked" : "steady",
    scrollButtonVisible: !state.followLiveOutput && state.timelineEntries.length > 3,
  };
}

export function phaseClassName(phase: TranscriptStatePreviewPhase): string {
  switch (phase) {
    case "pre-token":
      return "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "first-token":
      return "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "settled":
      return "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300";
    case "failed":
      return "border-destructive/30 bg-destructive/10 text-destructive";
  }
}

export function rateLimitActivityForState(
  state: TranscriptScenarioState,
): OrchestrationThreadActivity | null {
  if (state.scenario.id !== "rate-limit") {
    return null;
  }
  if (!state.visibleEventLabels.includes("provider capacity wait")) {
    return null;
  }

  return {
    id: EventId.makeUnsafe("transcript-state-lab-rate-limit"),
    tone: "error",
    kind: "account.rate-limited",
    summary: "Rate limited",
    createdAt: state.nowIso,
    turnId: state.activeTurnId,
    payload: {
      status: "rejected",
      resetsAt: new Date(Date.now() + 55_000).toISOString(),
    },
  };
}

function resolvePreviewPhase({
  hasAssistantText,
  hasErrorWork,
  hasStreamingAssistantText,
  activeTurnInProgress,
}: {
  readonly hasAssistantText: boolean;
  readonly hasErrorWork: boolean;
  readonly hasStreamingAssistantText: boolean;
  readonly activeTurnInProgress: boolean;
}): TranscriptStatePreviewPhase {
  if (hasErrorWork && !activeTurnInProgress) {
    return "failed";
  }
  if (hasStreamingAssistantText) {
    return "first-token";
  }
  if (hasAssistantText) {
    return "settled";
  }
  return "pre-token";
}

function resolvePhaseLabel(phase: TranscriptStatePreviewPhase): string {
  switch (phase) {
    case "pre-token":
      return "pre-token";
    case "first-token":
      return "first token";
    case "settled":
      return "settled";
    case "failed":
      return "failed";
  }
}

function resolvePhaseDescription(
  phase: TranscriptStatePreviewPhase,
  latestWorkTone: WorkLogEntry["tone"] | "none",
): string {
  switch (phase) {
    case "pre-token":
      return latestWorkTone === "none"
        ? "No assistant row exists yet; only the user message and turn status are visible."
        : "No assistant row exists yet; live work is visible without fake response text.";
    case "first-token":
      return "Assistant text is now streaming, so transcript follow can attach to real tokens.";
    case "settled":
      return "Assistant text exists and the turn is no longer in a first-token boundary.";
    case "failed":
      return "The turn failed before assistant text appeared, so the transcript must stop loading.";
  }
}

function resolveFollowLabel({
  phase,
  followLiveOutput,
  latestWorkTone,
}: {
  readonly phase: TranscriptStatePreviewPhase;
  readonly followLiveOutput: boolean;
  readonly latestWorkTone: WorkLogEntry["tone"] | "none";
}): string {
  if (!followLiveOutput) {
    return "manual";
  }
  if (phase === "first-token") {
    return "text";
  }
  if (latestWorkTone === "thinking") {
    return "thinking";
  }
  if (latestWorkTone === "tool") {
    return "tool";
  }
  return "turn";
}

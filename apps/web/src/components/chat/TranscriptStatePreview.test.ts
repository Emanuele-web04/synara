import { describe, expect, it } from "vitest";

import {
  deriveTranscriptStatePreviewMeta,
  rateLimitActivityForState,
  type TranscriptStatePreviewPhase,
} from "./TranscriptStatePreviewMeta";
import {
  buildTranscriptScenarioState,
  type TranscriptScenarioId,
} from "./transcriptStateFixtures";

function previewPhaseForScenario(scenarioId: TranscriptScenarioId): TranscriptStatePreviewPhase {
  return deriveTranscriptStatePreviewMeta(buildTranscriptScenarioState(scenarioId, 12)).phase;
}

describe("deriveTranscriptStatePreviewMeta", () => {
  it("keeps live work before assistant text in the pre-token phase", () => {
    const meta = deriveTranscriptStatePreviewMeta(buildTranscriptScenarioState("tool-first", 12));

    expect(meta.phase).toBe("pre-token");
    expect(meta.assistantRows).toBe(0);
    expect(meta.workRows).toBeGreaterThan(0);
    expect(meta.followLabel).toBe("tool");
    expect(meta.phaseDescription).toContain("without fake response text");
  });

  it("switches to first-token only when a streaming assistant row exists", () => {
    const meta = deriveTranscriptStatePreviewMeta(buildTranscriptScenarioState("first-token", 13));

    expect(meta.phase).toBe("first-token");
    expect(meta.assistantRows).toBe(1);
    expect(meta.followLabel).toBe("text");
  });

  it("marks startup errors as terminal pre-text failures", () => {
    const meta = deriveTranscriptStatePreviewMeta(buildTranscriptScenarioState("startup-error", 9));

    expect(meta.phase).toBe("failed");
    expect(meta.scrollLabel).toBe("steady");
    expect(meta.followLabel).toBe("manual");
  });

  it("marks completed turns as settled instead of streaming", () => {
    const meta = deriveTranscriptStatePreviewMeta(buildTranscriptScenarioState("completed", 22));

    expect(meta.phase).toBe("settled");
    expect(meta.assistantRows).toBe(1);
    expect(meta.followLabel).toBe("manual");
  });

  it("does not mistake pre-token blockers for assistant text", () => {
    expect(previewPhaseForScenario("approval")).toBe("pre-token");
    expect(previewPhaseForScenario("user-input")).toBe("pre-token");
    expect(previewPhaseForScenario("reasoning")).toBe("pre-token");
    expect(previewPhaseForScenario("rate-limit")).toBe("pre-token");
  });

  it("keeps provider capacity waits out of transcript work rows", () => {
    const meta = deriveTranscriptStatePreviewMeta(buildTranscriptScenarioState("rate-limit", 24));

    expect(meta.workRows).toBe(0);
    expect(meta.followLabel).toBe("manual");
    expect(meta.scrollLabel).toBe("steady");
  });

  it("gates the rate-limit banner to the provider capacity event threshold", () => {
    expect(rateLimitActivityForState(buildTranscriptScenarioState("rate-limit", 1))).toBeNull();
    expect(rateLimitActivityForState(buildTranscriptScenarioState("rate-limit", 5))).not.toBeNull();
  });

  it("uses scenario-specific user message ids so live regions refresh prompt text", () => {
    const cancelledUserEntry = userMessageEntryForScenario("cancelled", 7);
    const approvalUserEntry = userMessageEntryForScenario("approval", 11);

    expect(cancelledUserEntry?.message.id).not.toBe(approvalUserEntry?.message.id);
  });

  it("scrubs future work and event labels by elapsed time", () => {
    const state = buildTranscriptScenarioState("tool-first", 4);

    expect(state.timelineEntries.some((entry) => entry.id === "tool-first-search")).toBe(false);
    expect(state.visibleEventLabels).toEqual(["turn accepted"]);
    expect(state.nextEventLabel).toBe("searched files");
  });
});

function userMessageEntryForScenario(scenarioId: TranscriptScenarioId, elapsedSeconds: number) {
  const entry = buildTranscriptScenarioState(scenarioId, elapsedSeconds).timelineEntries.find(
    (timelineEntry) => timelineEntry.kind === "message" && timelineEntry.message.role === "user",
  );

  return entry?.kind === "message" ? entry : null;
}

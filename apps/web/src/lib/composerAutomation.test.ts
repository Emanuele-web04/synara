// FILE: composerAutomation.test.ts
// Purpose: Locks down composer-to-automation orchestration outside ChatView.
// Layer: Web lib test
// Depends on: composerAutomation resolver and automation form helpers.

import type { ModelSelection, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  buildComposerAutomationDraft,
  resolveComposerAutomationRequest,
} from "./composerAutomation";

const PROJECT_ID = "project-composer-automation" as ProjectId;
const THREAD_ID = "thread-composer-automation" as ThreadId;
const MODEL_SELECTION: ModelSelection = {
  provider: "codex",
  model: "gpt-5",
};
const NOW_ISO = "2026-06-22T08:00:00.000Z";

describe("composerAutomation", () => {
  it("keeps unmarked automation questions as normal chat", async () => {
    const generateIntent = vi.fn(async () => {
      throw new Error("should not generate");
    });

    const decision = await resolveComposerAutomationRequest({
      message: "how do automations work every day?",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent,
    });

    expect(decision).toEqual({ type: "normal-chat" });
    expect(generateIntent).not.toHaveBeenCalled();

    const scriptDecision = await resolveComposerAutomationRequest({
      message: "can you write a script that runs every 5 minutes?",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent,
    });

    expect(scriptDecision).toEqual({ type: "normal-chat" });
    expect(generateIntent).not.toHaveBeenCalled();
  });

  it("accepts polite unmarked automation requests", async () => {
    const generateIntent = vi.fn(async () => {
      throw new Error("offline generation falls back to deterministic intent");
    });

    const decision = await resolveComposerAutomationRequest({
      message: "could you remind me every day to stretch?",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent,
    });

    expect(decision).toMatchObject({
      type: "automation",
      resolution: {
        mode: "heartbeat",
        intent: {
          prompt: "remind me stretch",
          executionScope: "thread",
          schedule: { type: "daily", timeOfDay: "09:00" },
        },
      },
    });
  });

  it("accepts polite say requests as bounded thread automations", async () => {
    const generateIntent = vi.fn(async () => {
      throw new Error("bounded fast loops should not need generation");
    });

    const decision = await resolveComposerAutomationRequest({
      message: "could you say hi every 15 seconds for 3 times",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent,
    });

    expect(decision).toMatchObject({
      type: "automation",
      resolution: {
        mode: "heartbeat",
        intent: {
          prompt: "say hi",
          maxIterations: 3,
          executionScope: "thread",
          schedule: { type: "interval", everySeconds: 15 },
        },
      },
    });
    expect(generateIntent).not.toHaveBeenCalled();
  });

  it("keeps generated standalone mode when regex scope parsing misses it", async () => {
    const generateIntent = vi.fn(async () => ({
      isAutomation: true,
      confidence: 0.93,
      language: "en",
      name: "Check CI",
      taskPrompt: "Check CI.",
      schedule: { type: "interval" as const, everySeconds: 300 },
      mode: "standalone" as const,
      completionPolicy: { type: "none" as const },
      missingFields: [],
      needsConfirmation: false,
      reason: null,
    }));

    const decision = await resolveComposerAutomationRequest({
      message: "/automation independently check CI every 5 minutes",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent,
    });

    expect(decision).toMatchObject({
      type: "automation",
      resolution: {
        mode: "standalone",
        requiresReview: true,
        intent: {
          prompt: "Check CI.",
          executionScope: "standalone",
        },
      },
    });
  });

  it("falls back to deterministic automation parsing when AI enrichment is slow", async () => {
    const generateIntent = vi.fn(() => new Promise<never>(() => undefined));

    const decision = await resolveComposerAutomationRequest({
      message: "/automation ogni domenica alle 9 controlla CI",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent,
      generateIntentTimeoutMs: 1,
    });

    expect(generateIntent).toHaveBeenCalledTimes(1);
    expect(decision).toMatchObject({
      type: "automation",
      resolution: {
        source: "deterministic",
        mode: "heartbeat",
        intent: {
          prompt: "controlla CI",
          executionScope: "thread",
          schedule: { type: "weekly", dayOfWeek: 0, timeOfDay: "09:00" },
        },
      },
    });
  });

  it("opens review when AI prompt enrichment needs confirmation", async () => {
    const generateIntent = vi.fn(async () => ({
      isAutomation: true,
      confidence: 0.94,
      language: "en",
      name: "Check deployment",
      taskPrompt: "Check the deployment status and report any ambiguous result.",
      schedule: { type: "interval" as const, everySeconds: 21_600 },
      mode: "heartbeat" as const,
      completionPolicy: { type: "none" as const },
      missingFields: [],
      needsConfirmation: true,
      reason: "The target is vague.",
    }));

    const decision = await resolveComposerAutomationRequest({
      message: "check it every 6h",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent,
    });

    expect(decision).toMatchObject({
      type: "automation",
      resolution: {
        generatedNeedsConfirmation: true,
        reason: "The target is vague.",
        intent: {
          prompt: "Check the deployment status and report any ambiguous result.",
        },
      },
    });
    if (decision.type !== "automation") {
      throw new Error("Expected automation decision");
    }
    const draft = buildComposerAutomationDraft({
      resolution: decision.resolution,
      projectId: PROJECT_ID,
      projectModelSelection: MODEL_SELECTION,
      selectedModelSelection: MODEL_SELECTION,
      targetThreadId: THREAD_ID,
      hasEphemeralContext: false,
    });

    expect(draft.needsDraftReview).toBe(true);
    expect(draft.warnings.map((warning) => warning.id)).toContain("generated-low-confidence");
  });

  it("builds an auto-submittable thread heartbeat draft for bounded fast loops", async () => {
    const generateIntent = vi.fn(async () => ({
      isAutomation: true,
      confidence: 0.96,
      language: "en",
      name: "Say hi",
      taskPrompt: "Every 15 seconds, say hi in this thread for 3 times.",
      schedule: { type: "interval" as const, everySeconds: 15 },
      mode: "heartbeat" as const,
      completionPolicy: { type: "none" as const },
      missingFields: [],
      needsConfirmation: true,
      reason: "Fast interval",
    }));

    const decision = await resolveComposerAutomationRequest({
      message: "/automation say hi every 15 seconds for 3 times",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent,
    });
    expect(decision).toMatchObject({
      type: "automation",
      automationMessage: "say hi every 15 seconds for 3 times",
      resolution: {
        mode: "heartbeat",
        intent: {
          prompt: "say hi",
          maxIterations: 3,
          executionScope: "thread",
          schedule: { type: "interval", everySeconds: 15 },
        },
      },
    });
    expect(generateIntent).not.toHaveBeenCalled();

    if (decision.type !== "automation") {
      throw new Error("Expected automation decision");
    }
    const draft = buildComposerAutomationDraft({
      resolution: decision.resolution,
      projectId: PROJECT_ID,
      projectModelSelection: MODEL_SELECTION,
      selectedModelSelection: MODEL_SELECTION,
      targetThreadId: THREAD_ID,
      hasEphemeralContext: false,
    });

    expect(draft.needsDraftReview).toBe(false);
    expect(draft.form).toMatchObject({
      mode: "heartbeat",
      targetThreadId: THREAD_ID,
      runtimeMode: "approval-required",
      maxIterations: "3",
      prompt: "say hi",
    });
    expect(draft.warnings.map((warning) => warning.id)).toEqual(["fast-recurring-interval"]);
    expect(Array.from(draft.acknowledgedWarningIds)).toEqual(["fast-recurring-interval"]);
  });

  it("auto-submits fast loops when the run cap is written as a total", async () => {
    const generateIntent = vi.fn(async () => {
      throw new Error("bounded fast loops should not need generation");
    });

    const decision = await resolveComposerAutomationRequest({
      message: "/automation say hi every 15 seconds 3 times total",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent,
    });
    expect(decision).toMatchObject({
      type: "automation",
      resolution: {
        mode: "heartbeat",
        intent: {
          prompt: "say hi",
          maxIterations: 3,
          executionScope: "thread",
          schedule: { type: "interval", everySeconds: 15 },
        },
      },
    });
    expect(generateIntent).not.toHaveBeenCalled();

    if (decision.type !== "automation") {
      throw new Error("Expected automation decision");
    }
    const draft = buildComposerAutomationDraft({
      resolution: decision.resolution,
      projectId: PROJECT_ID,
      projectModelSelection: MODEL_SELECTION,
      selectedModelSelection: MODEL_SELECTION,
      targetThreadId: THREAD_ID,
      hasEphemeralContext: false,
    });

    expect(draft.needsDraftReview).toBe(false);
    expect(draft.form).toMatchObject({
      mode: "heartbeat",
      targetThreadId: THREAD_ID,
      maxIterations: "3",
      prompt: "say hi",
    });
    expect(Array.from(draft.acknowledgedWarningIds)).toEqual(["fast-recurring-interval"]);
  });

  it("keeps explicit standalone drafts behind review with risks unacknowledged", async () => {
    const generateIntent = vi.fn(async () => {
      throw new Error("offline generation falls back to deterministic intent");
    });

    const decision = await resolveComposerAutomationRequest({
      message: "/automation run standalone say hi every 15 seconds for 3 times",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent,
    });
    expect(decision).toMatchObject({
      type: "automation",
      resolution: {
        mode: "standalone",
        intent: {
          prompt: "say hi",
          maxIterations: 3,
          executionScope: "standalone",
        },
      },
    });

    if (decision.type !== "automation") {
      throw new Error("Expected automation decision");
    }
    const draft = buildComposerAutomationDraft({
      resolution: decision.resolution,
      projectId: PROJECT_ID,
      projectModelSelection: MODEL_SELECTION,
      selectedModelSelection: MODEL_SELECTION,
      targetThreadId: null,
      hasEphemeralContext: false,
    });

    expect(draft.needsDraftReview).toBe(true);
    expect(draft.form).toMatchObject({
      mode: "standalone",
      targetThreadId: "",
      worktreeMode: "auto",
      maxIterations: "3",
    });
    expect(draft.warnings.map((warning) => warning.id)).toEqual([
      "fast-recurring-interval",
      "local-checkout",
      "worktree-cleanup",
    ]);
    expect(Array.from(draft.acknowledgedWarningIds)).toEqual([]);
  });
});

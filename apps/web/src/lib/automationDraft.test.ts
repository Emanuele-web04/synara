// FILE: automationDraft.test.ts
// Purpose: Locks down automation creation draft warnings.
// Layer: Web lib test
// Depends on: automationDraft warning helpers.

import { describe, expect, it } from "vitest";

import {
  acknowledgedWarningIdsForAutomaticChatAutomation,
  acknowledgedRiskIdsForDraft,
  buildAutomationDraftWarnings,
  hasBlockingAutomationDraftWarnings,
  warningIdsForAcknowledgedRisks,
} from "./automationDraft";

describe("automation draft warnings", () => {
  it("surfaces skill references and standalone worktree cleanup risk", () => {
    const warnings = buildAutomationDraftWarnings({
      schedule: { type: "interval", everySeconds: 300 },
      mode: "standalone",
      runtimeMode: "approval-required",
      worktreeMode: "worktree",
      hasEphemeralContext: false,
      generatedConfidence: null,
      generatedNeedsConfirmation: false,
      prompt: "Use $sentry to inspect crashes.",
    });

    expect(warnings.map((warning) => warning.id)).toEqual(["worktree-cleanup", "skill-reference"]);
  });

  it("blocks direct submission when composer context is not persisted", () => {
    const warnings = buildAutomationDraftWarnings({
      schedule: { type: "interval", everySeconds: 300 },
      mode: "heartbeat",
      runtimeMode: "approval-required",
      worktreeMode: "auto",
      hasEphemeralContext: true,
      generatedConfidence: null,
      generatedNeedsConfirmation: false,
      prompt: "Check the Linear issue.",
    });

    expect(warnings).toMatchObject([
      {
        id: "attachments-not-persisted",
        requiresAcknowledgement: true,
      },
    ]);
    expect(warnings[0]?.detail).toContain("provider mentions");
    expect(hasBlockingAutomationDraftWarnings(warnings, new Set())).toBe(true);
  });

  it("requires acknowledgement for standalone auto fallback to local checkout", () => {
    const warnings = buildAutomationDraftWarnings({
      schedule: { type: "interval", everySeconds: 300 },
      mode: "standalone",
      runtimeMode: "approval-required",
      worktreeMode: "auto",
      hasEphemeralContext: false,
      generatedConfidence: null,
      generatedNeedsConfirmation: false,
      prompt: "Check stale dependencies.",
    });

    expect(warnings).toMatchObject([
      {
        id: "local-checkout",
        requiresAcknowledgement: true,
      },
      {
        id: "worktree-cleanup",
        requiresAcknowledgement: false,
      },
    ]);
    expect(acknowledgedRiskIdsForDraft(warnings, new Set(["local-checkout"]))).toEqual([
      "local-checkout",
    ]);
  });

  it("maps acknowledged blocking warnings into persisted risk ids", () => {
    const warnings = buildAutomationDraftWarnings({
      schedule: { type: "interval", everySeconds: 30 },
      mode: "standalone",
      runtimeMode: "full-access",
      worktreeMode: "local",
      hasEphemeralContext: false,
      generatedConfidence: null,
      generatedNeedsConfirmation: false,
      prompt: "Fix flaky tests.",
    });

    expect(
      acknowledgedRiskIdsForDraft(
        warnings,
        new Set(["fast-recurring-interval", "full-access", "local-checkout"]),
      ),
    ).toEqual(["fast-interval", "full-access", "local-checkout"]);
  });

  it("maps persisted risk ids back to warning acknowledgements", () => {
    expect(
      Array.from(
        warningIdsForAcknowledgedRisks(["fast-interval", "full-access", "local-checkout"]),
      ),
    ).toEqual(["fast-recurring-interval", "full-access", "local-checkout"]);
  });

  it("blocks submission until required warning acknowledgements are present", () => {
    const warnings = buildAutomationDraftWarnings({
      schedule: { type: "interval", everySeconds: 30 },
      mode: "standalone",
      runtimeMode: "full-access",
      worktreeMode: "local",
      hasEphemeralContext: false,
      generatedConfidence: null,
      generatedNeedsConfirmation: false,
      prompt: "Fix flaky tests.",
    });

    expect(hasBlockingAutomationDraftWarnings(warnings, new Set())).toBe(true);
    expect(
      hasBlockingAutomationDraftWarnings(
        warnings,
        new Set(["fast-recurring-interval", "full-access", "local-checkout"]),
      ),
    ).toBe(false);
  });

  it("auto-acknowledges bounded thread fast loops without hiding standalone risks", () => {
    const threadWarnings = buildAutomationDraftWarnings({
      schedule: { type: "interval", everySeconds: 15 },
      mode: "heartbeat",
      runtimeMode: "approval-required",
      worktreeMode: "auto",
      hasEphemeralContext: false,
      generatedConfidence: null,
      generatedNeedsConfirmation: false,
      prompt: "Say hi.",
    });

    const boundedIds = acknowledgedWarningIdsForAutomaticChatAutomation({
      warnings: threadWarnings,
      maxIterations: 3,
      executionScope: "thread",
    });
    expect(Array.from(boundedIds)).toEqual(["fast-recurring-interval"]);
    expect(hasBlockingAutomationDraftWarnings(threadWarnings, boundedIds)).toBe(false);
    expect(acknowledgedRiskIdsForDraft(threadWarnings, boundedIds)).toEqual(["fast-interval"]);

    const unboundedIds = acknowledgedWarningIdsForAutomaticChatAutomation({
      warnings: threadWarnings,
      maxIterations: null,
      executionScope: "thread",
    });
    expect(Array.from(unboundedIds)).toEqual([]);
    expect(hasBlockingAutomationDraftWarnings(threadWarnings, unboundedIds)).toBe(true);

    const standaloneWarnings = buildAutomationDraftWarnings({
      schedule: { type: "interval", everySeconds: 15 },
      mode: "standalone",
      runtimeMode: "approval-required",
      worktreeMode: "auto",
      hasEphemeralContext: false,
      generatedConfidence: null,
      generatedNeedsConfirmation: false,
      prompt: "Say hi.",
    });
    const standaloneIds = acknowledgedWarningIdsForAutomaticChatAutomation({
      warnings: standaloneWarnings,
      maxIterations: 3,
      executionScope: "standalone",
    });
    expect(Array.from(standaloneIds)).toEqual([]);
    expect(hasBlockingAutomationDraftWarnings(standaloneWarnings, standaloneIds)).toBe(true);
  });

  it("does not show worktree cleanup risk for heartbeat runs", () => {
    const warnings = buildAutomationDraftWarnings({
      schedule: { type: "interval", everySeconds: 300 },
      mode: "heartbeat",
      runtimeMode: "approval-required",
      worktreeMode: "auto",
      hasEphemeralContext: false,
      generatedConfidence: null,
      generatedNeedsConfirmation: false,
      prompt: "Check this thread.",
    });

    expect(warnings.map((warning) => warning.id)).not.toContain("local-checkout");
    expect(warnings.map((warning) => warning.id)).not.toContain("worktree-cleanup");
  });
});

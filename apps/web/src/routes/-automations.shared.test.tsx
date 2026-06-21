// FILE: -automations.shared.test.tsx
// Purpose: Verifies pure automation UI helpers for schedule and triage behavior.
// Layer: Web route helper test
// Depends on: -automations.shared exported helper functions.

import {
  AutomationId,
  AutomationRunId,
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type AutomationDefinition,
  type AutomationRun,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  applyScheduleToForm,
  allVisibleTriageRuns,
  applyAutomationEvent,
  automationAttentionCount,
  canCancelAutomationRun,
  datetimeLocalFromIso,
  formatCadence,
  formatSchedule,
  formFromDefinition,
  isoFromDatetimeLocal,
  isFormSubmittable,
  modelSelectionForProjectChange,
  runResultSummary,
  scheduleKindFromSchedule,
  scheduleFromForm,
  updateWeeklyScheduleDay,
  updateWeeklyScheduleTime,
  unresolvedTriageRuns,
} from "./-automations.shared";

const runId = (value: string) => AutomationRunId.makeUnsafe(value);
const automationId = (value: string) => AutomationId.makeUnsafe(value);
const projectId = (value: string) => ProjectId.makeUnsafe(value);
const threadId = (value: string) => ThreadId.makeUnsafe(value);
const commandId = (value: string) => CommandId.makeUnsafe(value);
const messageId = (value: string) => MessageId.makeUnsafe(value);

const baseRun: AutomationRun = {
  id: runId("run-1"),
  automationId: automationId("automation-1"),
  projectId: projectId("project-1"),
  threadId: threadId("thread-1"),
  turnId: null,
  trigger: { type: "scheduled" },
  status: "succeeded",
  scheduledFor: "2026-06-19T10:00:00.000Z",
  claimedBy: null,
  claimedAt: null,
  leaseExpiresAt: null,
  startedAt: "2026-06-19T10:00:00.000Z",
  finishedAt: "2026-06-19T10:01:00.000Z",
  threadCreateCommandId: commandId("cmd-thread-create"),
  turnStartCommandId: commandId("cmd-turn-start"),
  messageId: messageId("message-1"),
  error: null,
  result: {
    outcome: "unknown",
    summary: "Review run output.",
    unread: true,
    archivedAt: null,
  },
  permissionSnapshot: {
    provider: "codex",
    modelSelection: { provider: "codex", model: "gpt-5-codex" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    worktreeMode: "auto",
    allowedCapabilities: ["send-turn"],
    createdAt: "2026-06-19T10:00:00.000Z",
  },
  createdAt: "2026-06-19T10:00:00.000Z",
  updatedAt: "2026-06-19T10:01:00.000Z",
};

const baseDefinition: AutomationDefinition = {
  id: automationId("automation-1"),
  projectId: projectId("project-1"),
  sourceThreadId: null,
  name: "Check status",
  prompt: "Check status.",
  schedule: { type: "interval", everySeconds: 3600 },
  enabled: true,
  nextRunAt: "2026-06-19T11:00:00.000Z",
  modelSelection: { provider: "codex", model: "gpt-5-codex" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  worktreeMode: "auto",
  mode: "standalone",
  targetThreadId: null,
  maxIterations: null,
  stopOnError: true,
  minimumIntervalSeconds: 60,
  maxRuntimeSeconds: 3600,
  retryPolicy: { type: "none" },
  misfirePolicy: "coalesce",
  acknowledgedRisks: [],
  iterationCount: 0,
  createdAt: "2026-06-19T10:00:00.000Z",
  updatedAt: "2026-06-19T10:00:00.000Z",
  archivedAt: null,
};

function runWith(overrides: Partial<AutomationRun>): AutomationRun {
  return { ...baseRun, ...overrides };
}

function definitionWith(overrides: Partial<AutomationDefinition>): AutomationDefinition {
  return { ...baseDefinition, ...overrides };
}

describe("automation shared route helpers", () => {
  it("preserves manual and new schedule kinds", () => {
    expect(scheduleKindFromSchedule({ type: "manual" })).toBe("manual");
    expect(scheduleKindFromSchedule({ type: "once", runAt: "2026-06-19T10:15:00.000Z" })).toBe(
      "once",
    );
    expect(
      scheduleKindFromSchedule({
        type: "cron",
        expression: "0 9 * * *",
        timezone: "Europe/Rome",
      }),
    ).toBe("cron");
  });

  it("counts only unread unarchived triage runs", () => {
    const unresolved = runWith({ id: runId("run-unresolved") });
    const read = runWith({
      id: runId("run-read"),
      result: { ...baseRun.result!, unread: false },
    });
    const archived = runWith({
      id: runId("run-archived"),
      result: { ...baseRun.result!, archivedAt: "2026-06-19T10:05:00.000Z" },
    });
    const noResult = runWith({ id: runId("run-no-result"), result: null });
    const failedWithoutResult = runWith({
      id: runId("run-failed-no-result"),
      status: "failed",
      result: null,
    });

    const runs = [unresolved, read, archived, noResult, failedWithoutResult];

    expect(unresolvedTriageRuns(runs).map((run) => run.id)).toEqual([
      "run-unresolved",
      "run-failed-no-result",
    ]);
    expect(automationAttentionCount(runs)).toBe(2);
    expect(allVisibleTriageRuns(runs).map((run) => run.id)).toEqual([
      "run-unresolved",
      "run-read",
      "run-failed-no-result",
    ]);
  });

  it("allows cancelling active and waiting runs only", () => {
    expect(canCancelAutomationRun(runWith({ status: "pending" }))).toBe(true);
    expect(canCancelAutomationRun(runWith({ status: "running" }))).toBe(true);
    expect(canCancelAutomationRun(runWith({ status: "waiting-for-approval" }))).toBe(true);
    expect(canCancelAutomationRun(runWith({ status: "succeeded" }))).toBe(false);
    expect(canCancelAutomationRun(runWith({ status: "cancelled" }))).toBe(false);
  });

  it("uses human labels for resultless and unknown-result runs", () => {
    expect(runResultSummary(runWith({ result: null, status: "waiting-for-approval" }))).toBe(
      "Waiting for approval",
    );
    expect(
      runResultSummary(
        runWith({
          result: { ...baseRun.result!, summary: null, outcome: "unknown" },
          status: "succeeded",
        }),
      ),
    ).toBe("Completed; open the thread for the reply");
  });

  it("round-trips one-shot datetimes through datetime-local values", () => {
    const runAt = "2026-06-19T10:00:00.000Z";

    expect(isoFromDatetimeLocal(datetimeLocalFromIso(runAt))).toBe(runAt);
  });

  it("preserves one-shot datetime seconds through datetime-local values", () => {
    const runAt = "2026-06-19T10:00:15.000Z";

    expect(isoFromDatetimeLocal(datetimeLocalFromIso(runAt))).toBe(runAt);
  });

  it("preserves sub-minute custom intervals through the form state", () => {
    const form = applyScheduleToForm(formFromDefinition(null, "project-1"), {
      type: "interval",
      everySeconds: 15,
    });

    expect(form.intervalAmount).toBe("15");
    expect(form.intervalUnit).toBe("seconds");
    expect(scheduleFromForm(form)).toEqual({ type: "interval", everySeconds: 15 });
  });

  it("preserves non-minute interval cadences through the form state", () => {
    const form = applyScheduleToForm(formFromDefinition(null, "project-1"), {
      type: "interval",
      everySeconds: 90,
    });

    expect(form.intervalAmount).toBe("90");
    expect(form.intervalUnit).toBe("seconds");
    expect(scheduleFromForm(form)).toEqual({ type: "interval", everySeconds: 90 });
  });

  it("labels non-minute interval cadences without rounding", () => {
    const schedule = { type: "interval", everySeconds: 90 } as const;

    expect(formatSchedule(schedule)).toBe("Every 90 sec");
    expect(formatCadence(schedule)).toBe("Every 90s");
  });

  it("refreshes the default model when the current model came from the old project", () => {
    const projects = [
      {
        id: projectId("project-old"),
        defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
      },
      {
        id: projectId("project-new"),
        defaultModelSelection: { provider: "claudeAgent", model: "sonnet" },
      },
    ] as Parameters<typeof modelSelectionForProjectChange>[0];

    expect(
      modelSelectionForProjectChange(projects, "project-old", "project-new", {
        provider: "codex",
        model: "gpt-5-codex",
      }),
    ).toEqual({ provider: "claudeAgent", model: "sonnet" });
  });

  it("preserves an explicitly chosen model when switching projects", () => {
    const projects = [
      {
        id: projectId("project-old"),
        defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
      },
      {
        id: projectId("project-new"),
        defaultModelSelection: { provider: "claudeAgent", model: "sonnet" },
      },
    ] as Parameters<typeof modelSelectionForProjectChange>[0];

    expect(
      modelSelectionForProjectChange(projects, "project-old", "project-new", {
        provider: "cursor",
        model: "cursor-default",
      }),
    ).toEqual({ provider: "cursor", model: "cursor-default" });
  });

  it("preserves timezone when changing weekly day and time", () => {
    const schedule = {
      type: "weekly",
      dayOfWeek: 1,
      timeOfDay: "09:30",
      timezone: "Europe/Rome",
    } as const;

    expect(updateWeeklyScheduleDay(schedule, 5)).toEqual({
      type: "weekly",
      dayOfWeek: 5,
      timeOfDay: "09:30",
      timezone: "Europe/Rome",
    });
    expect(updateWeeklyScheduleTime(schedule, "14:45")).toEqual({
      type: "weekly",
      dayOfWeek: 1,
      timeOfDay: "14:45",
      timezone: "Europe/Rome",
    });
  });

  it("preserves legacy UTC semantics for stored wall-clock schedules without timezone", () => {
    const form = formFromDefinition(
      definitionWith({
        schedule: { type: "daily", timeOfDay: "09:00" },
      }),
      "project-1",
    );

    expect(form.timezone).toBe("UTC");
    expect(scheduleFromForm(form)).toEqual({
      type: "daily",
      timeOfDay: "09:00",
      timezone: "UTC",
    });
  });

  it("requires timezone text for timezone-based schedules", () => {
    const form = {
      ...formFromDefinition(null, "project-1"),
      name: "Check status",
      prompt: "Check status",
      timezone: "",
    };

    expect(isFormSubmittable(form)).toBe(false);
    expect(isFormSubmittable({ ...form, timezone: "UTC" })).toBe(true);
  });

  it("keeps a newer run update when an older automation snapshot arrives later", () => {
    const staleRun = runWith({
      id: runId("run-cache-race"),
      result: { ...baseRun.result!, unread: true },
      updatedAt: "2026-06-19T10:01:00.000Z",
    });
    const newerRun = runWith({
      ...staleRun,
      result: { ...baseRun.result!, unread: false },
      updatedAt: "2026-06-19T10:02:00.000Z",
    });

    const afterLiveUpdate = applyAutomationEvent(
      { definitions: [baseDefinition], runs: [staleRun] },
      { type: "run-upserted", run: newerRun },
    );
    const afterLateSnapshot = applyAutomationEvent(afterLiveUpdate, {
      type: "snapshot",
      definitions: [baseDefinition],
      runs: [staleRun],
    });

    expect(afterLateSnapshot.runs.find((run) => run.id === newerRun.id)?.result?.unread).toBe(
      false,
    );
  });

  it("does not resurrect a deleted automation from a late snapshot", () => {
    const deletedDefinition = definitionWith({
      id: automationId("automation-deleted-cache-race"),
    });
    const deletedRun = runWith({
      id: runId("run-deleted-cache-race"),
      automationId: deletedDefinition.id,
    });

    const afterDelete = applyAutomationEvent(
      { definitions: [deletedDefinition], runs: [deletedRun] },
      { type: "definition-deleted", automationId: deletedDefinition.id },
    );
    const afterLateSnapshot = applyAutomationEvent(afterDelete, {
      type: "snapshot",
      definitions: [deletedDefinition],
      runs: [deletedRun],
    });

    expect(afterLateSnapshot.definitions).toEqual([]);
    expect(afterLateSnapshot.runs).toEqual([]);
  });

  it("drops definitions and runs that disappear from a reconnect snapshot", () => {
    const deletedDefinition = definitionWith({
      id: automationId("automation-missed-delete"),
    });
    const deletedRun = runWith({
      id: runId("run-missed-delete"),
      automationId: deletedDefinition.id,
    });

    const afterReconnectSnapshot = applyAutomationEvent(
      { definitions: [deletedDefinition], runs: [deletedRun] },
      {
        type: "snapshot",
        definitions: [],
        runs: [],
      },
    );

    expect(afterReconnectSnapshot.definitions).toEqual([]);
    expect(afterReconnectSnapshot.runs).toEqual([]);
  });

  it("drops runs that disappear from a reconnect snapshot for an existing definition", () => {
    const definition = definitionWith({
      id: automationId("automation-existing-definition"),
    });
    const deletedRun = runWith({
      id: runId("run-missed-delete-existing-definition"),
      automationId: definition.id,
    });

    const afterReconnectSnapshot = applyAutomationEvent(
      { definitions: [definition], runs: [deletedRun] },
      {
        type: "snapshot",
        definitions: [definition],
        runs: [],
      },
    );

    expect(afterReconnectSnapshot.definitions).toEqual([definition]);
    expect(afterReconnectSnapshot.runs).toEqual([]);
  });
});

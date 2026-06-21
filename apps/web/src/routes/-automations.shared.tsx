import {
  type AutomationCreateInput,
  type AutomationDefinition,
  type AutomationId,
  type AutomationListResult,
  type AutomationMode,
  type AutomationRun,
  type AutomationRunResult,
  type AutomationSchedule,
  type AutomationStreamEvent,
  type AutomationUpdateInput,
  type AutomationWorktreeMode,
  type ModelSelection,
  type ProjectId,
  type ProviderKind,
  type ProviderStartOptions,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { useAppSettings } from "~/appSettings";
import {
  ComposerPickerMenuPopup,
  ComposerPickerMenuSubPopup,
} from "~/components/chat/ComposerPickerMenuPopup";
import { ProviderModelPicker } from "~/components/chat/ProviderModelPicker";
import { Button } from "~/components/ui/button";
import { Dialog, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { TimePicker } from "~/components/ui/time-picker";
import { toastManager } from "~/components/ui/toast";
import {
  acknowledgedRiskIdsForDraft,
  buildAutomationDraftWarnings,
  hasBlockingAutomationDraftWarnings,
  type AutomationDraftWarning,
  type AutomationDraftWarningId,
} from "~/lib/automationDraft";
import {
  completionPolicyFromStopWhen,
  stopWhenFromCompletionPolicy,
} from "~/lib/automationCompletionPolicy";
import {
  BrainIcon,
  ChevronDownIcon,
  ClockIcon,
  FolderIcon,
  InfoIcon,
  SkillCubeIcon,
  WorktreeIcon,
  XIcon,
} from "~/lib/icons";
import { resolveProviderDiscoveryCwd } from "~/lib/providerDiscovery";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { ensureNativeApi } from "~/nativeApi";
import { buildModelSelection } from "~/providerModelOptions";
import { useProviderModelCatalog } from "~/hooks/useProviderModelCatalog";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { useStore } from "~/store";
import { resolveThreadPickerTitle } from "./-chatThreadRoute.logic";

export const automationQueryKey = ["automations"] as const;
export const defaultModelSelection: ModelSelection = {
  provider: "codex",
  model: "gpt-5-codex",
};
export const EMPTY_AUTOMATION_LIST: AutomationListResult = { definitions: [], runs: [] };
export const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const LEGACY_WALL_CLOCK_TIMEZONE = "UTC";

/** Starter prompts surfaced behind the composer's "Use template" button. */
export const AUTOMATION_TEMPLATES: readonly {
  readonly label: string;
  readonly name: string;
  readonly prompt: string;
}[] = [
  {
    label: "Triage new crashes",
    name: "Triage crashes",
    prompt: "Look for new crashes in $sentry and open a fix PR for the most impactful one.",
  },
  {
    label: "Update dependencies",
    name: "Update dependencies",
    prompt:
      "Check for outdated dependencies, bump the safe minor and patch versions, then run the tests.",
  },
  {
    label: "Daily standup summary",
    name: "Daily summary",
    prompt:
      "Summarize what changed on the main branch in the last 24 hours as a short standup update.",
  },
];

/** UI-level cadence options shown in the schedule picker (each maps onto an AutomationSchedule). */
export type ScheduleKind =
  | "manual"
  | "once"
  | "hourly"
  | "daily"
  | "weekdays"
  | "weekly"
  | "custom"
  | "cron";

export const SCHEDULE_KIND_OPTIONS: readonly { value: ScheduleKind; label: string }[] = [
  { value: "manual", label: "Manual" },
  { value: "once", label: "Once" },
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" },
  { value: "custom", label: "Custom" },
  { value: "cron", label: "Cron" },
];

/** Pick the schedule option that represents a stored schedule (interval 1h reads as "Hourly"). */
export function scheduleKindFromSchedule(schedule: AutomationSchedule): ScheduleKind {
  switch (schedule.type) {
    case "daily":
      return "daily";
    case "weekdays":
      return "weekdays";
    case "weekly":
      return "weekly";
    case "interval":
      return schedule.everySeconds === 3600 ? "hourly" : "custom";
    case "manual":
      return "manual";
    case "once":
      return "once";
    case "cron":
      return "cron";
  }
}

/** Build a schedule for the chosen kind, reusing time/day/interval from `current` where it applies. */
export function scheduleFromKind(
  kind: ScheduleKind,
  current: AutomationSchedule,
  fallbackTimezone: string = localTimezone(),
): AutomationSchedule {
  const timeOfDay =
    current.type === "daily" || current.type === "weekly" || current.type === "weekdays"
      ? current.timeOfDay
      : "09:00";
  const timezone = scheduleTimezone(current, fallbackTimezone);
  switch (kind) {
    case "manual":
      return { type: "manual" };
    case "once":
      return { type: "once", runAt: new Date(Date.now() + 15 * 60_000).toISOString() };
    case "hourly":
      return { type: "interval", everySeconds: 3600 };
    case "custom":
      return {
        type: "interval",
        everySeconds:
          current.type === "interval" && current.everySeconds !== 3600
            ? current.everySeconds
            : 1800,
      };
    case "daily":
      return { type: "daily", timeOfDay, timezone };
    case "weekdays":
      return { type: "weekdays", timeOfDay, timezone };
    case "weekly":
      return {
        type: "weekly",
        dayOfWeek: current.type === "weekly" ? current.dayOfWeek : 1,
        timeOfDay,
        timezone,
      };
    case "cron":
      return {
        type: "cron",
        expression: current.type === "cron" ? current.expression : "0 9 * * *",
        timezone,
      };
  }
}

export type AutomationFormState = {
  readonly name: string;
  readonly projectId: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly scheduleKind: ScheduleKind;
  readonly intervalAmount: string;
  readonly intervalUnit: IntervalUnit;
  readonly timeOfDay: string;
  readonly dayOfWeek: string;
  readonly onceRunAt: string;
  readonly cronExpression: string;
  readonly timezone: string;
  readonly runtimeMode: RuntimeMode;
  readonly worktreeMode: AutomationWorktreeMode;
  readonly modelSelection: ModelSelection;
  readonly mode: AutomationMode;
  readonly targetThreadId: string;
  readonly maxIterations: string;
  readonly stopOnError: boolean;
  readonly stopWhen: string;
};

type IntervalUnit = "seconds" | "minutes";

function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function scheduleTimezone(schedule: AutomationSchedule, fallbackTimezone: string): string {
  return (
    (schedule.type === "daily" ||
    schedule.type === "weekly" ||
    schedule.type === "weekdays" ||
    schedule.type === "cron"
      ? schedule.timezone
      : undefined) ?? fallbackTimezone
  );
}

export function datetimeLocalFromIso(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60_000;
  const localIso = new Date(date.getTime() - offsetMs).toISOString();
  return localIso.slice(0, date.getSeconds() === 0 && date.getMilliseconds() === 0 ? 16 : 19);
}

export function isoFromDatetimeLocal(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? new Date(Date.now() + 15 * 60_000).toISOString()
    : date.toISOString();
}

export function updateWeeklyScheduleDay(
  schedule: Extract<AutomationSchedule, { type: "weekly" }>,
  dayOfWeek: number,
): AutomationSchedule {
  return { ...schedule, dayOfWeek };
}

export function updateWeeklyScheduleTime(
  schedule: Extract<AutomationSchedule, { type: "weekly" }>,
  timeOfDay: string,
): AutomationSchedule {
  return { ...schedule, timeOfDay };
}

export function formatDateTime(value: string | null): string {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date)}`;
}

function timezoneSuffix(schedule: AutomationSchedule): string {
  if (
    (schedule.type === "daily" ||
      schedule.type === "weekdays" ||
      schedule.type === "weekly" ||
      schedule.type === "cron") &&
    schedule.timezone
  ) {
    return ` ${schedule.timezone}`;
  }
  return " UTC";
}

function formatIntervalSchedule(seconds: number): string {
  return seconds % 60 === 0 ? `Every ${seconds / 60} min` : `Every ${seconds} sec`;
}

function formatIntervalCadence(seconds: number): string {
  if (seconds === 3600) return "Hourly";
  if (seconds % 3600 === 0) return `Every ${seconds / 3600}h`;
  if (seconds % 60 === 0) return `Every ${seconds / 60}m`;
  return `Every ${seconds}s`;
}

export function formatSchedule(schedule: AutomationSchedule): string {
  switch (schedule.type) {
    case "manual":
      return "Manual";
    case "once":
      return `Once ${formatDateTime(schedule.runAt)}`;
    case "interval":
      return formatIntervalSchedule(schedule.everySeconds);
    case "daily":
      return `Daily ${schedule.timeOfDay}${timezoneSuffix(schedule)}`;
    case "weekdays":
      return `Weekdays ${schedule.timeOfDay}${timezoneSuffix(schedule)}`;
    case "weekly":
      return `Weekly ${weekdayLabel(schedule.dayOfWeek)} ${schedule.timeOfDay}${timezoneSuffix(schedule)}`;
    case "cron":
      return `Cron ${schedule.expression} ${schedule.timezone}`;
  }
}

/** "09:00" -> "9:00": drops the leading zero on the hour for friendlier cadence labels. */
export function formatClockTime(timeOfDay: string): string {
  const [hours, minutes] = timeOfDay.split(":");
  const hour = Number.parseInt(hours ?? "", 10);
  if (Number.isNaN(hour)) return timeOfDay;
  return `${hour}:${minutes ?? "00"}`;
}

export function formatCadence(schedule: AutomationSchedule): string {
  switch (schedule.type) {
    case "manual":
      return "Manual";
    case "once":
      return formatDateTime(schedule.runAt);
    case "interval":
      return formatIntervalCadence(schedule.everySeconds);
    case "daily":
      return `Daily at ${formatClockTime(schedule.timeOfDay)}`;
    case "weekdays":
      return `Weekdays at ${formatClockTime(schedule.timeOfDay)}`;
    case "weekly":
      return `${weekdayLabel(schedule.dayOfWeek)} at ${formatClockTime(schedule.timeOfDay)}`;
    case "cron":
      return `Cron ${schedule.expression}`;
  }
}

export function formatRelativeTime(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w`;
  return `${Math.floor(days / 30)}mo`;
}

export function weekdayLabel(value: number): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][value] ?? "Sun";
}

export function runStatusVariant(
  status: AutomationRun["status"],
): "success" | "warning" | "error" | "info" | "outline" {
  switch (status) {
    case "succeeded":
      return "success";
    case "failed":
    case "cancelled":
    case "interrupted":
      return "error";
    case "waiting-for-approval":
    case "skipped":
      return "warning";
    case "running":
    case "claimed":
    case "pending":
      return "info";
  }
}

export function isTriageRun(run: AutomationRun): boolean {
  if (run.result) {
    return isUnresolvedTriageResult(run.result);
  }
  return (
    run.status === "failed" ||
    run.status === "cancelled" ||
    run.status === "interrupted" ||
    run.status === "waiting-for-approval"
  );
}

export function isUnresolvedTriageResult(result: AutomationRunResult | null): boolean {
  return Boolean(result && result.unread && result.archivedAt === null);
}

export function unresolvedTriageRuns(runs: readonly AutomationRun[]): AutomationRun[] {
  return runs.filter((run) => isTriageRun(run));
}

export function allVisibleTriageRuns(runs: readonly AutomationRun[]): AutomationRun[] {
  return runs.filter((run) => {
    if (run.result) {
      return run.result.archivedAt === null;
    }
    return isTriageRun(run);
  });
}

export function automationAttentionCount(runs: readonly AutomationRun[]): number {
  return unresolvedTriageRuns(runs).length;
}

export function runStatusLabel(status: AutomationRun["status"]): string {
  switch (status) {
    case "pending":
      return "Queued";
    case "claimed":
      return "Starting";
    case "running":
      return "Running";
    case "waiting-for-approval":
      return "Waiting for approval";
    case "succeeded":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Interrupted";
    case "skipped":
      return "Skipped";
  }
}

export function runResultSummary(run: AutomationRun): string {
  if (run.result?.summary) return run.result.summary;
  if (run.error) return run.error;
  switch (run.result?.outcome) {
    case "findings":
      return "Found something to review";
    case "no-findings":
      return "No findings";
    case "changed-files":
      return "Changed files";
    case "needs-attention":
      return "Needs attention";
    case "unknown":
      return run.threadId ? "Completed; open the thread for the reply" : "Completed";
    case undefined:
      return runStatusLabel(run.status);
  }
}

export function canCancelAutomationRun(run: AutomationRun): boolean {
  return (
    run.status === "pending" ||
    run.status === "claimed" ||
    run.status === "running" ||
    run.status === "waiting-for-approval"
  );
}

export function automationStatusDotClass(
  definition: AutomationDefinition,
  latestRun: AutomationRun | null,
): string {
  if (!definition.enabled) return "text-muted-foreground/40";
  if (
    latestRun?.status === "running" ||
    latestRun?.status === "pending" ||
    latestRun?.status === "claimed"
  ) {
    return "text-blue-500";
  }
  if (latestRun && isTriageRun(latestRun)) return "text-destructive";
  return "text-emerald-500";
}

function intervalFormPartsFromSeconds(everySeconds: number): {
  readonly amount: string;
  readonly unit: IntervalUnit;
} {
  return everySeconds >= 60 && everySeconds % 60 === 0
    ? { amount: String(everySeconds / 60), unit: "minutes" }
    : { amount: String(everySeconds), unit: "seconds" };
}

export function formFromDefinition(
  definition: AutomationDefinition | null,
  fallbackProjectId: string,
  fallbackModelSelection: ModelSelection = defaultModelSelection,
): AutomationFormState {
  // New automations default to a daily schedule (the most common automation cadence);
  // existing definitions keep whatever schedule they were saved with.
  const schedule = definition?.schedule ?? { type: "daily" as const, timeOfDay: "09:00" };
  const timezone = scheduleTimezone(
    schedule,
    definition ? LEGACY_WALL_CLOCK_TIMEZONE : localTimezone(),
  );
  return {
    name: definition?.name ?? "",
    projectId: definition?.projectId ?? fallbackProjectId,
    prompt: definition?.prompt ?? "",
    enabled: definition?.enabled ?? true,
    scheduleKind: scheduleKindFromSchedule(schedule),
    intervalAmount:
      schedule.type === "interval" && schedule.everySeconds !== 3600
        ? intervalFormPartsFromSeconds(schedule.everySeconds).amount
        : "30",
    intervalUnit:
      schedule.type === "interval" && schedule.everySeconds !== 3600
        ? intervalFormPartsFromSeconds(schedule.everySeconds).unit
        : "minutes",
    timeOfDay:
      schedule.type === "daily" || schedule.type === "weekly" || schedule.type === "weekdays"
        ? schedule.timeOfDay
        : "09:00",
    dayOfWeek: schedule.type === "weekly" ? String(schedule.dayOfWeek) : "1",
    onceRunAt:
      schedule.type === "once"
        ? datetimeLocalFromIso(schedule.runAt)
        : datetimeLocalFromIso(new Date(Date.now() + 15 * 60_000).toISOString()),
    cronExpression: schedule.type === "cron" ? schedule.expression : "0 9 * * *",
    timezone,
    runtimeMode: definition?.runtimeMode ?? "approval-required",
    worktreeMode: definition?.worktreeMode ?? "auto",
    modelSelection: definition?.modelSelection ?? fallbackModelSelection,
    mode: definition?.mode ?? "standalone",
    targetThreadId: definition?.targetThreadId ?? "",
    maxIterations: definition?.maxIterations != null ? String(definition.maxIterations) : "",
    stopOnError: definition?.stopOnError ?? true,
    stopWhen: definition ? stopWhenFromCompletionPolicy(definition.completionPolicy) : "",
  };
}

export function applyScheduleToForm(
  form: AutomationFormState,
  schedule: AutomationSchedule,
  fallbackTimezone: string = localTimezone(),
): AutomationFormState {
  const timezone = scheduleTimezone(schedule, fallbackTimezone);
  return {
    ...form,
    scheduleKind: scheduleKindFromSchedule(schedule),
    intervalAmount:
      schedule.type === "interval" && schedule.everySeconds !== 3600
        ? intervalFormPartsFromSeconds(schedule.everySeconds).amount
        : form.intervalAmount,
    intervalUnit:
      schedule.type === "interval" && schedule.everySeconds !== 3600
        ? intervalFormPartsFromSeconds(schedule.everySeconds).unit
        : form.intervalUnit,
    timeOfDay:
      schedule.type === "daily" || schedule.type === "weekly" || schedule.type === "weekdays"
        ? schedule.timeOfDay
        : form.timeOfDay,
    dayOfWeek: schedule.type === "weekly" ? String(schedule.dayOfWeek) : form.dayOfWeek,
    onceRunAt: schedule.type === "once" ? datetimeLocalFromIso(schedule.runAt) : form.onceRunAt,
    cronExpression: schedule.type === "cron" ? schedule.expression : form.cronExpression,
    timezone,
  };
}

export function scheduleFromForm(form: AutomationFormState): AutomationSchedule {
  const timezone = form.timezone.trim();
  switch (form.scheduleKind) {
    case "hourly":
      return { type: "interval", everySeconds: 3600 };
    case "manual":
      return { type: "manual" };
    case "once":
      return { type: "once", runAt: isoFromDatetimeLocal(form.onceRunAt) };
    case "custom": {
      const amount = Math.max(1, Number.parseInt(form.intervalAmount, 10) || 1);
      return {
        type: "interval",
        everySeconds: form.intervalUnit === "seconds" ? amount : amount * 60,
      };
    }
    case "daily":
      return { type: "daily", timeOfDay: form.timeOfDay, timezone };
    case "weekdays":
      return { type: "weekdays", timeOfDay: form.timeOfDay, timezone };
    case "weekly": {
      const dayOfWeek = Math.min(6, Math.max(0, Number.parseInt(form.dayOfWeek, 10) || 0));
      return { type: "weekly", dayOfWeek, timeOfDay: form.timeOfDay, timezone };
    }
    case "cron":
      return {
        type: "cron",
        expression: form.cronExpression.trim() || "0 9 * * *",
        timezone,
      };
  }
}

export function projectModelSelection(
  projects: ReturnType<typeof useStore.getState>["projects"],
  projectId: string,
) {
  return (
    projects.find((project) => project.id === projectId)?.defaultModelSelection ??
    defaultModelSelection
  );
}

function modelSelectionsMatch(left: ModelSelection, right: ModelSelection): boolean {
  const leftOptions = "options" in left ? left.options : undefined;
  const rightOptions = "options" in right ? right.options : undefined;
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    JSON.stringify(leftOptions ?? null) === JSON.stringify(rightOptions ?? null)
  );
}

// Automation edits keep their saved provider options unless the user changes models.
// On model changes, an empty object intentionally clears stale provider-specific options.
export function providerOptionsForAutomationModelSelection(
  definition: Pick<AutomationDefinition, "modelSelection" | "providerOptions">,
  nextModelSelection: ModelSelection,
  currentProviderOptions?: ProviderStartOptions,
): ProviderStartOptions | undefined {
  return modelSelectionsMatch(definition.modelSelection, nextModelSelection)
    ? definition.providerOptions
    : (currentProviderOptions ?? {});
}

export function providerOptionsForAutomationEdit(
  definition: Pick<AutomationDefinition, "modelSelection" | "providerOptions">,
  form: Pick<AutomationFormState, "modelSelection">,
  currentProviderOptions?: ProviderStartOptions,
): ProviderStartOptions | undefined {
  return providerOptionsForAutomationModelSelection(
    definition,
    form.modelSelection,
    currentProviderOptions,
  );
}

export function modelSelectionForProjectChange(
  projects: ReturnType<typeof useStore.getState>["projects"],
  currentProjectId: string,
  nextProjectId: string,
  currentModelSelection: ModelSelection,
): ModelSelection {
  const currentDefaultModelSelection = projectModelSelection(projects, currentProjectId);
  const nextDefaultModelSelection = projectModelSelection(projects, nextProjectId);
  return modelSelectionsMatch(currentModelSelection, currentDefaultModelSelection)
    ? nextDefaultModelSelection
    : currentModelSelection;
}

export function createInputFromForm(
  form: AutomationFormState,
  providerOptions?: ProviderStartOptions,
  acknowledgedRisks?: AutomationCreateInput["acknowledgedRisks"],
): AutomationCreateInput {
  const maxIterations = form.maxIterations.trim() ? Number.parseInt(form.maxIterations, 10) : null;
  const stopWhen = form.stopWhen.trim();
  return {
    name: form.name.trim(),
    projectId: form.projectId as ProjectId,
    prompt: form.prompt.trim(),
    schedule: scheduleFromForm(form),
    enabled: form.enabled,
    modelSelection: form.modelSelection,
    runtimeMode: form.runtimeMode,
    interactionMode: "default",
    worktreeMode: form.worktreeMode,
    ...(providerOptions ? { providerOptions } : {}),
    mode: form.mode,
    targetThreadId: form.mode === "heartbeat" ? (form.targetThreadId as ThreadId) : null,
    ...(form.mode === "heartbeat"
      ? {
          maxIterations,
          stopOnError: form.stopOnError,
          completionPolicy: completionPolicyFromStopWhen(stopWhen),
        }
      : { completionPolicy: { type: "none" as const } }),
    ...(acknowledgedRisks ? { acknowledgedRisks } : {}),
  };
}

export function updateInputFromForm(
  definition: AutomationDefinition,
  form: AutomationFormState,
  providerOptions?: ProviderStartOptions,
  acknowledgedRisks?: AutomationCreateInput["acknowledgedRisks"],
): AutomationUpdateInput {
  return {
    id: definition.id,
    ...createInputFromForm(form, providerOptions, acknowledgedRisks),
  };
}

export function buildAutomationFormWarnings(form: AutomationFormState) {
  return buildAutomationDraftWarnings({
    schedule: scheduleFromForm(form),
    mode: form.mode,
    runtimeMode: form.runtimeMode,
    worktreeMode: form.worktreeMode,
    hasEphemeralContext: false,
    generatedConfidence: null,
    generatedNeedsConfirmation: false,
    prompt: form.prompt,
  });
}

export function acknowledgedRiskIdsForFormWarnings(
  warnings: readonly AutomationDraftWarning[],
  acknowledgedWarningIds: ReadonlySet<AutomationDraftWarningId>,
) {
  return acknowledgedRiskIdsForDraft(warnings, acknowledgedWarningIds);
}

export function isFormSubmittable(form: AutomationFormState): boolean {
  if (!form.name.trim() || !form.prompt.trim() || !form.projectId) return false;
  if (form.mode === "heartbeat" && !form.targetThreadId) return false;
  if (
    form.scheduleKind === "custom" &&
    (!form.intervalAmount.trim() || Number.parseInt(form.intervalAmount, 10) <= 0)
  ) {
    return false;
  }
  if (form.scheduleKind === "cron" && !form.cronExpression.trim()) return false;
  if (form.scheduleKind === "once" && !form.onceRunAt.trim()) return false;
  if (
    (form.scheduleKind === "daily" ||
      form.scheduleKind === "weekdays" ||
      form.scheduleKind === "cron" ||
      form.scheduleKind === "weekly") &&
    !form.timezone.trim()
  ) {
    return false;
  }
  if (
    (form.scheduleKind === "daily" ||
      form.scheduleKind === "weekdays" ||
      form.scheduleKind === "weekly") &&
    !TIME_OF_DAY_PATTERN.test(form.timeOfDay)
  ) {
    return false;
  }
  return true;
}

const deletedAutomationIdsInCache = new Set<string>();

function isNewerOrEqualTimestamp(candidate: string, existing: string): boolean {
  return candidate.localeCompare(existing) >= 0;
}

function mergeDefinitionsByUpdatedAt(
  snapshotDefinitions: readonly AutomationDefinition[],
  previousDefinitions: readonly AutomationDefinition[],
): AutomationDefinition[] {
  const previousById = new Map(
    previousDefinitions.map((definition) => [definition.id, definition]),
  );
  const seen = new Set<string>();
  const definitions: AutomationDefinition[] = [];
  for (const snapshotDefinition of snapshotDefinitions) {
    if (deletedAutomationIdsInCache.has(snapshotDefinition.id)) {
      continue;
    }
    seen.add(snapshotDefinition.id);
    const previousDefinition = previousById.get(snapshotDefinition.id);
    definitions.push(
      previousDefinition &&
        isNewerOrEqualTimestamp(previousDefinition.updatedAt, snapshotDefinition.updatedAt)
        ? previousDefinition
        : snapshotDefinition,
    );
  }
  return definitions;
}

function mergeRunsByUpdatedAt(
  snapshotRuns: readonly AutomationRun[],
  previousRuns: readonly AutomationRun[],
  visibleAutomationIds?: ReadonlySet<AutomationId>,
): AutomationRun[] {
  const previousById = new Map(previousRuns.map((run) => [run.id, run]));
  const runs: AutomationRun[] = [];
  for (const snapshotRun of snapshotRuns) {
    if (
      deletedAutomationIdsInCache.has(snapshotRun.automationId) ||
      (visibleAutomationIds && !visibleAutomationIds.has(snapshotRun.automationId))
    ) {
      continue;
    }
    const previousRun = previousById.get(snapshotRun.id);
    runs.push(
      previousRun && isNewerOrEqualTimestamp(previousRun.updatedAt, snapshotRun.updatedAt)
        ? previousRun
        : snapshotRun,
    );
  }
  return runs;
}

export function applyAutomationEvent(
  prev: AutomationListResult | undefined,
  event: AutomationStreamEvent,
): AutomationListResult {
  const base = prev ?? EMPTY_AUTOMATION_LIST;
  switch (event.type) {
    case "snapshot": {
      const definitions = mergeDefinitionsByUpdatedAt(event.definitions, base.definitions);
      const visibleAutomationIds = new Set(definitions.map((definition) => definition.id));
      return {
        definitions,
        runs: mergeRunsByUpdatedAt(event.runs, base.runs, visibleAutomationIds),
      };
    }
    case "definition-upserted": {
      deletedAutomationIdsInCache.delete(event.definition.id);
      const exists = base.definitions.some((definition) => definition.id === event.definition.id);
      const definitions = exists
        ? base.definitions.map((definition) =>
            definition.id === event.definition.id ? event.definition : definition,
          )
        : [event.definition, ...base.definitions];
      return { definitions, runs: base.runs };
    }
    case "definition-deleted":
      deletedAutomationIdsInCache.add(event.automationId);
      return {
        definitions: base.definitions.filter((definition) => definition.id !== event.automationId),
        runs: base.runs.filter((run) => run.automationId !== event.automationId),
      };
    case "run-upserted": {
      if (deletedAutomationIdsInCache.has(event.run.automationId)) {
        return base;
      }
      const exists = base.runs.some((run) => run.id === event.run.id);
      const runs = exists
        ? base.runs.map((run) => (run.id === event.run.id ? event.run : run))
        : [event.run, ...base.runs];
      return { definitions: base.definitions, runs };
    }
  }
}

export function useAutomations(onRunStarted?: (threadId: ThreadId) => void) {
  const queryClient = useQueryClient();

  const automationsQuery = useQuery({
    queryKey: automationQueryKey,
    queryFn: () => ensureNativeApi().automation.list({}),
  });
  const data = automationsQuery.data ?? EMPTY_AUTOMATION_LIST;

  useEffect(() => {
    const api = ensureNativeApi();
    return api.automation.onEvent((event) => {
      queryClient.setQueryData<AutomationListResult>(automationQueryKey, (prev) =>
        applyAutomationEvent(prev, event),
      );
    });
  }, [queryClient]);

  const createMutation = useMutation({
    mutationFn: (input: AutomationCreateInput) => ensureNativeApi().automation.create(input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: automationQueryKey }),
    onError: (error) => toastManager.add({ type: "error", title: error.message }),
  });
  const updateMutation = useMutation({
    mutationFn: (input: AutomationUpdateInput) => ensureNativeApi().automation.update(input),
    // Optimistically merge the patch so inline edits on the detail page feel instant; the
    // server's authoritative definition (with recomputed nextRunAt) arrives via the stream.
    onMutate: (input) => {
      const previous = queryClient.getQueryData<AutomationListResult>(automationQueryKey);
      queryClient.setQueryData<AutomationListResult>(automationQueryKey, (prev) => {
        const base = prev ?? EMPTY_AUTOMATION_LIST;
        return {
          definitions: base.definitions.map((definition) =>
            definition.id === input.id
              ? ({ ...definition, ...input } as AutomationDefinition)
              : definition,
          ),
          runs: base.runs,
        };
      });
      return { previous };
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: automationQueryKey }),
    onError: (error, _input, context) => {
      // A failed update would otherwise leave the incomplete optimistic merge in the cache
      // until the next stream tick; restore the pre-edit snapshot so the UI reflects reality.
      if (context?.previous) {
        queryClient.setQueryData<AutomationListResult>(automationQueryKey, context.previous);
      }
      toastManager.add({ type: "error", title: error.message });
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (definition: AutomationDefinition) =>
      ensureNativeApi().automation.delete({ id: definition.id }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: automationQueryKey }),
    onError: (error) => toastManager.add({ type: "error", title: error.message }),
  });
  const runNowMutation = useMutation({
    mutationFn: (definition: AutomationDefinition) =>
      ensureNativeApi().automation.runNow({ automationId: definition.id }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: automationQueryKey });
      if (result.run.threadId) onRunStarted?.(result.run.threadId);
    },
    onError: (error) => toastManager.add({ type: "error", title: error.message }),
  });
  const cancelRunMutation = useMutation({
    mutationFn: (run: AutomationRun) => ensureNativeApi().automation.cancelRun({ runId: run.id }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: automationQueryKey }),
    onError: (error) => toastManager.add({ type: "error", title: error.message }),
  });
  const markRunReadMutation = useMutation({
    mutationFn: (input: { readonly run: AutomationRun; readonly unread: boolean }) =>
      ensureNativeApi().automation.markRunRead({ runId: input.run.id, unread: input.unread }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: automationQueryKey }),
    onError: (error) => toastManager.add({ type: "error", title: error.message }),
  });
  const archiveRunMutation = useMutation({
    mutationFn: (input: { readonly run: AutomationRun; readonly archived: boolean }) =>
      ensureNativeApi().automation.archiveRun({ runId: input.run.id, archived: input.archived }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: automationQueryKey }),
    onError: (error) => toastManager.add({ type: "error", title: error.message }),
  });

  const runsByAutomationId = useMemo(() => {
    const map = new Map<string, AutomationRun[]>();
    for (const run of data.runs) {
      const runs = map.get(run.automationId) ?? [];
      runs.push(run);
      map.set(run.automationId, runs);
    }
    for (const runs of map.values()) {
      runs.sort((left, right) => right.scheduledFor.localeCompare(left.scheduledFor));
    }
    return map;
  }, [data.runs]);

  return {
    data,
    isLoading: automationsQuery.isLoading,
    refetch: automationsQuery.refetch,
    createMutation,
    updateMutation,
    deleteMutation,
    runNowMutation,
    cancelRunMutation,
    markRunReadMutation,
    archiveRunMutation,
    runsByAutomationId,
  };
}

/** Subtle labeled pill used in the automation composer toolbar. */
const CHIP_CLASS =
  "gap-1.5 rounded-lg px-2 font-normal text-[var(--color-text-foreground-secondary)]";
type CadenceOption = { readonly value: string; readonly label: string };
type IntervalCadenceOption = {
  readonly amount: string;
  readonly unit: IntervalUnit;
  readonly label: string;
};

/** Interval cadence presets shown by default; second-level intervals are preserved when present. */
const INTERVAL_PRESETS: readonly IntervalCadenceOption[] = [
  { amount: "15", unit: "minutes", label: "Every 15 min" },
  { amount: "30", unit: "minutes", label: "Every 30 min" },
  { amount: "120", unit: "minutes", label: "Every 2 hours" },
  { amount: "360", unit: "minutes", label: "Every 6 hours" },
  { amount: "720", unit: "minutes", label: "Every 12 hours" },
  { amount: "1440", unit: "minutes", label: "Every 24 hours" },
];

function intervalOptionValue(option: Pick<IntervalCadenceOption, "amount" | "unit">): string {
  return `${option.unit}:${option.amount}`;
}

function intervalOptionLabel(amount: string, unit: IntervalUnit): string {
  return unit === "seconds" ? `Every ${amount} sec` : `Every ${amount} min`;
}

/** Heartbeat run-count presets ("" = unlimited). */
const MAX_ITERATION_PRESETS: readonly CadenceOption[] = [
  { value: "", label: "Unlimited" },
  { value: "10", label: "10 runs" },
  { value: "25", label: "25 runs" },
  { value: "50", label: "50 runs" },
  { value: "100", label: "100 runs" },
  { value: "250", label: "250 runs" },
];

export function AutomationModelPicker({
  value,
  projectCwd,
  onChange,
}: {
  readonly value: ModelSelection;
  readonly projectCwd: string | null;
  readonly onChange: (value: ModelSelection) => void;
}) {
  const { settings } = useAppSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const providerStatuses = useProviderStatusesForLocalConfig();
  const [open, setOpen] = useState(false);
  const modelHintByProvider = useMemo<Partial<Record<ProviderKind, string | null>>>(
    () => ({ [value.provider]: value.model }),
    [value.model, value.provider],
  );
  const providerModelDiscoveryCwd = resolveProviderDiscoveryCwd({
    activeThreadWorktreePath: null,
    activeProjectCwd: projectCwd,
    serverCwd: serverConfigQuery.data?.cwd ?? null,
  });
  const { modelOptionsByProvider, loadingModelProviders } = useProviderModelCatalog({
    selectedProvider: value.provider,
    discoveryEnabled: open,
    cwd: providerModelDiscoveryCwd,
    modelHintByProvider,
  });

  return (
    <ProviderModelPicker
      compact
      provider={value.provider}
      model={value.model}
      lockedProvider={null}
      providers={providerStatuses}
      modelOptionsByProvider={modelOptionsByProvider}
      loadingModelProviders={loadingModelProviders}
      hiddenProviders={settings.hiddenProviders}
      providerOrder={settings.providerOrder}
      open={open}
      onOpenChange={setOpen}
      onProviderModelChange={(provider, model) => onChange(buildModelSelection(provider, model))}
    />
  );
}

export function AutomationDialog({
  open,
  editing,
  form,
  projects,
  threads,
  warnings = [],
  acknowledgedWarningIds = new Set(),
  onOpenChange,
  onFormChange,
  onToggleWarning,
  onSubmit,
  busy,
}: {
  readonly open: boolean;
  readonly editing: boolean;
  readonly form: AutomationFormState;
  readonly projects: ReturnType<typeof useStore.getState>["projects"];
  readonly threads: ReturnType<typeof useStore.getState>["threads"];
  readonly warnings?: readonly AutomationDraftWarning[];
  readonly acknowledgedWarningIds?: ReadonlySet<AutomationDraftWarningId>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onFormChange: (form: AutomationFormState) => void;
  readonly onToggleWarning?: (id: AutomationDraftWarningId, checked: boolean) => void;
  readonly onSubmit: () => void;
  readonly busy: boolean;
}) {
  const setField = <K extends keyof AutomationFormState>(key: K, value: AutomationFormState[K]) =>
    onFormChange({ ...form, [key]: value });
  const projectThreads = threads.filter((thread) => thread.projectId === form.projectId);
  const selectedProject = projects.find((project) => project.id === form.projectId);
  const schedule = scheduleFromForm(form);
  const hasBlockingWarning = hasBlockingAutomationDraftWarnings(warnings, acknowledgedWarningIds);
  const submittable = isFormSubmittable(form) && !hasBlockingWarning;
  const intervalValue = intervalOptionValue({
    amount: form.intervalAmount,
    unit: form.intervalUnit,
  });
  const intervalPresets = INTERVAL_PRESETS.some(
    (preset) => intervalOptionValue(preset) === intervalValue,
  )
    ? INTERVAL_PRESETS
    : [
        {
          amount: form.intervalAmount,
          unit: form.intervalUnit,
          label: intervalOptionLabel(form.intervalAmount, form.intervalUnit),
        },
        ...INTERVAL_PRESETS,
      ];

  const chooseProject = (projectId: string) => {
    const targetStillMatches =
      form.targetThreadId.length > 0 &&
      threads.some((thread) => thread.id === form.targetThreadId && thread.projectId === projectId);
    onFormChange({
      ...form,
      projectId,
      modelSelection: modelSelectionForProjectChange(
        projects,
        form.projectId,
        projectId,
        form.modelSelection,
      ),
      targetThreadId: targetStillMatches ? form.targetThreadId : "",
    });
  };

  const applyTemplate = (template: (typeof AUTOMATION_TEMPLATES)[number]) =>
    onFormChange({
      ...form,
      name: form.name.trim() ? form.name : template.name,
      prompt: template.prompt,
    });

  const submit = () => {
    if (busy || !submittable) return;
    onSubmit();
  };
  const handleOpenChange = (nextOpen: boolean) => {
    if (busy && !nextOpen) return;
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup surface="solid" showCloseButton={false} className="max-w-3xl">
        <DialogTitle className="sr-only">
          {editing ? "Edit automation" : "New automation"}
        </DialogTitle>

        <div className="flex items-start gap-3 px-5 pt-5">
          <input
            value={form.name}
            onChange={(event) => setField("name", event.target.value)}
            placeholder="Automation title"
            aria-label="Automation title"
            autoFocus
            className="min-w-0 flex-1 bg-transparent py-1 font-system-ui text-lg font-medium text-foreground outline-none placeholder:text-muted-foreground/50"
          />
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="About automations"
              title="Automations run this prompt on a schedule and open the result as a thread."
            >
              <InfoIcon className="size-4" />
            </Button>
            <Menu>
              <MenuTrigger render={<Button variant="outline" size="sm" />}>
                Use template
              </MenuTrigger>
              <ComposerPickerMenuPopup align="end" className="w-52">
                {AUTOMATION_TEMPLATES.map((template) => (
                  <MenuItem key={template.label} onClick={() => applyTemplate(template)}>
                    {template.label}
                  </MenuItem>
                ))}
              </ComposerPickerMenuPopup>
            </Menu>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Close"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              <XIcon className="size-4" />
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 px-5 py-3">
          <textarea
            value={form.prompt}
            onChange={(event) => setField("prompt", event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="Add prompt e.g. look for crashes in $sentry"
            aria-label="Automation prompt"
            className="max-h-[42vh] min-h-[15rem] w-full resize-none overflow-y-auto bg-transparent font-system-ui text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/50"
          />
        </div>

        {warnings.length > 0 ? (
          <div className="mx-5 mb-2 flex flex-col gap-1.5 rounded-lg border border-border/70 bg-[var(--color-background-elevated-secondary)] p-3">
            {warnings.map((warning) => (
              <label
                key={warning.id}
                className="flex items-start gap-2 text-xs text-muted-foreground"
              >
                {warning.requiresAcknowledgement ? (
                  <input
                    type="checkbox"
                    checked={acknowledgedWarningIds.has(warning.id)}
                    onChange={(event) => onToggleWarning?.(warning.id, event.target.checked)}
                    className="mt-0.5"
                  />
                ) : (
                  <span className="mt-1 size-1.5 shrink-0 rounded-full bg-amber-500" />
                )}
                <span className="min-w-0">
                  <span className="font-medium text-foreground">{warning.title}</span>
                  <span className="block">{warning.detail}</span>
                </span>
              </label>
            ))}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 px-4 pb-4 pt-1">
          <div className="flex flex-1 flex-wrap items-center gap-0.5">
            {form.mode === "standalone" ? (
              <Menu>
                <MenuTrigger render={<Button variant="ghost" size="sm" className={CHIP_CLASS} />}>
                  <WorktreeIcon className="size-4" />
                  <span className="capitalize">{form.worktreeMode}</span>
                  <ChevronDownIcon className="size-3.5 opacity-60" />
                </MenuTrigger>
                <ComposerPickerMenuPopup align="start" className="w-40">
                  <MenuRadioGroup
                    value={form.worktreeMode}
                    onValueChange={(value) =>
                      setField("worktreeMode", value as AutomationWorktreeMode)
                    }
                  >
                    {(["auto", "worktree", "local"] as const).map((value) => (
                      <MenuRadioItem key={value} value={value}>
                        <span className="capitalize">{value}</span>
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </ComposerPickerMenuPopup>
              </Menu>
            ) : null}

            <Menu>
              <MenuTrigger render={<Button variant="ghost" size="sm" className={CHIP_CLASS} />}>
                <FolderIcon className="size-4" />
                <span className="max-w-[10rem] truncate">
                  {selectedProject?.name ?? "Select project"}
                </span>
                <ChevronDownIcon className="size-3.5 opacity-60" />
              </MenuTrigger>
              <ComposerPickerMenuPopup align="start" className="w-56">
                <MenuRadioGroup value={form.projectId} onValueChange={chooseProject}>
                  {projects.map((project) => (
                    <MenuRadioItem key={project.id} value={project.id}>
                      <span className="truncate">{project.name}</span>
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </ComposerPickerMenuPopup>
            </Menu>

            <AutomationModelPicker
              value={form.modelSelection}
              projectCwd={selectedProject?.cwd ?? null}
              onChange={(value) => setField("modelSelection", value)}
            />

            <Menu>
              <MenuTrigger render={<Button variant="ghost" size="sm" className={CHIP_CLASS} />}>
                <ClockIcon className="size-4" />
                <span>{formatCadence(schedule)}</span>
                <ChevronDownIcon className="size-3.5 opacity-60" />
              </MenuTrigger>
              <ComposerPickerMenuPopup align="start" className="w-56">
                <MenuGroup>
                  <MenuGroupLabel>Schedule</MenuGroupLabel>
                  <MenuRadioGroup
                    value={form.scheduleKind}
                    onValueChange={(value) => setField("scheduleKind", value as ScheduleKind)}
                  >
                    {SCHEDULE_KIND_OPTIONS.map((option) => (
                      <MenuRadioItem key={option.value} value={option.value}>
                        {option.label}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuGroup>
                {form.scheduleKind === "custom" ? (
                  <>
                    <MenuSeparator />
                    <MenuGroup>
                      <MenuGroupLabel>Every</MenuGroupLabel>
                      <MenuRadioGroup
                        value={intervalValue}
                        onValueChange={(value) => {
                          const [unit, amount] = value.split(":");
                          if (unit === "seconds" || unit === "minutes") {
                            onFormChange({
                              ...form,
                              intervalUnit: unit,
                              intervalAmount: amount ?? "1",
                            });
                          }
                        }}
                      >
                        {intervalPresets.map((preset) => (
                          <MenuRadioItem
                            key={intervalOptionValue(preset)}
                            value={intervalOptionValue(preset)}
                          >
                            {preset.label}
                          </MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                    </MenuGroup>
                  </>
                ) : null}
                {form.scheduleKind === "once" ? (
                  <>
                    <MenuSeparator />
                    <MenuGroup>
                      <MenuGroupLabel>Run at</MenuGroupLabel>
                      <div className="px-2 py-1">
                        <input
                          type="datetime-local"
                          step={1}
                          value={form.onceRunAt}
                          onChange={(event) => setField("onceRunAt", event.target.value)}
                          className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        />
                      </div>
                    </MenuGroup>
                  </>
                ) : null}
                {form.scheduleKind === "cron" ? (
                  <>
                    <MenuSeparator />
                    <MenuGroup>
                      <MenuGroupLabel>Cron</MenuGroupLabel>
                      <div className="px-2 py-1">
                        <input
                          value={form.cronExpression}
                          onChange={(event) => setField("cronExpression", event.target.value)}
                          placeholder="0 9 * * *"
                          className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 font-mono text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        />
                      </div>
                    </MenuGroup>
                  </>
                ) : null}
                {form.scheduleKind === "weekly" ? (
                  <>
                    <MenuSeparator />
                    <MenuGroup>
                      <MenuGroupLabel>Day</MenuGroupLabel>
                      <MenuRadioGroup
                        value={form.dayOfWeek}
                        onValueChange={(value) => setField("dayOfWeek", value)}
                      >
                        {[0, 1, 2, 3, 4, 5, 6].map((value) => (
                          <MenuRadioItem key={value} value={String(value)}>
                            {weekdayLabel(value)}
                          </MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                    </MenuGroup>
                  </>
                ) : null}
                {form.scheduleKind === "daily" ||
                form.scheduleKind === "weekdays" ||
                form.scheduleKind === "weekly" ? (
                  <>
                    <MenuSeparator />
                    <MenuSub>
                      <MenuSubTrigger>
                        Time
                        <span className="ml-auto pr-1 tabular-nums text-muted-foreground">
                          {form.timeOfDay}
                        </span>
                      </MenuSubTrigger>
                      <ComposerPickerMenuSubPopup>
                        <div className="p-1">
                          <TimePicker
                            className="w-44"
                            value={form.timeOfDay}
                            onChange={(value) => setField("timeOfDay", value)}
                          />
                        </div>
                      </ComposerPickerMenuSubPopup>
                    </MenuSub>
                  </>
                ) : null}
                {form.scheduleKind === "daily" ||
                form.scheduleKind === "weekdays" ||
                form.scheduleKind === "weekly" ||
                form.scheduleKind === "cron" ? (
                  <>
                    <MenuSeparator />
                    <MenuGroup>
                      <MenuGroupLabel>Timezone</MenuGroupLabel>
                      <div className="px-2 py-1">
                        <input
                          value={form.timezone}
                          onChange={(event) => setField("timezone", event.target.value)}
                          placeholder="Europe/Rome"
                          className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        />
                      </div>
                    </MenuGroup>
                  </>
                ) : null}
              </ComposerPickerMenuPopup>
            </Menu>

            <Menu>
              <MenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Run mode"
                    title="Run mode"
                    className="rounded-lg text-[var(--color-text-foreground-secondary)]"
                  />
                }
              >
                <SkillCubeIcon className="size-4" />
              </MenuTrigger>
              <ComposerPickerMenuPopup align="start" className="w-56">
                <MenuGroup>
                  <MenuGroupLabel>Mode</MenuGroupLabel>
                  <MenuRadioGroup
                    value={form.mode}
                    onValueChange={(value) => setField("mode", value as AutomationMode)}
                  >
                    <MenuRadioItem value="standalone">Standalone</MenuRadioItem>
                    <MenuRadioItem value="heartbeat">Heartbeat</MenuRadioItem>
                  </MenuRadioGroup>
                </MenuGroup>
                {form.mode === "heartbeat" ? (
                  <>
                    <MenuSeparator />
                    <MenuGroup>
                      <MenuGroupLabel>Target thread</MenuGroupLabel>
                      {projectThreads.length === 0 ? (
                        <MenuItem disabled>No threads in this project</MenuItem>
                      ) : (
                        <MenuRadioGroup
                          value={form.targetThreadId}
                          onValueChange={(value) => setField("targetThreadId", value)}
                        >
                          {projectThreads.map((thread) => (
                            <MenuRadioItem key={thread.id} value={thread.id}>
                              <span className="truncate">
                                {resolveThreadPickerTitle(thread.title)}
                              </span>
                            </MenuRadioItem>
                          ))}
                        </MenuRadioGroup>
                      )}
                    </MenuGroup>
                    <MenuSeparator />
                    <MenuGroup>
                      <MenuGroupLabel>Stop when</MenuGroupLabel>
                      <div className="px-2 py-1">
                        <input
                          value={form.stopWhen}
                          onChange={(event) => setField("stopWhen", event.target.value)}
                          placeholder="PR is ready to merge"
                          className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        />
                      </div>
                    </MenuGroup>
                    <MenuSeparator />
                    <MenuGroup>
                      <MenuGroupLabel>Max iterations</MenuGroupLabel>
                      <MenuRadioGroup
                        value={form.maxIterations}
                        onValueChange={(value) => setField("maxIterations", value)}
                      >
                        {MAX_ITERATION_PRESETS.map((preset) => (
                          <MenuRadioItem key={preset.value || "unlimited"} value={preset.value}>
                            {preset.label}
                          </MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                    </MenuGroup>
                    <MenuSeparator />
                    <MenuCheckboxItem
                      checked={form.stopOnError}
                      onCheckedChange={(checked) => setField("stopOnError", checked)}
                    >
                      Stop on error
                    </MenuCheckboxItem>
                  </>
                ) : null}
              </ComposerPickerMenuPopup>
            </Menu>

            <Menu>
              <MenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Permissions"
                    title="Permissions"
                    className="rounded-lg text-[var(--color-text-foreground-secondary)]"
                  />
                }
              >
                <BrainIcon className="size-4" />
              </MenuTrigger>
              <ComposerPickerMenuPopup align="start" className="w-48">
                <MenuRadioGroup
                  value={form.runtimeMode}
                  onValueChange={(value) => setField("runtimeMode", value as RuntimeMode)}
                >
                  <MenuRadioItem value="approval-required">Approval required</MenuRadioItem>
                  <MenuRadioItem value="full-access">Full access</MenuRadioItem>
                </MenuRadioGroup>
              </ComposerPickerMenuPopup>
            </Menu>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="button" onClick={submit} disabled={busy || !submittable}>
              {editing ? "Save" : "Create"}
            </Button>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

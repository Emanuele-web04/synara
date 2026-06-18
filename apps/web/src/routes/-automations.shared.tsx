import {
  type AutomationCreateInput,
  type AutomationDefinition,
  type AutomationListResult,
  type AutomationMode,
  type AutomationRun,
  type AutomationSchedule,
  type AutomationStreamEvent,
  type AutomationUpdateInput,
  type AutomationWorktreeMode,
  type ProjectId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { ensureNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { resolveThreadPickerTitle } from "./-chatThreadRoute.logic";

export const automationQueryKey = ["automations"] as const;
export const defaultModelSelection = { provider: "codex" as const, model: "gpt-5-codex" };
export const EMPTY_AUTOMATION_LIST: AutomationListResult = { definitions: [], runs: [] };
export const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export type FormScheduleType = AutomationSchedule["type"];

export type AutomationFormState = {
  readonly name: string;
  readonly projectId: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly scheduleType: FormScheduleType;
  readonly intervalMinutes: string;
  readonly timeOfDay: string;
  readonly dayOfWeek: string;
  readonly runtimeMode: RuntimeMode;
  readonly worktreeMode: AutomationWorktreeMode;
  readonly mode: AutomationMode;
  readonly targetThreadId: string;
  readonly maxIterations: string;
  readonly stopOnError: boolean;
};

export function formatDateTime(value: string | null): string {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(date)} UTC`;
}

export function formatSchedule(schedule: AutomationSchedule): string {
  switch (schedule.type) {
    case "manual":
      return "Manual";
    case "interval":
      return `Every ${Math.max(1, Math.round(schedule.everySeconds / 60))} min`;
    case "daily":
      return `Daily ${schedule.timeOfDay} UTC`;
    case "weekly":
      return `Weekly ${weekdayLabel(schedule.dayOfWeek)} ${schedule.timeOfDay} UTC`;
  }
}

export function formatCadence(schedule: AutomationSchedule): string {
  switch (schedule.type) {
    case "manual":
      return "Manual";
    case "interval": {
      const minutes = Math.max(1, Math.round(schedule.everySeconds / 60));
      return minutes % 60 === 0 ? `Every ${minutes / 60}h` : `Every ${minutes}m`;
    }
    case "daily":
      return `Daily ${schedule.timeOfDay} UTC`;
    case "weekly":
      return `Weekly ${weekdayLabel(schedule.dayOfWeek)} ${schedule.timeOfDay} UTC`;
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
  return (
    run.status === "failed" ||
    run.status === "cancelled" ||
    run.status === "interrupted" ||
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

export function formFromDefinition(
  definition: AutomationDefinition | null,
  fallbackProjectId: string,
): AutomationFormState {
  const schedule = definition?.schedule ?? { type: "manual" as const };
  return {
    name: definition?.name ?? "",
    projectId: definition?.projectId ?? fallbackProjectId,
    prompt: definition?.prompt ?? "",
    enabled: definition?.enabled ?? true,
    scheduleType: schedule.type,
    intervalMinutes:
      schedule.type === "interval"
        ? String(Math.max(1, Math.round(schedule.everySeconds / 60)))
        : "60",
    timeOfDay:
      schedule.type === "daily" || schedule.type === "weekly" ? schedule.timeOfDay : "09:00",
    dayOfWeek: schedule.type === "weekly" ? String(schedule.dayOfWeek) : "1",
    runtimeMode: definition?.runtimeMode ?? "approval-required",
    worktreeMode: definition?.worktreeMode ?? "auto",
    mode: definition?.mode ?? "standalone",
    targetThreadId: definition?.targetThreadId ?? "",
    maxIterations: definition?.maxIterations != null ? String(definition.maxIterations) : "",
    stopOnError: definition?.stopOnError ?? true,
  };
}

export function scheduleFromForm(form: AutomationFormState): AutomationSchedule {
  if (form.scheduleType === "interval") {
    const minutes = Math.max(1, Number.parseInt(form.intervalMinutes, 10) || 1);
    return { type: "interval", everySeconds: minutes * 60 };
  }
  if (form.scheduleType === "daily") {
    return { type: "daily", timeOfDay: form.timeOfDay };
  }
  if (form.scheduleType === "weekly") {
    const dayOfWeek = Math.min(6, Math.max(0, Number.parseInt(form.dayOfWeek, 10) || 0));
    return { type: "weekly", dayOfWeek, timeOfDay: form.timeOfDay };
  }
  return { type: "manual" };
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

export function createInputFromForm(
  form: AutomationFormState,
  projects: ReturnType<typeof useStore.getState>["projects"],
): AutomationCreateInput {
  const maxIterations = form.maxIterations.trim() ? Number.parseInt(form.maxIterations, 10) : null;
  return {
    name: form.name.trim(),
    projectId: form.projectId as ProjectId,
    prompt: form.prompt.trim(),
    schedule: scheduleFromForm(form),
    enabled: form.enabled,
    modelSelection: projectModelSelection(projects, form.projectId),
    runtimeMode: form.runtimeMode,
    interactionMode: "default",
    worktreeMode: form.worktreeMode,
    mode: form.mode,
    targetThreadId: form.mode === "heartbeat" ? (form.targetThreadId as ThreadId) : null,
    ...(form.mode === "heartbeat" ? { maxIterations, stopOnError: form.stopOnError } : {}),
  };
}

export function updateInputFromForm(
  definition: AutomationDefinition,
  form: AutomationFormState,
  projects: ReturnType<typeof useStore.getState>["projects"],
): AutomationUpdateInput {
  return {
    id: definition.id,
    ...createInputFromForm(form, projects),
  };
}

export function isFormSubmittable(form: AutomationFormState): boolean {
  if (!form.name.trim() || !form.prompt.trim() || !form.projectId) return false;
  if (form.mode === "heartbeat" && !form.targetThreadId) return false;
  if (
    (form.scheduleType === "daily" || form.scheduleType === "weekly") &&
    !TIME_OF_DAY_PATTERN.test(form.timeOfDay)
  ) {
    return false;
  }
  return true;
}

export function applyAutomationEvent(
  prev: AutomationListResult | undefined,
  event: AutomationStreamEvent,
): AutomationListResult {
  const base = prev ?? EMPTY_AUTOMATION_LIST;
  switch (event.type) {
    case "snapshot":
      return { definitions: event.definitions, runs: event.runs };
    case "definition-upserted": {
      const exists = base.definitions.some((definition) => definition.id === event.definition.id);
      const definitions = exists
        ? base.definitions.map((definition) =>
            definition.id === event.definition.id ? event.definition : definition,
          )
        : [event.definition, ...base.definitions];
      return { definitions, runs: base.runs };
    }
    case "definition-deleted":
      return {
        definitions: base.definitions.filter((definition) => definition.id !== event.automationId),
        runs: base.runs.filter((run) => run.automationId !== event.automationId),
      };
    case "run-upserted": {
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
    runsByAutomationId,
  };
}

export function AutomationDialog({
  open,
  editing,
  form,
  projects,
  threads,
  onOpenChange,
  onFormChange,
  onSubmit,
  busy,
}: {
  readonly open: boolean;
  readonly editing: boolean;
  readonly form: AutomationFormState;
  readonly projects: ReturnType<typeof useStore.getState>["projects"];
  readonly threads: ReturnType<typeof useStore.getState>["threads"];
  readonly onOpenChange: (open: boolean) => void;
  readonly onFormChange: (form: AutomationFormState) => void;
  readonly onSubmit: () => void;
  readonly busy: boolean;
}) {
  const setField = <K extends keyof AutomationFormState>(key: K, value: AutomationFormState[K]) =>
    onFormChange({ ...form, [key]: value });
  const projectThreads = threads.filter((thread) => thread.projectId === form.projectId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup surface="solid" className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit Automation" : "New Automation"}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="grid gap-4">
          <label className="grid gap-1.5 text-xs font-medium">
            Name
            <Input value={form.name} onChange={(event) => setField("name", event.target.value)} />
          </label>
          <label className="grid gap-1.5 text-xs font-medium">
            Project
            <select
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={form.projectId}
              onChange={(event) => {
                const projectId = event.target.value;
                const targetStillMatches =
                  form.targetThreadId.length > 0 &&
                  threads.some(
                    (thread) => thread.id === form.targetThreadId && thread.projectId === projectId,
                  );
                onFormChange({
                  ...form,
                  projectId,
                  targetThreadId: targetStillMatches ? form.targetThreadId : "",
                });
              }}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1.5 text-xs font-medium">
            Prompt
            <Textarea
              value={form.prompt}
              onChange={(event) => setField("prompt", event.target.value)}
            />
          </label>
          <label className="grid gap-1.5 text-xs font-medium">
            Mode
            <select
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={form.mode}
              onChange={(event) => setField("mode", event.target.value as AutomationMode)}
            >
              <option value="standalone">Standalone</option>
              <option value="heartbeat">Heartbeat</option>
            </select>
          </label>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="grid gap-1.5 text-xs font-medium">
              Schedule
              <select
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={form.scheduleType}
                onChange={(event) =>
                  setField("scheduleType", event.target.value as FormScheduleType)
                }
              >
                <option value="manual">Manual</option>
                <option value="interval">Interval</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </label>
            {form.scheduleType === "interval" ? (
              <label className="grid gap-1.5 text-xs font-medium">
                Minutes
                <Input
                  type="number"
                  min={1}
                  value={form.intervalMinutes}
                  onChange={(event) => setField("intervalMinutes", event.target.value)}
                />
              </label>
            ) : null}
            {form.scheduleType === "daily" || form.scheduleType === "weekly" ? (
              <label className="grid gap-1.5 text-xs font-medium">
                Time UTC
                <Input
                  type="time"
                  value={form.timeOfDay}
                  onChange={(event) => setField("timeOfDay", event.target.value)}
                />
              </label>
            ) : null}
            {form.scheduleType === "weekly" ? (
              <label className="grid gap-1.5 text-xs font-medium">
                Day
                <select
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  value={form.dayOfWeek}
                  onChange={(event) => setField("dayOfWeek", event.target.value)}
                >
                  {[0, 1, 2, 3, 4, 5, 6].map((value) => (
                    <option key={value} value={value}>
                      {weekdayLabel(value)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="grid gap-1.5 text-xs font-medium">
              Permissions
              <select
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={form.runtimeMode}
                onChange={(event) => setField("runtimeMode", event.target.value as RuntimeMode)}
              >
                <option value="approval-required">Approval required</option>
                <option value="full-access">Full access</option>
              </select>
            </label>
            {form.mode === "standalone" ? (
              <label className="grid gap-1.5 text-xs font-medium">
                Workspace
                <select
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  value={form.worktreeMode}
                  onChange={(event) =>
                    setField("worktreeMode", event.target.value as AutomationWorktreeMode)
                  }
                >
                  <option value="auto">Auto</option>
                  <option value="worktree">Worktree</option>
                  <option value="local">Local</option>
                </select>
              </label>
            ) : null}
            {form.mode === "heartbeat" ? (
              <>
                <label className="grid gap-1.5 text-xs font-medium">
                  Target thread
                  <select
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                    value={form.targetThreadId}
                    onChange={(event) => setField("targetThreadId", event.target.value)}
                  >
                    <option value="">Select a thread</option>
                    {projectThreads.map((thread) => (
                      <option key={thread.id} value={thread.id}>
                        {resolveThreadPickerTitle(thread.title)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1.5 text-xs font-medium">
                  Max iterations
                  <Input
                    type="number"
                    min={1}
                    value={form.maxIterations}
                    onChange={(event) => setField("maxIterations", event.target.value)}
                  />
                </label>
              </>
            ) : null}
          </div>
          {form.mode === "heartbeat" ? (
            <label className="flex items-center gap-2 text-xs font-medium">
              <input
                type="checkbox"
                checked={form.stopOnError}
                onChange={(event) => setField("stopOnError", event.target.checked)}
              />
              Stop on error
            </label>
          ) : null}
          <label className="flex items-center gap-2 text-xs font-medium">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => setField("enabled", event.target.checked)}
            />
            Enabled
          </label>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={onSubmit} disabled={busy || !isFormSubmittable(form)}>
            {editing ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

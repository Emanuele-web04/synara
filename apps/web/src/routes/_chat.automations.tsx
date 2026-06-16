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
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { SidebarHeaderNavigationControls } from "~/components/SidebarHeaderNavigationControls";
import { Badge } from "~/components/ui/badge";
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
import {
  ClockIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  StopFilledIcon,
  Trash2,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { resolveThreadPickerTitle } from "./-chatThreadRoute.logic";

export const Route = createFileRoute("/_chat/automations")({
  component: AutomationsRouteView,
});

const automationQueryKey = ["automations"] as const;
const defaultModelSelection = { provider: "codex" as const, model: "gpt-5-codex" };

type AutomationFilter = "all" | "triage";
type FormScheduleType = AutomationSchedule["type"];

type AutomationFormState = {
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

function formatDateTime(value: string | null): string {
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

function formatSchedule(schedule: AutomationSchedule): string {
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

function weekdayLabel(value: number): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][value] ?? "Sun";
}

function runStatusVariant(
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

function isTriageRun(run: AutomationRun): boolean {
  return (
    run.status === "failed" ||
    run.status === "cancelled" ||
    run.status === "interrupted" ||
    run.status === "waiting-for-approval"
  );
}

function formFromDefinition(
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

function scheduleFromForm(form: AutomationFormState): AutomationSchedule {
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

function projectModelSelection(
  projects: ReturnType<typeof useStore.getState>["projects"],
  projectId: string,
) {
  return (
    projects.find((project) => project.id === projectId)?.defaultModelSelection ??
    defaultModelSelection
  );
}

function createInputFromForm(
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

function updateInputFromForm(
  definition: AutomationDefinition,
  form: AutomationFormState,
  projects: ReturnType<typeof useStore.getState>["projects"],
): AutomationUpdateInput {
  return {
    id: definition.id,
    ...createInputFromForm(form, projects),
  };
}

const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function isFormSubmittable(form: AutomationFormState): boolean {
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

const EMPTY_AUTOMATION_LIST: AutomationListResult = { definitions: [], runs: [] };

function applyAutomationEvent(
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

function AutomationsRouteView() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const projects = useStore((state) => state.projects);
  const threads = useStore((state) => state.threads);
  const [filter, setFilter] = useState<AutomationFilter>("all");
  const [editingDefinition, setEditingDefinition] = useState<AutomationDefinition | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const fallbackProjectId = projects[0]?.id ?? "";
  const [form, setForm] = useState<AutomationFormState>(() =>
    formFromDefinition(null, fallbackProjectId),
  );

  const automationsQuery = useQuery({
    queryKey: automationQueryKey,
    queryFn: () => ensureNativeApi().automation.list({}),
  });
  const data = automationsQuery.data ?? { definitions: [], runs: [] };

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
    onSuccess: () => {
      setDialogOpen(false);
      void queryClient.invalidateQueries({ queryKey: automationQueryKey });
    },
    onError: (error) => toastManager.add({ type: "error", title: error.message }),
  });
  const updateMutation = useMutation({
    mutationFn: (input: AutomationUpdateInput) => ensureNativeApi().automation.update(input),
    onSuccess: () => {
      setDialogOpen(false);
      void queryClient.invalidateQueries({ queryKey: automationQueryKey });
    },
    onError: (error) => toastManager.add({ type: "error", title: error.message }),
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
      if (result.run.threadId)
        void navigate({ to: "/$threadId", params: { threadId: result.run.threadId } });
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

  const definitions = useMemo(() => {
    if (filter === "all") return data.definitions;
    return data.definitions.filter((definition) =>
      (runsByAutomationId.get(definition.id) ?? []).some(isTriageRun),
    );
  }, [data.definitions, filter, runsByAutomationId]);

  const openCreateDialog = () => {
    setEditingDefinition(null);
    setForm(formFromDefinition(null, fallbackProjectId));
    setDialogOpen(true);
  };

  const openEditDialog = (definition: AutomationDefinition) => {
    setEditingDefinition(definition);
    setForm(formFromDefinition(definition, fallbackProjectId));
    setDialogOpen(true);
  };

  const submitForm = () => {
    if (!isFormSubmittable(form)) return;
    if (editingDefinition) {
      updateMutation.mutate(updateInputFromForm(editingDefinition, form, projects));
      return;
    }
    createMutation.mutate(createInputFromForm(form, projects));
  };

  const deleteDefinition = async (definition: AutomationDefinition) => {
    const confirmed = await ensureNativeApi().dialogs.confirm(`Delete "${definition.name}"?`);
    if (confirmed) deleteMutation.mutate(definition);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="drag-region flex h-12 shrink-0 items-center gap-3 border-b border-border/60 px-3">
        <SidebarHeaderNavigationControls />
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-heading text-sm font-semibold">Automations</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void automationsQuery.refetch()}
          >
            <RefreshCwIcon className="size-4" />
            Refresh
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={openCreateDialog}
            disabled={projects.length === 0}
          >
            <PlusIcon className="size-4" />
            New
          </Button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex rounded-md border border-border bg-background p-0.5">
              {(["all", "triage"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={filter === value}
                  className={cn(
                    "h-7 rounded-sm px-3 text-xs font-medium text-muted-foreground transition-colors",
                    filter === value && "bg-muted text-foreground",
                  )}
                  onClick={() => setFilter(value)}
                >
                  {value === "all" ? "All" : "Triage"}
                </button>
              ))}
            </div>
            <div className="text-xs text-muted-foreground">
              {data.definitions.length} saved / {data.runs.length} runs
            </div>
          </div>

          {automationsQuery.isLoading ? (
            <div className="rounded-lg border border-border bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
              Loading automations...
            </div>
          ) : definitions.length === 0 ? (
            <div className="rounded-lg border border-border bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
              No automations yet.
            </div>
          ) : (
            <div className="grid gap-3">
              {definitions.map((definition) => (
                <AutomationDefinitionRow
                  key={definition.id}
                  definition={definition}
                  projectTitle={
                    projects.find((project) => project.id === definition.projectId)?.name ??
                    "Unknown project"
                  }
                  runs={runsByAutomationId.get(definition.id) ?? []}
                  onEdit={() => openEditDialog(definition)}
                  onDelete={() => void deleteDefinition(definition)}
                  onRunNow={() => runNowMutation.mutate(definition)}
                  onOpenThread={(threadId) =>
                    void navigate({ to: "/$threadId", params: { threadId } })
                  }
                  onCancelRun={(run) => cancelRunMutation.mutate(run)}
                  busy={
                    runNowMutation.isPending ||
                    deleteMutation.isPending ||
                    cancelRunMutation.isPending
                  }
                />
              ))}
            </div>
          )}
        </div>
      </main>

      <AutomationDialog
        open={dialogOpen}
        editing={editingDefinition !== null}
        form={form}
        projects={projects}
        threads={threads}
        onOpenChange={setDialogOpen}
        onFormChange={setForm}
        onSubmit={submitForm}
        busy={createMutation.isPending || updateMutation.isPending}
      />
    </div>
  );
}

function AutomationDefinitionRow({
  definition,
  projectTitle,
  runs,
  onEdit,
  onDelete,
  onRunNow,
  onOpenThread,
  onCancelRun,
  busy,
}: {
  readonly definition: AutomationDefinition;
  readonly projectTitle: string;
  readonly runs: readonly AutomationRun[];
  readonly onEdit: () => void;
  readonly onDelete: () => void;
  readonly onRunNow: () => void;
  readonly onOpenThread: (threadId: NonNullable<AutomationRun["threadId"]>) => void;
  readonly onCancelRun: (run: AutomationRun) => void;
  readonly busy: boolean;
}) {
  const latestRun = runs[0] ?? null;
  return (
    <section className="rounded-lg border border-border bg-card text-card-foreground">
      <div className="flex flex-col gap-3 p-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate font-heading text-sm font-semibold">{definition.name}</h2>
            <Badge variant={definition.enabled ? "success" : "outline"}>
              {definition.enabled ? "Enabled" : "Paused"}
            </Badge>
            {definition.mode === "heartbeat" ? <Badge variant="info">Loop</Badge> : null}
            <Badge variant="outline">{definition.runtimeMode}</Badge>
            <Badge variant="outline">{definition.worktreeMode}</Badge>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>{projectTitle}</span>
            <span>{formatSchedule(definition.schedule)}</span>
            <span>Next: {formatDateTime(definition.nextRunAt)}</span>
            {definition.maxIterations != null ? (
              <span>
                {definition.iterationCount}/{definition.maxIterations} runs
              </span>
            ) : null}
          </div>
          <p className="line-clamp-2 max-w-3xl text-sm text-muted-foreground">
            {definition.prompt}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onRunNow}>
            <PlayIcon className="size-4" />
            Run
          </Button>
          <Button type="button" size="icon-sm" variant="ghost" aria-label="Edit" onClick={onEdit}>
            <PencilIcon className="size-4" />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Delete"
            onClick={onDelete}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>
      <div className="border-t border-border/70 px-4 py-3">
        {latestRun ? (
          <div className="grid gap-2">
            {runs.slice(0, 5).map((run) => (
              <div
                key={run.id}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md bg-muted/30 px-3 py-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={runStatusVariant(run.status)}>{run.status}</Badge>
                    <span className="text-muted-foreground">{run.trigger.type}</span>
                    <span className="text-muted-foreground">
                      <ClockIcon className="me-1 inline size-3" />
                      {formatDateTime(run.scheduledFor)}
                    </span>
                  </div>
                  {run.error ? (
                    <div className="mt-1 truncate text-destructive">{run.error}</div>
                  ) : null}
                </div>
                <div className="flex items-center gap-1">
                  {run.threadId
                    ? (() => {
                        const threadId = run.threadId;
                        return (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => onOpenThread(threadId)}
                          >
                            Open
                          </Button>
                        );
                      })()
                    : null}
                  {run.status === "running" ||
                  run.status === "pending" ||
                  run.status === "claimed" ? (
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Cancel run"
                      onClick={() => onCancelRun(run)}
                    >
                      <StopFilledIcon className="size-4" />
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">No runs yet.</div>
        )}
      </div>
    </section>
  );
}

function AutomationDialog({
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
              onChange={(event) => setField("projectId", event.target.value)}
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

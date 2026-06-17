import {
  MODEL_OPTIONS_BY_PROVIDER,
  type AutomationDefinition,
  type AutomationRun,
  type AutomationSchedule,
  type AutomationUpdateInput,
  type AutomationWorktreeMode,
} from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { SidebarHeaderNavigationControls } from "~/components/SidebarHeaderNavigationControls";
import { Button } from "~/components/ui/button";
import { ChevronDownIcon, PencilIcon, PlayIcon, StopFilledIcon, Trash2 } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import {
  type AutomationFormState,
  AutomationDialog,
  formatDateTime,
  formatRelativeTime,
  formFromDefinition,
  isFormSubmittable,
  runStatusVariant,
  updateInputFromForm,
  useAutomations,
  weekdayLabel,
} from "./-automations.shared";
import { resolveThreadPickerTitle } from "./-chatThreadRoute.logic";

export const Route = createFileRoute("/_chat/automations/$automationId")({
  component: AutomationDetailView,
});

function lastFinishedRun(runs: readonly AutomationRun[]): AutomationRun | null {
  return runs.find((run) => run.finishedAt != null || run.startedAt != null) ?? null;
}

type SelectOption = { readonly value: string; readonly label: string };

const WORKTREE_OPTIONS: readonly SelectOption[] = [
  { value: "auto", label: "Auto" },
  { value: "local", label: "Local" },
  { value: "worktree", label: "Worktree" },
];

const SCHEDULE_TYPE_OPTIONS: readonly SelectOption[] = [
  { value: "manual", label: "Manual" },
  { value: "interval", label: "Interval" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];

const INTERVAL_PRESETS: readonly SelectOption[] = [
  { value: "900", label: "Every 15 min" },
  { value: "1800", label: "Every 30 min" },
  { value: "3600", label: "Every hour" },
  { value: "7200", label: "Every 2 hours" },
  { value: "21600", label: "Every 6 hours" },
  { value: "43200", label: "Every 12 hours" },
  { value: "86400", label: "Every 24 hours" },
];

const MAX_ITERATION_OPTIONS: readonly SelectOption[] = [
  { value: "", label: "Unlimited" },
  { value: "10", label: "10 runs" },
  { value: "25", label: "25 runs" },
  { value: "50", label: "50 runs" },
  { value: "100", label: "100 runs" },
  { value: "250", label: "250 runs" },
];

// Preserve params across schedule-type switches where they still apply.
function scheduleForType(
  type: AutomationSchedule["type"],
  current: AutomationSchedule,
): AutomationSchedule {
  const timeOfDay =
    current.type === "daily" || current.type === "weekly" ? current.timeOfDay : "09:00";
  switch (type) {
    case "manual":
      return { type: "manual" };
    case "interval":
      return {
        type: "interval",
        everySeconds: current.type === "interval" ? current.everySeconds : 3600,
      };
    case "daily":
      return { type: "daily", timeOfDay };
    case "weekly":
      return {
        type: "weekly",
        dayOfWeek: current.type === "weekly" ? current.dayOfWeek : 1,
        timeOfDay,
      };
  }
}

function intervalOptions(current: number): readonly SelectOption[] {
  if (INTERVAL_PRESETS.some((option) => option.value === String(current))) {
    return INTERVAL_PRESETS;
  }
  const minutes = Math.max(1, Math.round(current / 60));
  return [{ value: String(current), label: `Every ${minutes} min` }, ...INTERVAL_PRESETS];
}

function AutomationDetailView() {
  const { automationId } = Route.useParams();
  const navigate = useNavigate();
  const projects = useStore((state) => state.projects);
  const threads = useStore((state) => state.threads);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<AutomationFormState | null>(null);

  const {
    data,
    updateMutation,
    deleteMutation,
    runNowMutation,
    cancelRunMutation,
    runsByAutomationId,
  } = useAutomations((threadId) => void navigate({ to: "/$threadId", params: { threadId } }));

  const definition = data.definitions.find((candidate) => candidate.id === automationId) ?? null;
  const runs = useMemo(
    () => runsByAutomationId.get(automationId) ?? [],
    [runsByAutomationId, automationId],
  );

  if (!definition) {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <header className="drag-region flex h-12 shrink-0 items-center gap-3 border-b border-border/60 px-3">
          <SidebarHeaderNavigationControls />
          <h1 className="truncate font-heading text-sm font-semibold">Automations</h1>
        </header>
        <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          Automation not found.
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void navigate({ to: "/automations" })}
          >
            Back to automations
          </Button>
        </main>
      </div>
    );
  }

  const project = projects.find((candidate) => candidate.id === definition.projectId);
  const targetThread = threads.find((candidate) => candidate.id === definition.targetThreadId);
  const lastRun = lastFinishedRun(runs);
  const schedule = definition.schedule;

  const patch = (input: Omit<AutomationUpdateInput, "id">) =>
    updateMutation.mutate({ id: definition.id, ...input });

  const modelOptions: SelectOption[] = (
    MODEL_OPTIONS_BY_PROVIDER[definition.modelSelection.provider] ?? []
  ).map((option) => ({ value: option.slug, label: option.name }));
  if (!modelOptions.some((option) => option.value === definition.modelSelection.model)) {
    modelOptions.unshift({
      value: definition.modelSelection.model,
      label: definition.modelSelection.model,
    });
  }

  const openEditDialog = () => {
    setForm(formFromDefinition(definition, project?.id ?? projects[0]?.id ?? ""));
    setDialogOpen(true);
  };

  const submitForm = () => {
    if (!form || !isFormSubmittable(form)) return;
    updateMutation.mutate(updateInputFromForm(definition, form, projects), {
      onSuccess: () => setDialogOpen(false),
    });
  };

  const togglePause = () => {
    updateMutation.mutate({ id: definition.id, enabled: !definition.enabled });
  };

  const deleteDefinition = async () => {
    const confirmed = await ensureNativeApi().dialogs.confirm(`Delete "${definition.name}"?`);
    if (!confirmed) return;
    deleteMutation.mutate(definition, {
      onSuccess: () => void navigate({ to: "/automations" }),
    });
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
      <header className="drag-region flex h-12 shrink-0 items-center border-b border-border/60">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-3 px-6">
          <SidebarHeaderNavigationControls />
          <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
            <button
              type="button"
              onClick={() => void navigate({ to: "/automations" })}
              className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
            >
              Automations
            </button>
            <span className="shrink-0 text-muted-foreground">/</span>
            <span className="truncate font-heading font-semibold">{definition.name}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={togglePause}>
              {definition.enabled ? "Pause" : "Resume"}
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Edit"
              onClick={openEditDialog}
            >
              <PencilIcon className="size-4" />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Delete"
              onClick={() => void deleteDefinition()}
            >
              <Trash2 className="size-4" />
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={runNowMutation.isPending}
              onClick={() => runNowMutation.mutate(definition)}
            >
              <PlayIcon className="size-4" />
              Run now
            </Button>
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-6 py-8 md:flex-row">
          <div className="min-w-0 flex-1 space-y-3">
            <h1 className="font-heading text-xl font-semibold tracking-tight">{definition.name}</h1>
            <p className="max-w-2xl whitespace-pre-wrap text-sm leading-relaxed text-foreground/80">
              {definition.prompt}
            </p>
          </div>

          <aside className="flex w-full shrink-0 flex-col gap-6 md:w-72">
            <DetailGroup title="Status">
              <DetailRow label="Status">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className={cn(
                      "size-2 rounded-full",
                      definition.enabled ? "bg-emerald-500" : "bg-muted-foreground/40",
                    )}
                  />
                  {definition.enabled ? "Active" : "Paused"}
                </span>
              </DetailRow>
              <DetailRow label="Next run">{formatDateTime(definition.nextRunAt)}</DetailRow>
              <DetailRow label="Last ran">
                {lastRun ? formatDateTime(lastRun.finishedAt ?? lastRun.startedAt) : "Never"}
              </DetailRow>
            </DetailGroup>

            <DetailGroup title="Details">
              {definition.mode === "heartbeat" ? (
                <DetailRow label="Runs in">Thread</DetailRow>
              ) : (
                <EditRow label="Runs in">
                  <InlineSelect
                    value={definition.worktreeMode}
                    options={WORKTREE_OPTIONS}
                    onChange={(value) => patch({ worktreeMode: value as AutomationWorktreeMode })}
                  />
                </EditRow>
              )}
              {definition.mode === "heartbeat" ? (
                <DetailRow label="Project">{project?.name ?? "Unknown project"}</DetailRow>
              ) : (
                <EditRow label="Project">
                  <InlineSelect
                    value={definition.projectId}
                    options={projects.map((entry) => ({ value: entry.id, label: entry.name }))}
                    onChange={(value) =>
                      patch({ projectId: value as AutomationDefinition["projectId"] })
                    }
                  />
                </EditRow>
              )}
              <EditRow label="Repeats">
                <InlineSelect
                  value={schedule.type}
                  options={SCHEDULE_TYPE_OPTIONS}
                  onChange={(value) =>
                    patch({
                      schedule: scheduleForType(value as AutomationSchedule["type"], schedule),
                    })
                  }
                />
              </EditRow>
              {schedule.type === "interval" ? (
                <EditRow label="Every">
                  <InlineSelect
                    value={String(schedule.everySeconds)}
                    options={intervalOptions(schedule.everySeconds)}
                    onChange={(value) =>
                      patch({
                        schedule: { type: "interval", everySeconds: Number.parseInt(value, 10) },
                      })
                    }
                  />
                </EditRow>
              ) : null}
              {schedule.type === "daily" ? (
                <EditRow label="Time (UTC)">
                  <InlineTime
                    value={schedule.timeOfDay}
                    onChange={(value) =>
                      value ? patch({ schedule: { type: "daily", timeOfDay: value } }) : undefined
                    }
                  />
                </EditRow>
              ) : null}
              {schedule.type === "weekly" ? (
                <>
                  <EditRow label="Day">
                    <InlineSelect
                      value={String(schedule.dayOfWeek)}
                      options={[0, 1, 2, 3, 4, 5, 6].map((day) => ({
                        value: String(day),
                        label: weekdayLabel(day),
                      }))}
                      onChange={(value) =>
                        patch({
                          schedule: {
                            type: "weekly",
                            dayOfWeek: Number.parseInt(value, 10),
                            timeOfDay: schedule.timeOfDay,
                          },
                        })
                      }
                    />
                  </EditRow>
                  <EditRow label="Time (UTC)">
                    <InlineTime
                      value={schedule.timeOfDay}
                      onChange={(value) =>
                        value
                          ? patch({
                              schedule: {
                                type: "weekly",
                                dayOfWeek: schedule.dayOfWeek,
                                timeOfDay: value,
                              },
                            })
                          : undefined
                      }
                    />
                  </EditRow>
                </>
              ) : null}
              <EditRow label="Model">
                <InlineSelect
                  value={definition.modelSelection.model}
                  options={modelOptions}
                  onChange={(value) =>
                    patch({
                      modelSelection: {
                        provider: definition.modelSelection.provider,
                        model: value,
                      },
                    })
                  }
                />
              </EditRow>
              <DetailRow label="Mode">
                {definition.mode === "heartbeat" ? "Heartbeat" : "Standalone"}
              </DetailRow>
              {definition.mode === "heartbeat" ? (
                <EditRow label="Max iterations">
                  <InlineSelect
                    value={definition.maxIterations == null ? "" : String(definition.maxIterations)}
                    options={MAX_ITERATION_OPTIONS}
                    onChange={(value) =>
                      patch({ maxIterations: value === "" ? null : Number.parseInt(value, 10) })
                    }
                  />
                </EditRow>
              ) : null}
              {definition.mode === "heartbeat" && targetThread ? (
                <DetailRow label="Thread">{resolveThreadPickerTitle(targetThread.title)}</DetailRow>
              ) : null}
            </DetailGroup>

            <DetailGroup title="Previous runs">
              {runs.length === 0 ? (
                <div className="px-1 text-xs text-muted-foreground">No runs yet.</div>
              ) : (
                <div className="flex flex-col gap-1">
                  {runs.map((run) => (
                    <RunRow
                      key={run.id}
                      run={run}
                      onOpen={(threadId) =>
                        void navigate({ to: "/$threadId", params: { threadId } })
                      }
                      onCancel={() => cancelRunMutation.mutate(run)}
                    />
                  ))}
                </div>
              )}
            </DetailGroup>
          </aside>
        </div>
      </main>

      {form ? (
        <AutomationDialog
          open={dialogOpen}
          editing
          form={form}
          projects={projects}
          threads={threads}
          onOpenChange={setDialogOpen}
          onFormChange={setForm}
          onSubmit={submitForm}
          busy={updateMutation.isPending}
        />
      ) : null}
    </div>
  );
}

function DetailGroup({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="space-y-1.5">
      <h2 className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <div className="rounded-lg border border-border">{children}</div>
    </section>
  );
}

function DetailRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2 text-xs last:border-b-0">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right font-medium text-foreground">{children}</span>
    </div>
  );
}

function EditRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border/60 py-px pl-3 pr-1.5 text-xs transition-colors last:border-b-0 hover:bg-foreground/[0.03]">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

const INLINE_CONTROL_CLASS =
  "cursor-pointer rounded-md bg-transparent px-2 py-1.5 text-right text-xs font-medium text-foreground outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring";

function InlineSelect({
  value,
  options,
  onChange,
}: {
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="relative flex min-w-0 items-center">
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn(INLINE_CONTROL_CLASS, "max-w-[12rem] appearance-none truncate pr-6")}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-1.5 size-3 text-muted-foreground" />
    </div>
  );
}

function InlineTime({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <input
      type="time"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={INLINE_CONTROL_CLASS}
    />
  );
}

function RunRow({
  run,
  onOpen,
  onCancel,
}: {
  readonly run: AutomationRun;
  readonly onOpen: (threadId: NonNullable<AutomationRun["threadId"]>) => void;
  readonly onCancel: () => void;
}) {
  const variant = runStatusVariant(run.status);
  const dotClass =
    variant === "success"
      ? "text-emerald-500"
      : variant === "error"
        ? "text-destructive"
        : variant === "warning"
          ? "text-amber-500"
          : variant === "info"
            ? "text-blue-500"
            : "text-muted-foreground/50";
  const active = run.status === "running" || run.status === "pending" || run.status === "claimed";
  return (
    <div className="flex items-center gap-2 rounded-md px-1 py-1.5 text-xs">
      <span className={cn("shrink-0", dotClass)}>
        <span className="block size-2 rounded-full bg-current" />
      </span>
      <div className="min-w-0 flex-1 truncate">
        <span className="font-medium text-foreground">{run.status}</span>
        <span className="text-muted-foreground"> • {run.trigger.type}</span>
      </div>
      {run.threadId ? (
        <button
          type="button"
          onClick={() => onOpen(run.threadId as NonNullable<AutomationRun["threadId"]>)}
          className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
        >
          Open
        </button>
      ) : null}
      {active ? (
        <Button
          type="button"
          size="icon-chip"
          variant="ghost"
          aria-label="Cancel run"
          onClick={onCancel}
        >
          <StopFilledIcon className="size-3.5" />
        </Button>
      ) : null}
      <span className="shrink-0 text-muted-foreground">
        {formatRelativeTime(run.finishedAt ?? run.startedAt ?? run.scheduledFor)}
      </span>
    </div>
  );
}

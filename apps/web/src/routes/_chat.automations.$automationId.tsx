import {
  type AutomationDefinition,
  type AutomationRun,
  type AutomationUpdateInput,
  type AutomationWorktreeMode,
} from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { getProviderStartOptions, useAppSettings } from "~/appSettings";
import {
  CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
  CHAT_SURFACE_HEADER_PADDING_X_CLASS,
} from "~/components/chat/chatHeaderControls";
import {
  CHAT_BACKGROUND_CLASS_NAME,
  CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME,
  CHAT_ROUTE_INSET_SHELL_CLASS_NAME,
} from "~/components/chat/composerPickerStyles";
import { SidebarHeaderNavigationControls } from "~/components/SidebarHeaderNavigationControls";
import { Button } from "~/components/ui/button";
import { SidebarInset } from "~/components/ui/sidebar";
import {
  hasBlockingAutomationDraftWarnings,
  warningIdsForAcknowledgedRisks,
  type AutomationDraftWarning,
  type AutomationDraftWarningId,
} from "~/lib/automationDraft";
import {
  completionPolicyFromStopWhen,
  stopWhenFromCompletionPolicy,
} from "~/lib/automationCompletionPolicy";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import { ChevronDownIcon, PencilIcon, PlayIcon, StopFilledIcon, Trash2 } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import {
  type AutomationFormState,
  AutomationDialog,
  AutomationModelPicker,
  acknowledgedRiskIdsForFormWarnings,
  buildAutomationFormWarnings,
  canCancelAutomationRun,
  datetimeLocalFromIso,
  formatDateTime,
  formatRelativeTime,
  formFromDefinition,
  isoFromDatetimeLocal,
  isTriageRun,
  isFormSubmittable,
  providerOptionsForAutomationEdit,
  providerOptionsForAutomationModelSelection,
  runStatusVariant,
  runResultSummary,
  runStatusLabel,
  SCHEDULE_KIND_OPTIONS,
  scheduleFromKind,
  scheduleKindFromSchedule,
  updateWeeklyScheduleDay,
  updateWeeklyScheduleTime,
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
  const { settings } = useAppSettings();
  const desktopTopBarTrafficLightGutterClassName = useDesktopTopBarTrafficLightGutterClassName();
  const desktopTopBarWindowControlsGutterClassName =
    useDesktopTopBarWindowControlsGutterClassName();
  const projects = useStore((state) => state.projects);
  const threads = useStore((state) => state.threads);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<AutomationFormState | null>(null);
  const [dialogWarnings, setDialogWarnings] = useState<readonly AutomationDraftWarning[]>([]);
  const [acknowledgedWarningIds, setAcknowledgedWarningIds] = useState<
    ReadonlySet<AutomationDraftWarningId>
  >(() => new Set());

  const {
    data,
    updateMutation,
    deleteMutation,
    runNowMutation,
    cancelRunMutation,
    markRunReadMutation,
    archiveRunMutation,
    runsByAutomationId,
  } = useAutomations((threadId) => void navigate({ to: "/$threadId", params: { threadId } }));

  const definition = data.definitions.find((candidate) => candidate.id === automationId) ?? null;
  const runs = useMemo(
    () => runsByAutomationId.get(automationId) ?? [],
    [runsByAutomationId, automationId],
  );
  const providerOptionsForDispatch = useMemo(() => getProviderStartOptions(settings), [settings]);

  if (!definition) {
    return (
      <SidebarInset
        className={CHAT_ROUTE_INSET_SHELL_CLASS_NAME}
        surfaceClassName={CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME}
      >
        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
            CHAT_BACKGROUND_CLASS_NAME,
          )}
        >
          <header
            className={cn(
              CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
              CHAT_SURFACE_HEADER_PADDING_X_CLASS,
              "drag-region",
              desktopTopBarTrafficLightGutterClassName,
              desktopTopBarWindowControlsGutterClassName,
            )}
          >
            <div
              className={cn("flex items-center gap-2 sm:gap-3", CHAT_SURFACE_HEADER_HEIGHT_CLASS)}
            >
              <SidebarHeaderNavigationControls />
              <h1 className="truncate font-heading text-sm font-semibold">Automations</h1>
            </div>
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
      </SidebarInset>
    );
  }

  const project = projects.find((candidate) => candidate.id === definition.projectId);
  const targetThread = threads.find((candidate) => candidate.id === definition.targetThreadId);
  const lastRun = lastFinishedRun(runs);
  const schedule = definition.schedule;
  const stopWhen = stopWhenFromCompletionPolicy(definition.completionPolicy);

  const patch = (input: Omit<AutomationUpdateInput, "id">) =>
    updateMutation.mutate({ id: definition.id, ...input });

  const openEditDialog = (overrides: Partial<AutomationFormState> = {}) => {
    const nextForm = {
      ...formFromDefinition(definition, project?.id ?? projects[0]?.id ?? ""),
      ...overrides,
    };
    setForm(nextForm);
    setDialogWarnings(buildAutomationFormWarnings(nextForm));
    setAcknowledgedWarningIds(warningIdsForAcknowledgedRisks(definition.acknowledgedRisks));
    setDialogOpen(true);
  };

  const updateDialogForm = (nextForm: AutomationFormState) => {
    setForm(nextForm);
    setDialogWarnings(buildAutomationFormWarnings(nextForm));
  };

  const toggleWarning = (id: AutomationDraftWarningId, checked: boolean) => {
    setAcknowledgedWarningIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  const submitForm = () => {
    if (!form || !isFormSubmittable(form)) return;
    if (hasBlockingAutomationDraftWarnings(dialogWarnings, acknowledgedWarningIds)) return;
    const acknowledgedRisks = acknowledgedRiskIdsForFormWarnings(
      dialogWarnings,
      acknowledgedWarningIds,
    );
    updateMutation.mutate(
      updateInputFromForm(
        definition,
        form,
        providerOptionsForAutomationEdit(definition, form, providerOptionsForDispatch),
        acknowledgedRisks,
      ),
      {
        onSuccess: () => setDialogOpen(false),
      },
    );
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
    <SidebarInset
      className={CHAT_ROUTE_INSET_SHELL_CLASS_NAME}
      surfaceClassName={CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME}
    >
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
          CHAT_BACKGROUND_CLASS_NAME,
        )}
      >
        <header
          className={cn(
            CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
            CHAT_SURFACE_HEADER_PADDING_X_CLASS,
            "drag-region",
            desktopTopBarTrafficLightGutterClassName,
            desktopTopBarWindowControlsGutterClassName,
          )}
        >
          <div className={cn("flex items-center gap-2 sm:gap-3", CHAT_SURFACE_HEADER_HEIGHT_CLASS)}>
            <SidebarHeaderNavigationControls />
            <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm [-webkit-app-region:no-drag]">
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
            <div className="flex shrink-0 items-center gap-2 [-webkit-app-region:no-drag]">
              <Button type="button" size="sm" variant="ghost" onClick={togglePause}>
                {definition.enabled ? "Pause" : "Resume"}
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Edit"
                onClick={() => openEditDialog()}
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
              <h1 className="font-heading text-xl font-semibold tracking-tight">
                {definition.name}
              </h1>
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
                      onChange={(value) => {
                        if (
                          (value === "local" || value === "auto") &&
                          !definition.acknowledgedRisks.includes("local-checkout")
                        ) {
                          openEditDialog({ worktreeMode: value as AutomationWorktreeMode });
                          return;
                        }
                        patch({ worktreeMode: value as AutomationWorktreeMode });
                      }}
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
                    value={scheduleKindFromSchedule(schedule)}
                    options={SCHEDULE_KIND_OPTIONS}
                    onChange={(value) =>
                      patch({
                        schedule: scheduleFromKind(
                          value as (typeof SCHEDULE_KIND_OPTIONS)[number]["value"],
                          schedule,
                        ),
                      })
                    }
                  />
                </EditRow>
                {schedule.type === "interval" && schedule.everySeconds !== 3600 ? (
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
                {schedule.type === "once" ? (
                  <EditRow label="Run at">
                    <input
                      type="datetime-local"
                      value={datetimeLocalFromIso(schedule.runAt)}
                      onChange={(event) =>
                        event.target.value
                          ? patch({
                              schedule: {
                                type: "once",
                                runAt: isoFromDatetimeLocal(event.target.value),
                              },
                            })
                          : undefined
                      }
                      className={INLINE_CONTROL_CLASS}
                    />
                  </EditRow>
                ) : null}
                {schedule.type === "cron" ? (
                  <EditRow label="Cron">
                    <InlineCommitTextInput
                      value={schedule.expression}
                      onCommit={(value) =>
                        patch({
                          schedule: {
                            type: "cron",
                            expression: value,
                            timezone: schedule.timezone,
                          },
                        })
                      }
                      className="font-mono"
                    />
                  </EditRow>
                ) : null}
                {schedule.type === "daily" || schedule.type === "weekdays" ? (
                  <EditRow label="Time">
                    <InlineTime
                      value={schedule.timeOfDay}
                      onChange={(value) =>
                        value ? patch({ schedule: { ...schedule, timeOfDay: value } }) : undefined
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
                            schedule: updateWeeklyScheduleDay(schedule, Number.parseInt(value, 10)),
                          })
                        }
                      />
                    </EditRow>
                    <EditRow label="Time">
                      <InlineTime
                        value={schedule.timeOfDay}
                        onChange={(value) =>
                          value
                            ? patch({
                                schedule: updateWeeklyScheduleTime(schedule, value),
                              })
                            : undefined
                        }
                      />
                    </EditRow>
                  </>
                ) : null}
                {(schedule.type === "daily" ||
                  schedule.type === "weekdays" ||
                  schedule.type === "weekly" ||
                  schedule.type === "cron") &&
                schedule.timezone ? (
                  <EditRow label="Timezone">
                    <InlineCommitTextInput
                      value={schedule.timezone}
                      onCommit={(value) => patch({ schedule: { ...schedule, timezone: value } })}
                    />
                  </EditRow>
                ) : null}
                <EditRow label="Model">
                  <AutomationModelPicker
                    value={definition.modelSelection}
                    projectCwd={project?.cwd ?? null}
                    onChange={(value) => {
                      const providerOptions = providerOptionsForAutomationModelSelection(
                        definition,
                        value,
                        providerOptionsForDispatch,
                      );
                      patch({
                        modelSelection: value,
                        ...(providerOptions ? { providerOptions } : {}),
                      });
                    }}
                  />
                </EditRow>
                <DetailRow label="Mode">
                  {definition.mode === "heartbeat" ? "Heartbeat" : "Standalone"}
                </DetailRow>
                {definition.mode === "heartbeat" ? (
                  <EditRow label="Stop when">
                    <InlineCommitTextInput
                      value={stopWhen}
                      placeholder="Never"
                      onCommit={(value) =>
                        patch({
                          completionPolicy: completionPolicyFromStopWhen(value),
                        })
                      }
                    />
                  </EditRow>
                ) : null}
                {definition.mode === "heartbeat" ? (
                  <EditRow label="Max iterations">
                    <InlineSelect
                      value={
                        definition.maxIterations == null ? "" : String(definition.maxIterations)
                      }
                      options={MAX_ITERATION_OPTIONS}
                      onChange={(value) =>
                        patch({ maxIterations: value === "" ? null : Number.parseInt(value, 10) })
                      }
                    />
                  </EditRow>
                ) : null}
                {definition.mode === "heartbeat" && targetThread ? (
                  <DetailRow label="Thread">
                    {resolveThreadPickerTitle(targetThread.title)}
                  </DetailRow>
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
                        onMarkRead={(unread) => markRunReadMutation.mutate({ run, unread })}
                        onArchive={(archived) => archiveRunMutation.mutate({ run, archived })}
                      />
                    ))}
                  </div>
                )}
              </DetailGroup>
            </aside>
          </div>
        </main>
      </div>

      {form ? (
        <AutomationDialog
          open={dialogOpen}
          editing
          form={form}
          projects={projects}
          threads={threads}
          warnings={dialogWarnings}
          acknowledgedWarningIds={acknowledgedWarningIds}
          onToggleWarning={toggleWarning}
          onOpenChange={setDialogOpen}
          onFormChange={updateDialogForm}
          onSubmit={submitForm}
          busy={updateMutation.isPending}
        />
      ) : null}
    </SidebarInset>
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

// Keeps free-text schedule fields editable while intermediate cron/timezone text is invalid.
function InlineCommitTextInput({
  value,
  onCommit,
  className,
  placeholder,
}: {
  readonly value: string;
  readonly onCommit: (value: string) => void;
  readonly className?: string;
  readonly placeholder?: string;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commitDraft = () => {
    if (draft !== value) {
      onCommit(draft);
    }
  };

  return (
    <input
      value={draft}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commitDraft}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
      className={cn(INLINE_CONTROL_CLASS, className)}
    />
  );
}

function RunRow({
  run,
  onOpen,
  onCancel,
  onMarkRead,
  onArchive,
}: {
  readonly run: AutomationRun;
  readonly onOpen: (threadId: NonNullable<AutomationRun["threadId"]>) => void;
  readonly onCancel: () => void;
  readonly onMarkRead: (unread: boolean) => void;
  readonly onArchive: (archived: boolean) => void;
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
  const active = canCancelAutomationRun(run);
  const archived = run.result?.archivedAt !== null && run.result?.archivedAt !== undefined;
  const triageActionable = run.result !== null || isTriageRun(run);
  const unread = run.result ? run.result.unread : triageActionable;
  const worktreeLabel =
    run.permissionSnapshot.worktreeMode === "worktree"
      ? "Worktree kept"
      : run.permissionSnapshot.worktreeMode === "auto"
        ? "Auto worktree"
        : null;
  return (
    <div className="flex items-center gap-2 rounded-md px-1 py-1.5 text-xs">
      <span className={cn("shrink-0", dotClass)}>
        <span className="block size-2 rounded-full bg-current" />
      </span>
      <div className="min-w-0 flex-1 truncate">
        <span className="font-medium text-foreground">{runStatusLabel(run.status)}</span>
        <span className="text-muted-foreground"> • {run.trigger.type}</span>
        <span className="text-muted-foreground"> • {runResultSummary(run)}</span>
      </div>
      {worktreeLabel ? (
        <span
          className="shrink-0 text-muted-foreground"
          title="Archiving keeps generated worktrees and branches."
        >
          {worktreeLabel}
        </span>
      ) : null}
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
      {triageActionable ? (
        <>
          <button
            type="button"
            onClick={() => onMarkRead(!unread)}
            className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          >
            {unread ? "Read" : "Unread"}
          </button>
          <button
            type="button"
            onClick={() => onArchive(!archived)}
            title={
              run.permissionSnapshot.worktreeMode === "local"
                ? undefined
                : "Archiving does not remove generated worktrees or branches."
            }
            className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          >
            {archived ? "Unarchive" : "Archive"}
          </button>
        </>
      ) : null}
      <span className="shrink-0 text-muted-foreground">
        {formatRelativeTime(run.finishedAt ?? run.startedAt ?? run.scheduledFor)}
      </span>
    </div>
  );
}

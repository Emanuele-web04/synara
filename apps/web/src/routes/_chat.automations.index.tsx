import { type AutomationDefinition, type AutomationRun } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";

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
  type AutomationDraftWarning,
  type AutomationDraftWarningId,
} from "~/lib/automationDraft";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  ClockIcon,
  ExternalLinkIcon,
  FolderIcon,
  MessageCircleIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useStore } from "~/store";
import {
  type AutomationFormState,
  AutomationDialog,
  acknowledgedRiskIdsForFormWarnings,
  allVisibleTriageRuns,
  automationAttentionCount,
  buildAutomationFormWarnings,
  createInputFromForm,
  formatDateTime,
  formatCadence,
  formatRelativeTime,
  formFromDefinition,
  isFormSubmittable,
  isTriageRun,
  providerOptionsForAutomationEdit,
  projectModelSelection,
  runResultSummary,
  runStatusLabel,
  runStatusVariant,
  updateInputFromForm,
  unresolvedTriageRuns,
  useAutomations,
} from "./-automations.shared";
import { resolveThreadPickerTitle } from "./-chatThreadRoute.logic";

export const Route = createFileRoute("/_chat/automations/")({
  component: AutomationsRouteView,
});

type RowTone = "default" | "info" | "success" | "warning" | "danger" | "muted";
type LiveAutomationRun = AutomationRun & {
  readonly status: "pending" | "claimed" | "running" | "waiting-for-approval";
};

function isLiveRun(run: AutomationRun | null): run is LiveAutomationRun {
  return (
    run?.status === "pending" ||
    run?.status === "claimed" ||
    run?.status === "running" ||
    run?.status === "waiting-for-approval"
  );
}

function toneClasses(tone: RowTone): {
  readonly chip: string;
  readonly icon: string;
  readonly dot: string;
} {
  switch (tone) {
    case "info":
      return {
        chip: "border-blue-500/20 bg-blue-500/10 text-blue-700 dark:text-blue-300",
        icon: "bg-blue-500/10 text-blue-600 dark:text-blue-300",
        dot: "text-blue-500",
      };
    case "success":
      return {
        chip: "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        icon: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
        dot: "text-emerald-500",
      };
    case "warning":
      return {
        chip: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        icon: "bg-amber-500/10 text-amber-600 dark:text-amber-300",
        dot: "text-amber-500",
      };
    case "danger":
      return {
        chip: "border-destructive/25 bg-destructive/10 text-destructive",
        icon: "bg-destructive/10 text-destructive",
        dot: "text-destructive",
      };
    case "muted":
      return {
        chip: "border-border bg-[var(--color-background-elevated-secondary)] text-muted-foreground",
        icon: "bg-[var(--color-background-elevated-secondary)] text-muted-foreground",
        dot: "text-muted-foreground/45",
      };
    case "default":
      return {
        chip: "border-border bg-background text-foreground",
        icon: "bg-[var(--color-background-elevated-secondary)] text-foreground",
        dot: "text-foreground/70",
      };
  }
}

function runTone(run: AutomationRun): RowTone {
  const variant = runStatusVariant(run.status);
  if (variant === "error") return "danger";
  if (variant === "warning") return "warning";
  if (variant === "info") return "info";
  if (variant === "success") return "success";
  return "muted";
}

function triageRunLabel(run: AutomationRun): string {
  if (run.status === "succeeded" && run.result?.unread) return "New result";
  return runStatusLabel(run.status);
}

function automationState(
  definition: AutomationDefinition,
  latestRun: AutomationRun | null,
): { readonly label: string; readonly detail: string; readonly tone: RowTone } {
  if (isLiveRun(latestRun)) {
    return {
      label: runStatusLabel(latestRun.status),
      detail: `Run started ${formatRelativeTime(latestRun.startedAt ?? latestRun.scheduledFor)}`,
      tone: latestRun.status === "waiting-for-approval" ? "warning" : "info",
    };
  }
  if (latestRun && isTriageRun(latestRun)) {
    return {
      label: latestRun.status === "succeeded" ? "New result" : runStatusLabel(latestRun.status),
      detail: runResultSummary(latestRun),
      tone: runTone(latestRun),
    };
  }
  if (
    !definition.enabled &&
    definition.schedule.type === "once" &&
    latestRun?.status === "succeeded"
  ) {
    return {
      label: "Finished",
      detail: "One-time automation completed",
      tone: "success",
    };
  }
  if (!definition.enabled) {
    return {
      label: "Paused",
      detail: "Will not run again until resumed",
      tone: "muted",
    };
  }
  return {
    label: "Scheduled",
    detail: definition.nextRunAt
      ? `Next ${formatDateTime(definition.nextRunAt)}`
      : "Waiting for schedule",
    tone: "default",
  };
}

function joinedParts(parts: readonly (string | null | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(" • ");
}

function AutomationsRouteView() {
  const navigate = useNavigate();
  const { settings } = useAppSettings();
  const desktopTopBarTrafficLightGutterClassName = useDesktopTopBarTrafficLightGutterClassName();
  const desktopTopBarWindowControlsGutterClassName =
    useDesktopTopBarWindowControlsGutterClassName();
  const projects = useStore((state) => state.projects);
  const threads = useStore((state) => state.threads);
  const [editingDefinition, setEditingDefinition] = useState<AutomationDefinition | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogWarnings, setDialogWarnings] = useState<readonly AutomationDraftWarning[]>([]);
  const [acknowledgedWarningIds, setAcknowledgedWarningIds] = useState<
    ReadonlySet<AutomationDraftWarningId>
  >(() => new Set());
  const [triageFilter, setTriageFilter] = useState<"unread" | "all">("unread");
  const fallbackProjectId = projects[0]?.id ?? "";
  const [form, setForm] = useState<AutomationFormState>(() =>
    formFromDefinition(null, fallbackProjectId, projectModelSelection(projects, fallbackProjectId)),
  );

  const { data, isLoading, refetch, createMutation, updateMutation, runsByAutomationId } =
    useAutomations((threadId) => void navigate({ to: "/$threadId", params: { threadId } }));
  const providerOptionsForDispatch = useMemo(() => getProviderStartOptions(settings), [settings]);

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

  const openCreateDialog = () => {
    setEditingDefinition(null);
    const nextForm = formFromDefinition(
      null,
      fallbackProjectId,
      projectModelSelection(projects, fallbackProjectId),
    );
    setForm(nextForm);
    setDialogWarnings(buildAutomationFormWarnings(nextForm));
    setAcknowledgedWarningIds(new Set());
    setDialogOpen(true);
  };

  const submitForm = () => {
    if (!isFormSubmittable(form)) return;
    if (hasBlockingAutomationDraftWarnings(dialogWarnings, acknowledgedWarningIds)) return;
    const acknowledgedRisks = acknowledgedRiskIdsForFormWarnings(
      dialogWarnings,
      acknowledgedWarningIds,
    );
    const closeOnSuccess = { onSuccess: () => setDialogOpen(false) };
    if (editingDefinition) {
      updateMutation.mutate(
        updateInputFromForm(
          editingDefinition,
          form,
          providerOptionsForAutomationEdit(editingDefinition, form, providerOptionsForDispatch),
          acknowledgedRisks,
        ),
        closeOnSuccess,
      );
      return;
    }
    createMutation.mutate(
      createInputFromForm(form, providerOptionsForDispatch, acknowledgedRisks),
      closeOnSuccess,
    );
  };

  const active = data.definitions.filter((definition) => definition.enabled);
  const inactive = data.definitions.filter((definition) => !definition.enabled);
  const allTriageRuns = allVisibleTriageRuns(data.runs);
  const triageRuns = triageFilter === "unread" ? unresolvedTriageRuns(data.runs) : allTriageRuns;
  const unreadTriageCount = automationAttentionCount(data.runs);

  const projectName = (definition: AutomationDefinition) =>
    projects.find((project) => project.id === definition.projectId)?.name ?? "Unknown project";

  const subtitle = (definition: AutomationDefinition) => {
    if (definition.mode === "heartbeat") {
      const thread = threads.find((candidate) => candidate.id === definition.targetThreadId);
      const target = thread ? resolveThreadPickerTitle(thread.title) : projectName(definition);
      return `Heartbeat • ${target}`;
    }
    return projectName(definition);
  };

  const renderRow = (definition: AutomationDefinition) => {
    const latestRun: AutomationRun | null = runsByAutomationId.get(definition.id)?.[0] ?? null;
    const state = automationState(definition, latestRun);
    const classes = toneClasses(state.tone);
    const lastRunTime = latestRun
      ? formatRelativeTime(latestRun.finishedAt ?? latestRun.startedAt ?? latestRun.scheduledFor)
      : null;
    const detailLine = joinedParts([
      subtitle(definition),
      state.detail,
      latestRun ? `Last result: ${runResultSummary(latestRun)}` : null,
    ]);
    return (
      <button
        key={definition.id}
        type="button"
        onClick={() =>
          void navigate({
            to: "/automations/$automationId",
            params: { automationId: definition.id },
          })
        }
        className="group flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors hover:bg-[var(--color-background-elevated-secondary)]"
      >
        <span
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-md",
            classes.icon,
          )}
        >
          {isLiveRun(latestRun) ? (
            <PlayIcon className="size-4" />
          ) : state.label === "Finished" ? (
            <CircleCheckIcon className="size-4" />
          ) : state.tone === "danger" || state.tone === "warning" ? (
            <CircleAlertIcon className="size-4" />
          ) : definition.mode === "heartbeat" ? (
            <MessageCircleIcon className="size-4" />
          ) : (
            <ClockIcon className="size-4" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{definition.name}</span>
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
                classes.chip,
              )}
            >
              <span className={cn("size-1.5 rounded-full bg-current", classes.dot)} />
              {state.label}
            </span>
          </div>
          <div className="mt-1 truncate text-xs text-muted-foreground">{detailLine}</div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 text-right">
          <span className="text-xs font-medium text-foreground">
            {definition.enabled ? formatCadence(definition.schedule) : state.label}
          </span>
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {lastRunTime ?? "No runs"}
          </span>
        </div>
      </button>
    );
  };

  const renderSection = (title: string, defs: readonly AutomationDefinition[]) =>
    defs.length > 0 ? (
      <section className="flex flex-col gap-2">
        <div className="border-b border-border/60 px-3 pb-2">
          <SectionHeading count={defs.length}>{title}</SectionHeading>
        </div>
        <div className="flex flex-col divide-y divide-border/50">{defs.map(renderRow)}</div>
      </section>
    ) : null;

  const renderTriage = () =>
    allTriageRuns.length > 0 ? (
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 pb-2">
          <SectionHeading count={triageRuns.length}>Needs review</SectionHeading>
          <div className="flex items-center gap-1 rounded-md bg-[var(--color-background-elevated-secondary)] p-0.5 text-xs">
            {(["unread", "all"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setTriageFilter(value)}
                className={cn(
                  "rounded px-2 py-1 capitalize transition-colors",
                  triageFilter === value
                    ? "bg-background text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {value === "unread" ? `Unread ${unreadTriageCount}` : `All ${allTriageRuns.length}`}
              </button>
            ))}
          </div>
        </div>
        {triageRuns.length === 0 ? (
          <div className="px-3 py-6 text-sm text-muted-foreground">No unread runs.</div>
        ) : (
          <div className="flex flex-col divide-y divide-border/50">
            {triageRuns.map((run) => {
              const definition = data.definitions.find((entry) => entry.id === run.automationId);
              const tone = runTone(run);
              const classes = toneClasses(tone);
              const destination = run.threadId ? "Open thread" : "View automation";
              const target = definition ? subtitle(definition) : "Saved run";
              const summary = runResultSummary(run);
              return (
                <button
                  key={run.id}
                  type="button"
                  onClick={() =>
                    run.threadId
                      ? void navigate({ to: "/$threadId", params: { threadId: run.threadId } })
                      : definition
                        ? void navigate({
                            to: "/automations/$automationId",
                            params: { automationId: definition.id },
                          })
                        : undefined
                  }
                  className="group flex w-full items-center gap-3 rounded-lg px-3 py-3.5 text-left transition-colors hover:bg-[var(--color-background-elevated-secondary)]"
                >
                  <span
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded-md",
                      classes.icon,
                    )}
                  >
                    {tone === "success" ? (
                      <CircleCheckIcon className="size-4" />
                    ) : tone === "danger" || tone === "warning" ? (
                      <CircleAlertIcon className="size-4" />
                    ) : (
                      <ClockIcon className="size-4" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {definition?.name ?? "Automation run"}
                      </span>
                      <span
                        className={cn(
                          "inline-flex shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
                          classes.chip,
                        )}
                      >
                        {triageRunLabel(run)}
                      </span>
                    </div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">
                      {joinedParts([summary, target])}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1 text-right">
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {formatRelativeTime(run.finishedAt ?? run.startedAt ?? run.scheduledFor)}
                    </span>
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-foreground opacity-80 transition-opacity group-hover:opacity-100">
                      {destination}
                      <ExternalLinkIcon className="size-3" />
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>
    ) : null;

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
            <div className="min-w-0 flex-1" />
            <div className="flex shrink-0 items-center gap-1.5 [-webkit-app-region:no-drag]">
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Refresh"
                onClick={() => void refetch()}
              >
                <RefreshCwIcon className="size-4" />
              </Button>
              <Button type="button" onClick={openCreateDialog} disabled={projects.length === 0}>
                <PlusIcon className="size-4" />
                New automation
              </Button>
            </div>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-7 px-6 pb-12 pt-6">
            <div className="flex flex-col gap-3 px-3 sm:flex-row sm:items-end sm:justify-between">
              <div className="min-w-0">
                <h1 className="font-heading text-[1.75rem] font-semibold leading-tight tracking-tight text-foreground">
                  Automations
                </h1>
              </div>
              {!isLoading && data.definitions.length > 0 ? (
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <SummaryPill icon={<CircleAlertIcon className="size-3.5" />}>
                    {unreadTriageCount} to review
                  </SummaryPill>
                  <SummaryPill icon={<ClockIcon className="size-3.5" />}>
                    {active.length} scheduled
                  </SummaryPill>
                  <SummaryPill icon={<FolderIcon className="size-3.5" />}>
                    {inactive.length} not running
                  </SummaryPill>
                </div>
              ) : null}
            </div>
            {isLoading ? (
              <div className="py-16 text-center text-sm text-muted-foreground">
                Loading automations...
              </div>
            ) : data.definitions.length === 0 ? (
              <div className="flex flex-col items-center gap-1 py-16 text-center">
                <p className="text-sm font-medium text-foreground">No automations yet</p>
                <p className="max-w-xs text-xs text-muted-foreground">
                  Schedule a prompt to run on its own, or wake an existing thread on a loop.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-8">
                {renderTriage()}
                {renderSection("Scheduled", active)}
                {renderSection("Not running", inactive)}
              </div>
            )}
          </div>
        </main>
      </div>

      <AutomationDialog
        open={dialogOpen}
        editing={editingDefinition !== null}
        form={form}
        projects={projects}
        threads={threads}
        warnings={dialogWarnings}
        acknowledgedWarningIds={acknowledgedWarningIds}
        onToggleWarning={toggleWarning}
        onOpenChange={setDialogOpen}
        onFormChange={updateDialogForm}
        onSubmit={submitForm}
        busy={createMutation.isPending || updateMutation.isPending}
      />
    </SidebarInset>
  );
}

function SectionHeading({
  children,
  count,
}: {
  readonly children: ReactNode;
  readonly count: number;
}) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <h2 className="truncate text-base font-semibold text-foreground">{children}</h2>
      <span className="shrink-0 text-xs font-medium text-muted-foreground">{count}</span>
    </div>
  );
}

function SummaryPill({
  icon,
  children,
}: {
  readonly icon: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-[var(--color-background-elevated-secondary)] px-2 py-1 font-medium text-muted-foreground">
      {icon}
      {children}
    </span>
  );
}

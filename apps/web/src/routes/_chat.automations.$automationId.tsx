import { type AutomationRun } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { SidebarHeaderNavigationControls } from "~/components/SidebarHeaderNavigationControls";
import { Button } from "~/components/ui/button";
import { PencilIcon, PlayIcon, StopFilledIcon, Trash2 } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import {
  type AutomationFormState,
  AutomationDialog,
  formatCadence,
  formatDateTime,
  formatRelativeTime,
  formFromDefinition,
  isFormSubmittable,
  runStatusVariant,
  updateInputFromForm,
  useAutomations,
} from "./-automations.shared";
import { resolveThreadPickerTitle } from "./-chatThreadRoute.logic";

export const Route = createFileRoute("/_chat/automations/$automationId")({
  component: AutomationDetailView,
});

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function lastFinishedRun(runs: readonly AutomationRun[]): AutomationRun | null {
  return runs.find((run) => run.finishedAt != null || run.startedAt != null) ?? null;
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
      <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
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
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="drag-region flex h-12 shrink-0 items-center gap-3 border-b border-border/60 px-3">
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
              <DetailRow label="Runs in">
                {definition.mode === "heartbeat" ? "Thread" : capitalize(definition.worktreeMode)}
              </DetailRow>
              <DetailRow label="Project">{project?.name ?? "Unknown project"}</DetailRow>
              <DetailRow label="Repeats">{formatCadence(definition.schedule)}</DetailRow>
              <DetailRow label="Mode">
                {definition.mode === "heartbeat" ? "Heartbeat" : "Standalone"}
              </DetailRow>
              <DetailRow label="Model">{definition.modelSelection.model}</DetailRow>
              <DetailRow label="Max iterations">
                {definition.maxIterations != null
                  ? `${definition.iterationCount}/${definition.maxIterations}`
                  : "Unlimited"}
              </DetailRow>
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

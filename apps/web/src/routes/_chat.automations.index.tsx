import { type AutomationDefinition, type AutomationRun } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { SidebarHeaderNavigationControls } from "~/components/SidebarHeaderNavigationControls";
import { Button } from "~/components/ui/button";
import { PlusIcon, RefreshCwIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useStore } from "~/store";
import {
  type AutomationFormState,
  AutomationDialog,
  automationStatusDotClass,
  createInputFromForm,
  formatCadence,
  formFromDefinition,
  isFormSubmittable,
  updateInputFromForm,
  useAutomations,
} from "./-automations.shared";
import { resolveThreadPickerTitle } from "./-chatThreadRoute.logic";

export const Route = createFileRoute("/_chat/automations/")({
  component: AutomationsRouteView,
});

function AutomationsRouteView() {
  const navigate = useNavigate();
  const projects = useStore((state) => state.projects);
  const threads = useStore((state) => state.threads);
  const [editingDefinition, setEditingDefinition] = useState<AutomationDefinition | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const fallbackProjectId = projects[0]?.id ?? "";
  const [form, setForm] = useState<AutomationFormState>(() =>
    formFromDefinition(null, fallbackProjectId),
  );

  const { data, isLoading, refetch, createMutation, updateMutation, runsByAutomationId } =
    useAutomations((threadId) => void navigate({ to: "/$threadId", params: { threadId } }));

  const openCreateDialog = () => {
    setEditingDefinition(null);
    setForm(formFromDefinition(null, fallbackProjectId));
    setDialogOpen(true);
  };

  const submitForm = () => {
    if (!isFormSubmittable(form)) return;
    const closeOnSuccess = { onSuccess: () => setDialogOpen(false) };
    if (editingDefinition) {
      updateMutation.mutate(updateInputFromForm(editingDefinition, form, projects), closeOnSuccess);
      return;
    }
    createMutation.mutate(createInputFromForm(form, projects), closeOnSuccess);
  };

  const active = data.definitions.filter((definition) => definition.enabled);
  const paused = data.definitions.filter((definition) => !definition.enabled);

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
        className="group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-[var(--color-background-elevated-secondary)]"
      >
        <span
          className={cn(
            "size-2 shrink-0 rounded-full bg-current",
            automationStatusDotClass(definition, latestRun),
          )}
        />
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 truncate text-[0.8125rem] font-medium text-foreground">
            {definition.name}
          </span>
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {subtitle(definition)}
          </span>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {definition.enabled ? formatCadence(definition.schedule) : "Paused"}
        </span>
      </button>
    );
  };

  const renderSection = (title: string, defs: readonly AutomationDefinition[]) =>
    defs.length > 0 ? (
      <section className="flex flex-col">
        <h2 className="border-b border-border/60 px-3 pb-2 text-[0.8125rem] font-semibold text-foreground">
          {title}
        </h2>
        <div className="flex flex-col py-1">{defs.map(renderRow)}</div>
      </section>
    ) : null;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
      <header className="drag-region flex h-12 shrink-0 items-center border-b border-border/60">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-6">
          <SidebarHeaderNavigationControls />
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-heading text-sm font-semibold">Automations</h1>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => void refetch()}>
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
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-8">
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
            <>
              {renderSection("Current", active)}
              {renderSection("Paused", paused)}
            </>
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

import { type AutomationDefinition, type AutomationRun } from "@synara/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import {
  CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
  CHAT_SURFACE_HEADER_PADDING_X_CLASS,
} from "~/components/chat/chatHeaderControls";
import { CHAT_BACKGROUND_CLASS_NAME } from "~/components/chat/composerPickerStyles";
import { SidebarHeaderNavigationControls } from "~/components/SidebarHeaderNavigationControls";
import { Button } from "~/components/ui/button";
import { RouteInsetSurface } from "~/components/RouteInsetSurface";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import { useSidebarLayout } from "~/hooks/useSidebarLayout";
import { CentralIcon } from "~/lib/central-icons";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { automationListRowIcon, useAutomations } from "./-automations.shared";
import {
  AutomationCreateDialog,
  AutomationListRow,
  automationRowSubtitle,
  hasUnreadResult,
  useAutomationListClock,
} from "./-automations.list";

export const Route = createFileRoute("/_chat/automations/")({
  component: AutomationsRouteView,
});

const AUTOMATION_STATUS_FILTERS = ["all", "active", "paused"] as const;
type AutomationStatusFilter = (typeof AUTOMATION_STATUS_FILTERS)[number];

function AutomationsRouteView() {
  const navigate = useNavigate();
  const desktopTopBarTrafficLightGutterClassName = useDesktopTopBarTrafficLightGutterClassName();
  const desktopTopBarWindowControlsGutterClassName =
    useDesktopTopBarWindowControlsGutterClassName();
  const projects = useStore((state) => state.projects);
  // Rail layout: the Automations panel lists every automation, so this page is the
  // "pick one or create one" landing instead of a second copy of the list.
  const isRailLayout = useSidebarLayout() === "rail";
  const [dialogOpen, setDialogOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<AutomationStatusFilter>("all");
  const now = useAutomationListClock();

  const { data, isLoading, refetch, createMutation, deleteMutation, runsByAutomationId } =
    useAutomations((threadId) => void navigate({ to: "/$threadId", params: { threadId } }));

  const openCreateDialog = () => setDialogOpen(true);

  const deleteDefinition = async (definition: AutomationDefinition) => {
    const confirmed = await ensureNativeApi().dialogs.confirm(`Delete "${definition.name}"?`);
    if (!confirmed) return;
    deleteMutation.mutate(definition);
  };

  const active = data.definitions.filter((definition) => definition.enabled);
  const paused = data.definitions.filter((definition) => !definition.enabled);
  const filteredDefinitions =
    statusFilter === "active"
      ? active
      : statusFilter === "paused"
        ? paused
        : [...active, ...paused];

  const renderRow = (definition: AutomationDefinition) => {
    const latestRun: AutomationRun | null = runsByAutomationId.get(definition.id)?.[0] ?? null;
    return (
      <AutomationListRow
        key={definition.id}
        dimmed={!definition.enabled}
        onClick={() =>
          void navigate({
            to: "/automations/$automationId",
            params: { automationId: definition.id },
          })
        }
        leading={(() => {
          const icon = automationListRowIcon(definition, latestRun);
          return <CentralIcon name={icon.name} className={icon.className} />;
        })()}
        title={definition.name}
        detail={automationRowSubtitle(definition, latestRun, now)}
        meta={hasUnreadResult(latestRun) ? "New result" : undefined}
        onDelete={() => void deleteDefinition(definition)}
      />
    );
  };

  const renderStatusFilter = () => (
    <div className="flex items-center gap-1 px-2">
      {AUTOMATION_STATUS_FILTERS.map((value) => (
        <button
          key={value}
          type="button"
          onClick={() => setStatusFilter(value)}
          className={cn(
            "rounded-lg px-2.5 py-1 text-ui leading-snug font-medium capitalize transition-colors",
            statusFilter === value
              ? "bg-[var(--color-background-elevated-secondary)] text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {value}
        </button>
      ))}
    </div>
  );

  const renderAutomationList = () => (
    <section className="flex flex-col gap-2">
      {renderStatusFilter()}
      {filteredDefinitions.length === 0 ? (
        <div className="px-2 py-4 text-ui leading-snug text-muted-foreground">
          {statusFilter === "paused" ? "No paused automations." : "No active automations."}
        </div>
      ) : (
        <div className="flex flex-col">{filteredDefinitions.map(renderRow)}</div>
      )}
    </section>
  );

  return (
    <RouteInsetSurface>
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
            <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Refresh"
                title="Refresh"
                onClick={() => void refetch()}
              >
                <CentralIcon name="arrow-rotate-clockwise" className="size-4" />
              </Button>
              {isRailLayout ? null : (
                <Button
                  type="button"
                  size="sm"
                  onClick={openCreateDialog}
                  disabled={projects.length === 0}
                >
                  <CentralIcon name="plus-small" className="size-4" />
                  New automation
                </Button>
              )}
            </div>
          </div>
        </header>

        {isRailLayout ? (
          <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 pb-16 text-center">
            <CentralIcon name="clock" className="mb-3 size-8 text-muted-foreground" />
            <p className="text-ui-lg font-medium text-foreground">Automations</p>
            <p className="max-w-xs text-ui leading-snug text-muted-foreground">
              Pick an automation in the panel to see its runs, or schedule a new one.
            </p>
            <Button
              type="button"
              size="sm"
              className="mt-4"
              onClick={openCreateDialog}
              disabled={projects.length === 0}
            >
              New automation
            </Button>
          </main>
        ) : (
          <main className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 pb-12 pt-8">
              <h1 className="px-2 font-heading text-2xl font-semibold tracking-tight text-foreground">
                Automations
              </h1>
              {isLoading ? (
                <div className="py-16 text-center text-ui leading-snug text-muted-foreground">
                  Loading automations...
                </div>
              ) : data.definitions.length === 0 ? (
                <div className="flex flex-col items-center gap-1 py-16 text-center">
                  <p className="text-ui-lg font-medium text-foreground">No automations yet</p>
                  <p className="max-w-xs text-ui leading-snug text-muted-foreground">
                    Schedule a prompt to run on its own, or wake an existing thread on a loop.
                  </p>
                </div>
              ) : (
                renderAutomationList()
              )}
            </div>
          </main>
        )}
      </div>

      <AutomationCreateDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        createAutomation={(input, onCreated) =>
          createMutation.mutate(input, { onSuccess: onCreated })
        }
        busy={createMutation.isPending}
      />
    </RouteInsetSurface>
  );
}

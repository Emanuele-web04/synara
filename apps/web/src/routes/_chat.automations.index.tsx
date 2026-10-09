import {
  clearWorkspaceAutomationDraft,
  readWorkspaceAutomationDraft,
} from "~/lib/hosts/automationWorkspace";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { CHAT_BACKGROUND_CLASS_NAME } from "~/components/chat/composerPickerStyles";
import { Button } from "~/components/ui/button";
import { RouteInsetSurface } from "~/components/RouteInsetSurface";
import { RouteSurfaceHeader } from "~/components/RouteSurface";
import { CentralIcon } from "~/lib/central-icons";
import { ClockIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useAutomations } from "./-automations.shared";
import { AutomationCreateDialog } from "./-automations.list";

export const Route = createFileRoute("/_chat/automations/")({
  validateSearch: (search: Record<string, unknown>): { create?: string } =>
    typeof search.create === "string" ? { create: search.create } : {},
  component: AutomationsRouteView,
});

// The Automations panel lists every automation, so this page is the "pick one or create
// one" landing instead of a second copy of the list.
function AutomationsRouteView() {
  const navigate = useNavigate();
  const { create } = Route.useSearch();
  const [dialogOpen, setDialogOpen] = useState(false);

  const { refetch, createMutation } = useAutomations(
    (threadId) => void navigate({ to: "/$threadId", params: { threadId } }),
  );

  const openCreateDialog = () => setDialogOpen(true);

  return (
    <RouteInsetSurface>
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
          CHAT_BACKGROUND_CLASS_NAME,
        )}
      >
        <RouteSurfaceHeader>
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
          </div>
        </RouteSurfaceHeader>

        <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 pb-16 text-center">
          <ClockIcon className="mb-3 size-8 text-muted-foreground" />
          <p className="text-ui-lg font-medium text-foreground">Automations</p>
          <p className="max-w-xs text-ui leading-snug text-muted-foreground">
            Pick an automation in the panel to see its runs, or schedule a new one.
          </p>
          <Button type="button" size="sm" className="mt-4" onClick={openCreateDialog}>
            New automation
          </Button>
        </main>
      </div>

      <AutomationCreateDialog
        key={create ?? "local"}
        open={dialogOpen || Boolean(create)}
        initialDraft={readWorkspaceAutomationDraft(create)}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open && create) {
            clearWorkspaceAutomationDraft(create);
            void navigate({ to: "/automations", search: {} });
          }
        }}
        createAutomation={(input, onCreated) =>
          createMutation.mutate(input, { onSuccess: onCreated })
        }
        busy={createMutation.isPending}
      />
    </RouteInsetSurface>
  );
}

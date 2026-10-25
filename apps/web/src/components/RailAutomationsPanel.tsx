import { useWorkspaceComputers } from "./hosts/ComputerPicker";
import { readAvailableWorkspaceNavigation } from "~/lib/hosts/workspaceSessions";
import { workspaceRoute } from "~/lib/hosts/workspaceFrame";
import { toastManager } from "./ui/toast";
// FILE: RailAutomationsPanel.tsx
// Purpose: The rail layout's Automations panel: title, "New automation", and every automation
//          (active, then paused) as compact rows that open its detail page in the content area.
// Layer: App shell panel (rendered by ThreadSidebar while the Automations section is active)
// Depends on: the shared automation list pieces and create dialog (routes/-automations.list).

import type { AutomationDefinition } from "@synara/contracts";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";

import { CentralIcon } from "~/lib/central-icons";
import { AddPlusIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import {
  AutomationCreateDialog,
  AutomationListRow,
  automationRowSubtitle,
  hasUnreadResult,
  useAutomationListClock,
} from "~/routes/-automations.list";
import { automationListRowIcon, useAutomations } from "~/routes/-automations.shared";
import { SIDEBAR_SECTION_LABEL_CLASS_NAME } from "~/sidebarRowStyles";
import { SidebarPanelTitle } from "./SidebarPanelTitle";
import { SidebarPrimaryAction } from "./SidebarPrimaryAction";
import { SidebarGroup, SidebarMenu } from "./ui/sidebar";

export function RailAutomationsPanel({
  createOpen,
  onCreateOpenChange,
}: {
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const openAutomationId = useParams({
    strict: false,
    select: (params) => (typeof params.automationId === "string" ? params.automationId : null),
  });
  const { sessions, navigate: navigateComputer, computers, localId } = useWorkspaceComputers();
  const href = useLocation({ select: (location) => location.href });
  const remoteAutomations = sessions.flatMap((session) =>
    (session.summary?.automations ?? []).map((automation) => ({ session, automation })),
  );
  const { data, isLoading, createMutation, runsByAutomationId } = useAutomations(
    (threadId) => void navigate({ to: "/$threadId", params: { threadId } }),
  );
  const now = useAutomationListClock();

  const active = data.definitions.filter((definition) => definition.enabled);
  const paused = data.definitions.filter((definition) => !definition.enabled);

  const renderRow = (definition: AutomationDefinition) => {
    const latestRun = runsByAutomationId.get(definition.id)?.[0] ?? null;
    const icon = automationListRowIcon(definition, latestRun);
    return (
      <AutomationListRow
        key={definition.id}
        density="panel"
        active={!href.startsWith("/remote?") && openAutomationId === definition.id}
        dimmed={!definition.enabled}
        onClick={() =>
          void navigate({
            to: "/automations/$automationId",
            params: { automationId: definition.id },
          })
        }
        leading={<CentralIcon name={icon.name} className={icon.className} />}
        title={definition.name}
        detail={[
          sessions.length ? computers.find((computer) => computer.id === localId)?.detail : null,
          automationRowSubtitle(definition, latestRun, now),
        ]
          .filter(Boolean)
          .join(" · ")}
        meta={
          hasUnreadResult(latestRun) ? (
            <span
              aria-label="New result"
              className="block size-1.5 rounded-full bg-[var(--color-text-accent)]"
            />
          ) : undefined
        }
      />
    );
  };

  const renderSection = (
    label: string,
    definitions: readonly AutomationDefinition[],
    enabled: boolean,
  ) => {
    const remoteRows = remoteAutomations.filter(({ automation }) => automation.enabled === enabled);
    return definitions.length === 0 && remoteRows.length === 0 ? null : (
      <section className="flex flex-col">
        <div className={cn("flex h-7 items-center px-2", SIDEBAR_SECTION_LABEL_CLASS_NAME)}>
          {label}
        </div>
        <div className="flex flex-col gap-0.5">
          {definitions.map(renderRow)}
          {remoteRows.map(({ session, automation }) => {
            const path = workspaceRoute(
              session.host.executionScope.environmentId,
              `/automations/${encodeURIComponent(automation.id)}`,
            );
            const available = Boolean(readAvailableWorkspaceNavigation(session));
            return (
              <AutomationListRow
                key={`${session.host.executionScope.environmentId}:${automation.id}`}
                density="panel"
                active={href === path}
                dimmed={!automation.enabled || !available}
                title={automation.name}
                leading={<CentralIcon name="globe" className="size-4 text-muted-foreground" />}
                detail={`${session.host.hostName} · ${available ? automation.detail : "Disconnected"}`}
                meta={
                  automation.unread ? (
                    <span
                      aria-label="New result"
                      className="block size-1.5 rounded-full bg-[var(--color-text-accent)]"
                    />
                  ) : undefined
                }
                onClick={() => {
                  if (!readAvailableWorkspaceNavigation(session)) {
                    toastManager.add({
                      type: "error",
                      title: "Reconnect this computer to manage its automations.",
                    });
                    return;
                  }
                  navigateComputer(path);
                }}
              />
            );
          })}
        </div>
      </section>
    );
  };

  return (
    <>
      <SidebarPanelTitle title="Automations" />
      <SidebarGroup className="px-1.5 pt-1 pb-1.5">
        <SidebarMenu className="gap-0.5">
          <SidebarPrimaryAction
            icon={AddPlusIcon}
            label="New automation"
            onClick={() => onCreateOpenChange(true)}
          />
        </SidebarMenu>
      </SidebarGroup>
      <SidebarGroup className="gap-2 px-1.5 py-1.5">
        {isLoading ? (
          <div className="px-2 pt-4 text-center text-ui text-muted-foreground/58">
            Loading automations...
          </div>
        ) : data.definitions.length === 0 && remoteAutomations.length === 0 ? (
          <div className="px-2 pt-4 text-center text-ui text-muted-foreground/58">
            No automations yet
          </div>
        ) : (
          <>
            {renderSection("Active", active, true)}
            {renderSection("Paused", paused, false)}
          </>
        )}
      </SidebarGroup>
      <AutomationCreateDialog
        open={createOpen}
        onOpenChange={onCreateOpenChange}
        createAutomation={(input, onCreated) =>
          createMutation.mutate(input, { onSuccess: onCreated })
        }
        busy={createMutation.isPending}
      />
    </>
  );
}

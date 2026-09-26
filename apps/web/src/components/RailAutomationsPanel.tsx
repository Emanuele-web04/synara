// FILE: RailAutomationsPanel.tsx
// Purpose: The rail layout's Automations panel: title, "New automation", and every automation
//          (active, then paused) as compact rows that open its detail page in the content area.
// Layer: App shell panel (rendered by ThreadSidebar while the Automations section is active)
// Depends on: the shared automation list pieces and create dialog (routes/-automations.list).

import type { AutomationDefinition } from "@synara/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";

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
import { useStore } from "~/store";
import { SidebarPanelTitle } from "./SidebarPanelTitle";
import { SidebarPrimaryAction } from "./SidebarPrimaryAction";
import { SidebarGroup, SidebarMenu } from "./ui/sidebar";

export function RailAutomationsPanel() {
  const navigate = useNavigate();
  const openAutomationId = useParams({
    strict: false,
    select: (params) => (typeof params.automationId === "string" ? params.automationId : null),
  });
  const projects = useStore((state) => state.projects);
  const { data, isLoading, createMutation, runsByAutomationId } = useAutomations(
    (threadId) => void navigate({ to: "/$threadId", params: { threadId } }),
  );
  const now = useAutomationListClock();
  const [createOpen, setCreateOpen] = useState(false);

  const active = data.definitions.filter((definition) => definition.enabled);
  const paused = data.definitions.filter((definition) => !definition.enabled);

  const renderRow = (definition: AutomationDefinition) => {
    const latestRun = runsByAutomationId.get(definition.id)?.[0] ?? null;
    const icon = automationListRowIcon(definition, latestRun);
    return (
      <AutomationListRow
        key={definition.id}
        density="panel"
        active={openAutomationId === definition.id}
        dimmed={!definition.enabled}
        onClick={() =>
          void navigate({
            to: "/automations/$automationId",
            params: { automationId: definition.id },
          })
        }
        leading={<CentralIcon name={icon.name} className={icon.className} />}
        title={definition.name}
        detail={automationRowSubtitle(definition, latestRun, now)}
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

  const renderSection = (label: string, definitions: readonly AutomationDefinition[]) =>
    definitions.length === 0 ? null : (
      <section className="flex flex-col">
        <div className={cn("flex h-7 items-center px-2", SIDEBAR_SECTION_LABEL_CLASS_NAME)}>
          {label}
        </div>
        <div className="flex flex-col gap-0.5">{definitions.map(renderRow)}</div>
      </section>
    );

  return (
    <>
      <SidebarPanelTitle title="Automations" />
      <SidebarGroup className="px-1.5 pt-1 pb-1.5">
        <SidebarMenu className="gap-0.5">
          <SidebarPrimaryAction
            icon={AddPlusIcon}
            label="New automation"
            disabled={projects.length === 0}
            onClick={() => setCreateOpen(true)}
          />
        </SidebarMenu>
      </SidebarGroup>
      <SidebarGroup className="gap-2 px-1.5 py-1.5">
        {isLoading ? (
          <div className="px-2 pt-4 text-center text-ui text-muted-foreground/58">
            Loading automations...
          </div>
        ) : data.definitions.length === 0 ? (
          <div className="px-2 pt-4 text-center text-ui text-muted-foreground/58">
            No automations yet
          </div>
        ) : (
          <>
            {renderSection("Active", active)}
            {renderSection("Paused", paused)}
          </>
        )}
      </SidebarGroup>
      <AutomationCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        createAutomation={(input, onCreated) =>
          createMutation.mutate(input, { onSuccess: onCreated })
        }
        busy={createMutation.isPending}
      />
    </>
  );
}

// FILE: TerminalChrome.tsx
// Purpose: Reusable terminal chrome primitives for tab bars, sidebars, and toolbar actions.
// Layer: Terminal presentation components
// Depends on: terminal visual identities plus shared popover/button styling.
//
// Note: raw <button> usage in this file is intentional. These are tab-strip and
// list-row affordances (activate tab, close tab, terminal row, group header)
// rather than generic action buttons, so they live outside the shadcn Button
// taxonomy. When/if we introduce a shared Tabs primitive, these can migrate.

import type { ReactNode } from "react";

import type { ResolvedTerminalVisualIdentity } from "@synara/shared/terminalThreads";

import { IconButton } from "~/components/ui/icon-button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { selectRepresentativeTerminalVisualIdentity } from "~/terminalVisualIdentity";

import { DOCK_HEADER_ICON_BUTTON_CLASS, SurfaceTabChip } from "../chat/chatHeaderControls";
import type { ResolvedTerminalGroupLayout } from "./TerminalLayout";
import TerminalActivityIndicator from "./TerminalActivityIndicator";
import TerminalIdentityIcon from "./TerminalIdentityIcon";

export interface TerminalChromeActionItem {
  disabled?: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}

export function TerminalChromeActions(props: {
  actions: ReadonlyArray<TerminalChromeActionItem>;
  variant: "compact" | "workspace" | "sidebar";
}) {
  const buttonClassName =
    props.variant === "sidebar"
      ? "!size-6 shrink-0 rounded-md [&_svg,&_[data-slot=central-icon]]:mx-0"
      : DOCK_HEADER_ICON_BUTTON_CLASS;

  return (
    <div className="inline-flex items-center gap-0.5">
      {props.actions.map((action) => (
        <IconButton
          key={action.label}
          className={cn(buttonClassName, action.disabled ? "pointer-events-none opacity-45" : "")}
          label={action.label}
          tooltip={action.label}
          tooltipSide="bottom"
          size="icon-xs"
          variant="chrome"
          disabled={action.disabled}
          onClick={() => {
            if (action.disabled) return;
            action.onClick();
          }}
        >
          {action.children}
        </IconButton>
      ))}
    </div>
  );
}

export function TerminalWorkspaceTabBar(props: {
  terminalGroups: ResolvedTerminalGroupLayout[];
  activeGroupId: string;
  terminalVisualIdentityById: ReadonlyMap<string, ResolvedTerminalVisualIdentity>;
  actions: ReadonlyArray<TerminalChromeActionItem>;
  onActiveGroupChange: (groupId: string) => void;
  onCloseGroup: (groupId: string) => void;
}) {
  const canCloseGroups = props.terminalGroups.length > 1;
  return (
    <div className="flex min-h-9 min-w-0 items-center gap-1 bg-[var(--color-background-surface)] px-1.5 py-1">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {props.terminalGroups.map((terminalGroup) => {
          const isActive = terminalGroup.id === props.activeGroupId;
          const visualIdentity = selectRepresentativeTerminalVisualIdentity({
            activeTerminalId: terminalGroup.activeTerminalId,
            terminalIds: terminalGroup.terminalIds,
            terminalVisualIdentityById: props.terminalVisualIdentityById,
          })?.identity;
          const groupTitle = visualIdentity?.title ?? "Terminal";
          const closeTabLabel = `Close ${visualIdentity?.title ?? "Terminal tab"}`;
          return (
            <SurfaceTabChip
              key={terminalGroup.id}
              active={isActive}
              title={groupTitle}
              label={groupTitle}
              labelClassName="max-w-40"
              icon={
                <TerminalIdentityIcon
                  className="size-3.5"
                  iconKey={visualIdentity?.iconKey ?? "terminal"}
                />
              }
              leading={
                visualIdentity && visualIdentity.state !== "idle" ? (
                  <TerminalActivityIndicator
                    className="text-foreground/70"
                    state={visualIdentity.state}
                  />
                ) : null
              }
              trailing={
                terminalGroup.terminalIds.length > 1 ? (
                  <span className="shrink-0 text-[10px] text-current/55">
                    {terminalGroup.terminalIds.length}
                  </span>
                ) : null
              }
              closeLabel={closeTabLabel}
              onSelect={() => props.onActiveGroupChange(terminalGroup.id)}
              onClose={canCloseGroups ? () => props.onCloseGroup(terminalGroup.id) : undefined}
            />
          );
        })}
      </div>
      <div className="flex shrink-0 items-center">
        <TerminalChromeActions actions={props.actions} variant="workspace" />
      </div>
    </div>
  );
}

export function TerminalSidebar(props: {
  terminalIds: string[];
  terminalGroups: ResolvedTerminalGroupLayout[];
  activeTerminalId: string;
  activeGroupId: string;
  showGroupHeaders: boolean;
  closeShortcutLabel?: string | undefined;
  terminalVisualIdentityById: ReadonlyMap<string, ResolvedTerminalVisualIdentity>;
  actions: ReadonlyArray<TerminalChromeActionItem>;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
}) {
  return (
    <aside className="flex w-36 min-w-36 flex-col border border-border/70 bg-[var(--color-background-surface)]">
      <div className="flex h-[22px] items-stretch justify-end border-b border-border/70">
        <TerminalChromeActions actions={props.actions} variant="sidebar" />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
        {props.terminalGroups.map((terminalGroup, groupIndex) => {
          const isGroupActive = terminalGroup.id === props.activeGroupId;
          const groupActiveTerminalId = isGroupActive
            ? props.activeTerminalId
            : terminalGroup.activeTerminalId;
          const groupVisualIdentity = props.terminalVisualIdentityById.get(groupActiveTerminalId);

          return (
            <div key={terminalGroup.id} className="pb-0.5">
              {props.showGroupHeaders && (
                <button
                  type="button"
                  className={`flex w-full items-center px-1 py-0.5 text-[10px] ${
                    isGroupActive
                      ? "bg-[var(--sidebar-accent-active)] text-foreground"
                      : "text-muted-foreground hover:bg-[var(--sidebar-accent)] hover:text-foreground"
                  }`}
                  onClick={() => props.onActiveTerminalChange(groupActiveTerminalId)}
                >
                  {groupVisualIdentity?.title ?? `Terminal ${groupIndex + 1}`}
                  {terminalGroup.terminalIds.length > 1
                    ? ` (${terminalGroup.terminalIds.length})`
                    : ""}
                </button>
              )}

              <div
                className={props.showGroupHeaders ? "ml-1 border-l border-border/60 pl-1.5" : ""}
              >
                {terminalGroup.terminalIds.map((terminalId) => {
                  const isActive = terminalId === props.activeTerminalId;
                  const visualIdentity = props.terminalVisualIdentityById.get(terminalId);
                  const closeTerminalLabel = `Close ${
                    visualIdentity?.title ?? "terminal"
                  }${isActive && props.closeShortcutLabel ? ` (${props.closeShortcutLabel})` : ""}`;
                  return (
                    <div
                      key={terminalId}
                      className={`group flex items-center gap-1 px-1 py-0.5 text-[11px] ${
                        isActive
                          ? "bg-[var(--sidebar-accent-active)] text-foreground"
                          : "text-muted-foreground hover:bg-[var(--sidebar-accent)] hover:text-foreground"
                      }`}
                    >
                      {props.showGroupHeaders && (
                        <span className="text-[10px] text-muted-foreground/80">└</span>
                      )}
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-1 text-left"
                        onClick={() => props.onActiveTerminalChange(terminalId)}
                      >
                        <TerminalIdentityIcon
                          className="size-3 shrink-0"
                          iconKey={visualIdentity?.iconKey ?? "terminal"}
                        />
                        {visualIdentity && visualIdentity.state !== "idle" ? (
                          <TerminalActivityIndicator
                            className="text-foreground/70"
                            state={visualIdentity.state}
                          />
                        ) : null}
                        <span className="truncate">{visualIdentity?.title ?? "Terminal"}</span>
                      </button>
                      {props.terminalIds.length > 1 && (
                        <Popover>
                          <PopoverTrigger
                            openOnHover
                            render={
                              <button
                                type="button"
                                className="inline-flex size-3.5 items-center justify-center rounded text-xs font-medium leading-none text-muted-foreground opacity-0 transition hover:bg-[var(--sidebar-accent)] hover:text-foreground group-hover:opacity-100"
                                onClick={() => props.onCloseTerminal(terminalId)}
                                aria-label={closeTerminalLabel}
                              />
                            }
                          >
                            <XIcon className="size-2.5" />
                          </PopoverTrigger>
                          <PopoverPopup
                            tooltipStyle
                            side="bottom"
                            sideOffset={6}
                            align="center"
                            className="pointer-events-none select-none"
                          >
                            {closeTerminalLabel}
                          </PopoverPopup>
                        </Popover>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

// FILE: TerminalChrome.tsx
// Purpose: Reusable terminal chrome primitives for tab bars, sidebars, and toolbar actions.
// Layer: Terminal presentation components
// Depends on: terminal visual identities plus shared popover/button styling.

import type { ReactNode } from "react";

import type { ResolvedTerminalVisualIdentity } from "@t3tools/shared/terminalThreads";

import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import type { ThreadTerminalGroup } from "../../types";
import TerminalActivityIndicator from "./TerminalActivityIndicator";
import TerminalIdentityIcon from "./TerminalIdentityIcon";

export interface TerminalChromeActionItem {
  disabled?: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}

interface TerminalActionButtonProps {
  label: string;
  className: string;
  onClick: () => void;
  children: ReactNode;
}

function TerminalActionButton({ label, className, onClick, children }: TerminalActionButtonProps) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        render={<button type="button" className={className} onClick={onClick} aria-label={label} />}
      >
        {children}
      </PopoverTrigger>
      <PopoverPopup
        tooltipStyle
        side="bottom"
        sideOffset={6}
        align="center"
        className="pointer-events-none select-none"
      >
        {label}
      </PopoverPopup>
    </Popover>
  );
}

export function TerminalChromeActions(props: {
  actions: ReadonlyArray<TerminalChromeActionItem>;
  variant: "compact" | "workspace" | "sidebar";
}) {
  const itemClassName =
    props.variant === "workspace"
      ? "inline-flex h-full items-center px-2 text-foreground/90 transition-colors hover:bg-background/55"
      : props.variant === "sidebar"
        ? "inline-flex h-full items-center px-1 text-foreground/90 transition-colors hover:bg-accent/70"
        : "p-1 text-foreground/90 transition-colors hover:bg-accent";

  return (
    <div
      className={cn(
        "inline-flex items-center",
        props.variant === "compact"
          ? "overflow-hidden rounded-md border border-border/80 bg-background/70"
          : "h-full items-stretch",
      )}
    >
      {props.actions.map((action, index) => {
        const shouldRenderDivider = props.variant === "compact" && index > 0;
        return (
          <div key={action.label} className={cn(props.variant === "workspace" ? "" : "contents")}>
            {shouldRenderDivider ? <div className="h-4 w-px bg-border/80" /> : null}
            <TerminalActionButton
              className={cn(
                itemClassName,
                props.variant === "workspace" && index > 0 ? "border-l border-border/70" : "",
                props.variant === "sidebar" && index > 0 ? "border-l border-border/70" : "",
                action.disabled ? "cursor-not-allowed opacity-45 hover:bg-transparent" : "",
              )}
              onClick={() => {
                if (action.disabled) return;
                action.onClick();
              }}
              label={action.label}
            >
              {action.children}
            </TerminalActionButton>
          </div>
        );
      })}
    </div>
  );
}

export function TerminalWorkspaceTabBar(props: {
  terminalIds: string[];
  activeTerminalId: string;
  terminalVisualIdentityById: ReadonlyMap<string, ResolvedTerminalVisualIdentity>;
  actions: ReadonlyArray<TerminalChromeActionItem>;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
}) {
  return (
    <div className="flex min-w-0 items-stretch justify-between border-b border-border/70 bg-muted/[0.08]">
      <div className="flex min-w-0 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {props.terminalIds.map((terminalId) => {
          const isActive = terminalId === props.activeTerminalId;
          const visualIdentity = props.terminalVisualIdentityById.get(terminalId);
          const closeTabLabel = `Close ${visualIdentity?.title ?? "Terminal"}`;
          return (
            <div
              key={terminalId}
              className={cn(
                "group relative flex h-8 shrink-0 items-center gap-2 border-r border-border/70 px-2.5 transition-colors first:border-l first:border-l-border/70",
                isActive
                  ? "bg-background text-foreground before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-foreground/35"
                  : "bg-transparent text-muted-foreground hover:bg-background/40 hover:text-foreground",
              )}
            >
              <button
                type="button"
                className="flex min-w-0 items-center gap-2 text-left"
                onClick={() => props.onActiveTerminalChange(terminalId)}
              >
                <TerminalIdentityIcon
                  className="size-3 shrink-0"
                  iconKey={visualIdentity?.iconKey ?? "terminal"}
                />
                {visualIdentity?.state === "running" ? (
                  <TerminalActivityIndicator className="text-foreground/70" />
                ) : null}
                <span className="truncate text-[12px] leading-4 text-current/90">
                  {visualIdentity?.title ?? "Terminal"}
                </span>
              </button>
              <button
                type="button"
                className={cn(
                  "inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground/80 transition hover:bg-background/55 hover:text-foreground",
                  props.terminalIds.length <= 1 ? "hidden" : "",
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onCloseTerminal(terminalId);
                }}
                aria-label={closeTabLabel}
              >
                <XIcon className="size-2.75" />
              </button>
            </div>
          );
        })}
      </div>
      <div className="shrink-0 border-l border-border/70">
        <TerminalChromeActions actions={props.actions} variant="workspace" />
      </div>
    </div>
  );
}

export function TerminalSidebar(props: {
  terminalIds: string[];
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalId: string;
  showGroupHeaders: boolean;
  closeShortcutLabel?: string | undefined;
  terminalVisualIdentityById: ReadonlyMap<string, ResolvedTerminalVisualIdentity>;
  actions: ReadonlyArray<TerminalChromeActionItem>;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
}) {
  return (
    <aside className="flex w-36 min-w-36 flex-col border border-border/70 bg-muted/10">
      <div className="flex h-[22px] items-stretch justify-end border-b border-border/70">
        <TerminalChromeActions actions={props.actions} variant="sidebar" />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
        {props.terminalGroups.map((terminalGroup, groupIndex) => {
          const isGroupActive = terminalGroup.terminalIds.includes(props.activeTerminalId);
          const groupActiveTerminalId = isGroupActive
            ? props.activeTerminalId
            : (terminalGroup.terminalIds[0] ?? props.activeTerminalId);

          return (
            <div key={terminalGroup.id} className="pb-0.5">
              {props.showGroupHeaders && (
                <button
                  type="button"
                  className={`flex w-full items-center rounded px-1 py-0.5 text-[10px] uppercase tracking-[0.08em] ${
                    isGroupActive
                      ? "bg-accent/70 text-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                  }`}
                  onClick={() => props.onActiveTerminalChange(groupActiveTerminalId)}
                >
                  {terminalGroup.terminalIds.length > 1
                    ? `Split ${groupIndex + 1}`
                    : `Terminal ${groupIndex + 1}`}
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
                      className={`group flex items-center gap-1 rounded px-1 py-0.5 text-[11px] ${
                        isActive
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
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
                        {visualIdentity?.state === "running" ? (
                          <TerminalActivityIndicator className="text-foreground/70" />
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
                                className="inline-flex size-3.5 items-center justify-center rounded text-xs font-medium leading-none text-muted-foreground opacity-0 transition hover:bg-accent hover:text-foreground group-hover:opacity-100"
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

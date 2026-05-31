// FILE: RightDock.tsx
// Purpose: Tabbed multi-pane right sidebar shell (browser, diff, terminal, sidechat, git).
// Layer: Chat right-dock UI
// Depends on: ui/sidebar primitive, right-dock pane metadata, and a caller-provided pane renderer.

import { type CSSProperties, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { PanelRightCloseIcon, PlusIcon, XIcon } from "~/lib/icons";
import type {
  RightDockPane,
  RightDockPaneKind,
  RightDockThreadState,
} from "~/rightDockStore.logic";
import { resolveActivePane } from "~/rightDockStore.logic";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import { Menu, MenuItem, MenuTrigger } from "../ui/menu";
import { Sidebar, SidebarProvider, SidebarRail } from "../ui/sidebar";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
import { CHAT_SURFACE_HEADER_HEIGHT_CLASS } from "./chatHeaderControls";
import { RIGHT_DOCK_PANE_META, resolveRightDockPaneLabel } from "./rightDockPaneMeta";

interface RightDockProps {
  state: RightDockThreadState;
  minWidth: number;
  defaultWidth: string;
  storageKey: string;
  shouldAcceptWidth: (context: { nextWidth: number; wrapper: HTMLElement }) => boolean;
  paneLabelOverrides?: Record<string, string | undefined>;
  addMenuKinds: readonly RightDockPaneKind[];
  onSelectPane: (paneId: string) => void;
  onClosePane: (paneId: string) => void;
  onCollapse: () => void;
  onOpenChange: (open: boolean) => void;
  onAddPane: (kind: RightDockPaneKind) => void;
  renderActivePane: (pane: RightDockPane) => ReactNode;
}

function RightDockTab(props: {
  pane: RightDockPane;
  label: string;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const { Icon } = RIGHT_DOCK_PANE_META[props.pane.kind];
  return (
    <div
      className={cn(
        "group/dock-tab relative flex min-w-0 shrink-0 items-center gap-1.5 rounded-md py-1 pl-2 pr-1 text-xs transition-colors",
        props.active
          ? "bg-secondary text-secondary-foreground"
          : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
      )}
    >
      <button
        type="button"
        className="flex min-w-0 items-center gap-1.5"
        onClick={props.onSelect}
        title={props.label}
        aria-pressed={props.active}
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="max-w-[10rem] truncate">{props.label}</span>
      </button>
      <IconButton
        variant="ghost"
        size="icon-xs"
        label={`Close ${props.label}`}
        tooltip={`Close ${props.label}`}
        tooltipSide="bottom"
        className="size-4 rounded [&_svg]:size-3"
        onClick={(event) => {
          event.stopPropagation();
          props.onClose();
        }}
      >
        <XIcon />
      </IconButton>
    </div>
  );
}

export function RightDock(props: RightDockProps) {
  const activePane = resolveActivePane(props.state);

  return (
    <SidebarProvider
      defaultOpen={false}
      open={props.state.open}
      onOpenChange={props.onOpenChange}
      className="w-auto min-h-0 flex-none bg-transparent"
      style={{ "--sidebar-width": props.defaultWidth } as CSSProperties}
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        className="border-l border-sidebar-border bg-card text-foreground"
        resizable={{
          minWidth: props.minWidth,
          shouldAcceptWidth: props.shouldAcceptWidth,
          storageKey: props.storageKey,
        }}
      >
        <div className="flex h-full min-h-0 w-full flex-col">
          <div
            className={cn(
              "flex shrink-0 items-center gap-1 border-b border-sidebar-border px-1.5",
              CHAT_SURFACE_HEADER_HEIGHT_CLASS,
            )}
          >
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
              {props.state.panes.map((pane) => (
                <RightDockTab
                  key={pane.id}
                  pane={pane}
                  label={resolveRightDockPaneLabel(pane, props.paneLabelOverrides)}
                  active={pane.id === props.state.activePaneId}
                  onSelect={() => props.onSelectPane(pane.id)}
                  onClose={() => props.onClosePane(pane.id)}
                />
              ))}
            </div>
            <Menu modal={false}>
              <MenuTrigger
                render={
                  <Button
                    variant="chrome"
                    size="icon-xs"
                    aria-label="Add panel"
                    title="Add panel"
                    className="size-6 shrink-0 [&_svg]:mx-0"
                  />
                }
              >
                <PlusIcon className="size-3.5" />
              </MenuTrigger>
              <ComposerPickerMenuPopup align="end" side="bottom" className="w-44 min-w-44">
                {props.addMenuKinds.map((kind) => {
                  const { Icon, label } = RIGHT_DOCK_PANE_META[kind];
                  return (
                    <MenuItem key={kind} onClick={() => props.onAddPane(kind)}>
                      <Icon className="size-3.5 shrink-0" />
                      <span>{label}</span>
                    </MenuItem>
                  );
                })}
              </ComposerPickerMenuPopup>
            </Menu>
            <IconButton
              variant="chrome"
              size="icon-xs"
              label="Collapse panel"
              tooltip="Collapse panel"
              tooltipSide="bottom"
              className="size-6 shrink-0"
              onClick={props.onCollapse}
            >
              <PanelRightCloseIcon className="size-3.5" />
            </IconButton>
          </div>
          <div className="relative min-h-0 flex-1">
            {activePane ? (
              <div
                className="flex h-full min-h-0 w-full"
                data-native-browser-surface={activePane.kind === "browser" ? "true" : undefined}
              >
                {props.renderActivePane(activePane)}
              </div>
            ) : null}
          </div>
        </div>
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
}

export default RightDock;

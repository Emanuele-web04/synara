// FILE: RightDock.tsx
// Purpose: Tabbed multi-pane right sidebar shell (browser, diff, terminal, sidechat, git).
// Layer: Chat right-dock UI
// Depends on: ui/sidebar primitive, right-dock pane metadata, and a caller-provided pane renderer.

import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import {
  type DockPaneRuntimeMode,
  EMPTY_PANE_ID_SET,
  reconcileKeepMountedPaneIds,
} from "~/lib/dockPaneActivation";
import { PanelRightCloseIcon, PlusIcon } from "~/lib/icons";
import type {
  RightDockPane,
  RightDockPaneKind,
  RightDockThreadState,
} from "~/rightDockStore.logic";
import { resolveActivePane } from "~/rightDockStore.logic";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import { Menu, MenuItem, MenuTrigger } from "../ui/menu";
import {
  Sidebar,
  SIDEBAR_OFFCANVAS_MOTION_CLASS,
  SIDEBAR_OFFCANVAS_MOTION_SUPPRESSED_CLASS,
  SidebarProvider,
  SidebarRail,
} from "../ui/sidebar";
import { CHAT_BACKGROUND_CLASS_NAME } from "./composerPickerStyles";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
import {
  CHAT_SURFACE_HEADER_ROW_CLASS_NAME,
  DOCK_HEADER_ICON_BUTTON_CLASS,
  SurfaceTabChip,
} from "./chatHeaderControls";
import {
  getRightDockPaneMeta,
  resolveRightDockPaneIcon,
  resolveRightDockPaneLabel,
} from "./rightDockPaneMeta";
import { useDesktopTopBarWindowControlsGutterClassName } from "~/hooks/useDesktopTopBarGutter";

interface RightDockProps {
  state: RightDockThreadState;
  minWidth: number;
  defaultWidth: string;
  shouldAcceptWidth: (context: { nextWidth: number; wrapper: HTMLElement }) => boolean;
  paneLabelOverrides?: Record<string, string | undefined>;
  addMenuKinds: readonly RightDockPaneKind[];
  onSelectPane: (paneId: string) => void;
  onClosePane: (paneId: string) => void;
  onCollapse: () => void;
  onOpenChange: (open: boolean) => void;
  onAddPane: (kind: RightDockPaneKind) => void;
  motionKey?: string;
  activePaneRuntimeMode?: DockPaneRuntimeMode;
  renderPane: (
    pane: RightDockPane,
    context: { runtimeMode: DockPaneRuntimeMode; isActive: boolean },
  ) => ReactNode;
}

function RightDockTab(props: {
  pane: RightDockPane;
  label: string;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <SurfaceTabChip
      active={props.active}
      title={props.label}
      label={props.label}
      labelClassName="max-w-[10rem]"
      icon={resolveRightDockPaneIcon(props.pane)}
      closeLabel={`Close ${props.label}`}
      onSelect={props.onSelect}
      onClose={props.onClose}
    />
  );
}

// Persist which keep-mounted panes (e.g. terminals) have been activated so they
// stay in the DOM while another tab is selected, pruned to live panes so closed
// panes drop out and the set never leaks across thread switches. The set is
// reconciled during render on purpose: when a kept pane stops being active it
// must remain in the rendered list on that same render, otherwise it would
// unmount for a frame and lose the very runtime keep-mount is protecting.
function useKeepMountedPaneIds(
  panes: readonly RightDockPane[],
  activePane: RightDockPane | null,
): ReadonlySet<string> {
  const ref = useRef<ReadonlySet<string>>(EMPTY_PANE_ID_SET);
  ref.current = reconcileKeepMountedPaneIds({
    previous: ref.current,
    panes,
    activePaneId: activePane?.id ?? null,
    activePaneKind: activePane?.kind ?? null,
  });
  return ref.current;
}

export function RightDock(props: RightDockProps) {
  const activePane = resolveActivePane(props.state);
  const activePaneRuntimeMode = props.activePaneRuntimeMode ?? "live";
  // The dock is the right-most surface when open, so its header sits under the
  // fixed Windows caption cluster — reserve the same gutter the chat header uses.
  const desktopTopBarWindowControlsGutterClassName =
    useDesktopTopBarWindowControlsGutterClassName();

  const keepMountedPaneIds = useKeepMountedPaneIds(props.state.panes, activePane);
  // The dock must open as an exact 50/50 split of the chat shell. The CSS
  // default can only approximate half (it cannot observe the resizable left
  // sidebar), so on every open we measure the shell row hosting chat + dock and
  // pin the dock width to exactly half of it. Mid-session drags still resize
  // freely; the next open re-centers the split.
  const contentRef = useRef<HTMLDivElement | null>(null);
  const minWidth = props.minWidth;
  useEffect(() => {
    if (!props.state.open) {
      return;
    }
    const wrapper = contentRef.current?.closest<HTMLElement>("[data-slot='sidebar-wrapper']");
    const shell = wrapper?.parentElement;
    if (!wrapper || !shell) {
      return;
    }
    const halfWidth = Math.round(shell.getBoundingClientRect().width / 2);
    if (halfWidth > 0) {
      wrapper.style.setProperty("--sidebar-width", `${Math.max(minWidth, halfWidth)}px`);
    }
  }, [props.state.open, minWidth]);
  const renderedPanes = props.state.panes.filter(
    (pane) => pane.id === activePane?.id || keepMountedPaneIds.has(pane.id),
  );
  const [allowChromeMotion, setAllowChromeMotion] = useState(() => !props.state.open);
  const [, forceMotionClassRefresh] = useState(0);
  const previousMotionKeyRef = useRef(props.motionKey);
  const motionKeyChanged = previousMotionKeyRef.current !== props.motionKey;
  const shouldSuppressChromeMotion = !allowChromeMotion || motionKeyChanged;

  useEffect(() => {
    const hadMotionKeyChange = previousMotionKeyRef.current !== props.motionKey;
    previousMotionKeyRef.current = props.motionKey;

    if (!shouldSuppressChromeMotion) {
      return;
    }

    if (!allowChromeMotion) {
      setAllowChromeMotion(true);
    }
    if (hadMotionKeyChange && allowChromeMotion) {
      forceMotionClassRefresh((version) => version + 1);
    }
  }, [allowChromeMotion, props.motionKey, shouldSuppressChromeMotion]);

  // Smooth drawer-style easing for the open/close slide. `ease-linear` (the
  // sidebar default) reads as stepped/janky on the wide dock; this curve front-
  // loads motion and settles softly. Applied to both the width gap and the
  // sliding container so they stay in lockstep.
  const chromeMotionClass = shouldSuppressChromeMotion
    ? SIDEBAR_OFFCANVAS_MOTION_SUPPRESSED_CLASS
    : SIDEBAR_OFFCANVAS_MOTION_CLASS;

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
        className={cn(
          "border-l border-[var(--app-surface-divider)] text-foreground",
          chromeMotionClass,
        )}
        innerClassName={CHAT_BACKGROUND_CLASS_NAME}
        gapClassName={chromeMotionClass}
        transparentSurface
        resizable={{
          minWidth: props.minWidth,
          shouldAcceptWidth: props.shouldAcceptWidth,
        }}
      >
        <div ref={contentRef} className="flex h-full min-h-0 w-full flex-col">
          <div
            className={cn(
              CHAT_SURFACE_HEADER_ROW_CLASS_NAME,
              "gap-1 px-1.5",
              desktopTopBarWindowControlsGutterClassName,
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
                    className={DOCK_HEADER_ICON_BUTTON_CLASS}
                  />
                }
              >
                <PlusIcon className="size-3.5" />
              </MenuTrigger>
              <ComposerPickerMenuPopup align="end" side="bottom" className="w-44 min-w-44">
                {props.addMenuKinds.map((kind) => {
                  const { Icon, label } = getRightDockPaneMeta(kind);
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
              className={DOCK_HEADER_ICON_BUTTON_CLASS}
              onClick={props.onCollapse}
            >
              <PanelRightCloseIcon />
            </IconButton>
          </div>
          <div className="relative min-h-0 flex-1">
            {renderedPanes.map((pane) => {
              const isActive = pane.id === activePane?.id;
              // Keep-mounted panes that are not the active tab are already
              // hydrated, so they render live (just hidden); the active pane uses
              // the deferred-aware runtime mode from the activation hook.
              const runtimeMode: DockPaneRuntimeMode = isActive ? activePaneRuntimeMode : "live";
              return (
                <div
                  key={pane.id}
                  className={cn(
                    "absolute inset-0 flex min-h-0 w-full",
                    isActive ? undefined : "invisible pointer-events-none",
                  )}
                  aria-hidden={isActive ? undefined : true}
                  data-native-browser-surface={
                    (pane.kind === "browser" || pane.kind === "live-editor") &&
                    isActive &&
                    runtimeMode === "live"
                      ? "true"
                      : undefined
                  }
                >
                  {props.renderPane(pane, { runtimeMode, isActive })}
                </div>
              );
            })}
          </div>
        </div>
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
}

export default RightDock;

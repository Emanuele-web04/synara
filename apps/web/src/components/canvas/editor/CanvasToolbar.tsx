// FILE: CanvasToolbar.tsx
// Purpose: The floating toolbar over the canvas (V/H, F/R/T and image insert, C, undo and redo,
//          and the zoom menu where nothing else shows it), bottom-centre on the app's popover
//          surface, and the zoom menu the app's top bar and pane headers show.
// Layer: Canvas editor UI
// Exports: CanvasFloatingToolbar, CanvasZoomMenu

import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "~/i18n";
import { DISCLOSURE_FADE_MOTION_CLASS } from "~/lib/disclosureMotion";
import {
  ChevronDownIcon,
  CursorIcon,
  FrameToolIcon,
  HandIcon,
  ImageIcon,
  MessageCircleIcon,
  Redo2Icon,
  RectangleIcon,
  TextToolIcon,
  Undo2Icon,
} from "~/lib/icons";
import { formatZoomPercent } from "~/lib/pdf/pdfZoom";
import { cn } from "~/lib/utils";
import { screenToWorld } from "~/lib/designCanvas";
import { ChatHeaderButton } from "../../chat/chatHeaderControls";
import { ComposerPickerMenuPopup } from "../../chat/ComposerPickerMenuPopup";
import {
  COMPOSER_COMMAND_MENU_SURFACE_CLASS_NAME,
  COMPOSER_PICKER_RADIUS_CLASS_NAME,
} from "../../chat/composerPickerStyles";
import { Button } from "../../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "../../ui/menu";
import { Toggle } from "../../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { useCanvasEditorStore, type CanvasTool } from "../canvasStores";
import { useCanvasEditor } from "./CanvasEditorContext";
import { CanvasZoomField } from "./CanvasZoomField";
import { ShortcutTooltip } from "./ShortcutTooltip";
import type { CanvasLiveCamera } from "./canvasCamera";
import { canvasHistoryFor } from "./canvasHistory";
import { canvasShortcutLabel, canvasShortcutLabelFor } from "./canvasShortcuts";
import { useCanvasCameraCommands } from "./useCanvasCamera";

type ToolEntry = { tool: CanvasTool; key: string; icon: typeof CursorIcon; label: string };

const tool = (
  value: CanvasTool,
  key: string,
  icon: typeof CursorIcon,
  label: string,
): ToolEntry => ({ tool: value, key, icon, label });

// The toolbar's groups: navigate, create (insert image sits with the shapes), comment, history.
const NAVIGATE_TOOLS = [
  tool("move", "v", CursorIcon, "workspace:canvasToolMove"),
  tool("hand", "h", HandIcon, "workspace:canvasToolHand"),
];
const CREATE_TOOLS = [
  tool("frame", "f", FrameToolIcon, "workspace:canvasToolFrame"),
  tool("rectangle", "r", RectangleIcon, "workspace:canvasToolRectangle"),
  tool("text", "t", TextToolIcon, "workspace:canvasToolText"),
];
const COMMENT_TOOL = tool("comment", "c", MessageCircleIcon, "workspace:canvasToolComment");

const TOOLBAR_SEPARATOR = <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />;

/**
 * The toolbar's surface: the opaque popover panel of the app's floating menus, at the radius of
 * the canvas's own menus. It fades out while a gesture drags (the viewport carries
 * `data-canvas-dragging`, see canvasGestureHidesChrome) and takes no pointer events meanwhile.
 */
const FLOATING_TOOLBAR_CLASS_NAME = cn(
  COMPOSER_COMMAND_MENU_SURFACE_CLASS_NAME,
  COMPOSER_PICKER_RADIUS_CLASS_NAME,
  DISCLOSURE_FADE_MOTION_CLASS,
  "pointer-events-auto flex max-w-full shrink-0 items-center gap-0.5 overflow-x-auto p-1 [scrollbar-width:none]",
  "[[data-canvas-dragging]_&]:pointer-events-none [[data-canvas-dragging]_&]:opacity-0",
);

function ToolTooltip({
  label,
  shortcut,
  trigger,
  children,
}: {
  label: string;
  shortcut?: string | undefined;
  trigger: React.ReactElement;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={trigger}>{children}</TooltipTrigger>
      <TooltipPopup side="top" sideOffset={8}>
        <ShortcutTooltip label={label} shortcut={shortcut} />
      </TooltipPopup>
    </Tooltip>
  );
}

/** A one-shot toolbar action (insert image, undo, redo), in the same chrome as the tools. */
function ActionButton({
  label,
  shortcut,
  disabled,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <ToolTooltip
      label={label}
      shortcut={shortcut}
      trigger={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        />
      }
    >
      {children}
    </ToolTooltip>
  );
}

/**
 * The floating toolbar, bottom-centre over the canvas: V/H, F/R/T with image insert, C, undo and
 * redo, and `trailing` (the zoom menu where no header shows it). Same tools, shortcuts and
 * tooltips as the canvas's keys. Only the bar itself takes pointer events; a narrow pane scrolls
 * it sideways rather than letting it cover more of the canvas.
 */
/** Whether this work has anything to undo or redo; re-renders only when either flips. */
function useCanvasHistoryAvailability(workId: string) {
  const history = canvasHistoryFor(workId);
  const canUndo = useSyncExternalStore(history.subscribe, () => history.canUndo);
  const canRedo = useSyncExternalStore(history.subscribe, () => history.canRedo);
  return { canUndo, canRedo };
}

export function CanvasFloatingToolbar({
  viewportElement,
  trailing,
}: {
  /** The canvas this toolbar drives: inserted images land in its centre, picks focus it. */
  viewportElement: () => HTMLElement | null;
  trailing?: ReactNode;
}) {
  const { t } = useTranslation();
  const editor = useCanvasEditor();
  const active = useCanvasEditorStore((state) => state.tool);
  const setTool = useCanvasEditorStore((state) => state.setTool);
  const file = useRef<HTMLInputElement>(null);
  const { canUndo, canRedo } = useCanvasHistoryAvailability(editor.work.id);
  // Hands focus back to the canvas, so single-key shortcuts keep working and the clicked
  // button never shows a keyboard focus ring.
  const refocus = () => viewportElement()?.focus({ preventScroll: true });
  const renderTool = ({ tool: value, key, icon: Icon, label }: ToolEntry) => (
    <ToolTooltip
      key={value}
      label={t(label)}
      shortcut={canvasShortcutLabel(key)}
      trigger={
        <Toggle
          size="sm"
          pressed={active === value}
          aria-label={t(label)}
          disabled={editor.readOnly && value !== "move" && value !== "hand"}
          onPressedChange={() => {
            setTool(value);
            refocus();
          }}
        />
      }
    >
      <Icon />
    </ToolTooltip>
  );
  const insertImage = (selected: File) => {
    const element = viewportElement();
    const center = element
      ? screenToWorld(editor.camera.get(), element.clientWidth / 2, element.clientHeight / 2)
      : { x: 0, y: 0 };
    void editor.commands.placeImage(selected, null, center);
  };
  return (
    <div className="pointer-events-none absolute inset-x-2 bottom-3 z-20 flex justify-center">
      <div
        role="toolbar"
        aria-orientation="horizontal"
        aria-label={t("workspace:canvasTools")}
        data-canvas-ui=""
        data-canvas-toolbar=""
        className={FLOATING_TOOLBAR_CLASS_NAME}
      >
        {NAVIGATE_TOOLS.map(renderTool)}
        {TOOLBAR_SEPARATOR}
        {CREATE_TOOLS.map(renderTool)}
        <ActionButton
          label={t("workspace:canvasInsertImage")}
          disabled={editor.readOnly}
          onClick={() => file.current?.click()}
        >
          <ImageIcon />
        </ActionButton>
        {TOOLBAR_SEPARATOR}
        {renderTool(COMMENT_TOOL)}
        {TOOLBAR_SEPARATOR}
        <ActionButton
          label={t("workspace:canvasUndo")}
          shortcut={canvasShortcutLabel("z", { modKey: true })}
          disabled={editor.readOnly || !canUndo}
          onClick={() => {
            void editor.undo();
            refocus();
          }}
        >
          <Undo2Icon />
        </ActionButton>
        <ActionButton
          label={t("workspace:canvasRedo")}
          shortcut={canvasShortcutLabel("z", { modKey: true, shiftKey: true })}
          disabled={editor.readOnly || !canRedo}
          onClick={() => {
            void editor.redo();
            refocus();
          }}
        >
          <Redo2Icon />
        </ActionButton>
        {trailing ? (
          <>
            {TOOLBAR_SEPARATOR}
            {trailing}
          </>
        ) : null}
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={(event) => {
            const selected = event.target.files?.[0];
            if (selected) insertImage(selected);
            event.target.value = "";
          }}
        />
      </div>
    </div>
  );
}

type ZoomCommand = { label: string; shortcut: string; run: () => void };

const zoomMenuItem = (command: ZoomCommand) => (
  <MenuItem key={command.label} onClick={command.run}>
    {command.label}
    <MenuShortcut>{command.shortcut}</MenuShortcut>
  </MenuItem>
);

/** The zoom percentage, following a wheel zoom before it is committed. */
function ZoomPercent({ camera, zoom }: { camera: CanvasLiveCamera; zoom: number }) {
  const text = useRef<HTMLSpanElement>(null);
  useLayoutEffect(
    () =>
      camera.subscribe((view) => {
        if (text.current) text.current.textContent = formatZoomPercent(view.zoom);
      }),
    [camera],
  );
  return <span ref={text}>{formatZoomPercent(zoom)}</span>;
}

/**
 * The zoom percentage with a typed zoom field and the zoom commands: "30% ⌄" in the app's top
 * bar (the chat header's control chrome), in the floating toolbar or the canvas corner, or the
 * quieter pane-header variant.
 */
export function CanvasZoomMenu({
  viewportElement,
  variant = "default",
  className,
}: {
  viewportElement: () => HTMLElement | null;
  /**
   * `topbar`: a control of the app's top bar. `header`: the quiet percentage of a pane title bar
   * (no chevron, 24px tall). `default`: inside the canvas (toolbar or corner).
   */
  variant?: "default" | "header" | "topbar";
  className?: string;
}) {
  const { t } = useTranslation();
  const { viewport, camera } = useCanvasEditor();
  const zoom = useCanvasCameraCommands(viewportElement);
  const [open, setOpen] = useState(false);
  const commentsHidden = useCanvasEditorStore((state) => state.commentsHidden);
  const toggleComments = useCanvasEditorStore((state) => state.toggleComments);
  const zoomCommands: ZoomCommand[] = [
    {
      label: t("common:viewerToolbar_zoomIn"),
      shortcut: canvasShortcutLabel("+", { modKey: true }),
      run: () => zoom.zoomBy(1.25),
    },
    {
      label: t("common:viewerToolbar_zoomOut"),
      shortcut: canvasShortcutLabel("-", { modKey: true }),
      run: () => zoom.zoomBy(0.8),
    },
    {
      label: t("workspace:canvasZoom100"),
      shortcut: canvasShortcutLabel("0", { shiftKey: true }),
      run: zoom.actualSize,
    },
  ];
  const fitCommands: ZoomCommand[] = [
    {
      label: t("workspace:canvasZoomFitAll"),
      shortcut: canvasShortcutLabel("1", { shiftKey: true }),
      run: zoom.fitAll,
    },
    {
      label: t("workspace:canvasZoomFitSelection"),
      shortcut: canvasShortcutLabel("2", { shiftKey: true }),
      run: zoom.fitSelection,
    },
  ];
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          variant === "topbar" ? (
            <ChatHeaderButton tone="plain" className={cn("gap-1 tabular-nums", className)} />
          ) : (
            <Button
              variant="ghost"
              size={variant === "default" ? "sm" : "xs"}
              data-canvas-ui=""
              className={cn("tabular-nums", variant === "default" && "px-2", className)}
            />
          )
        }
      >
        <ZoomPercent camera={camera} zoom={viewport.zoom} />
        {variant !== "header" && (
          <ChevronDownIcon aria-hidden className="size-3 text-muted-foreground" />
        )}
      </MenuTrigger>
      <ComposerPickerMenuPopup align="end" className="w-54">
        <CanvasZoomField
          autoFocus
          zoom={viewport.zoom}
          className="mb-1"
          onZoom={(value) => {
            zoom.zoomTo(value);
            setOpen(false);
          }}
        />
        {zoomCommands.map(zoomMenuItem)}
        <MenuSeparator />
        {fitCommands.map(zoomMenuItem)}
        <MenuSeparator />
        {/* The ⇧C state: comment pins on the canvas. */}
        <MenuCheckboxItem checked={!commentsHidden} onCheckedChange={() => toggleComments()}>
          {t("workspace:canvasZoomShowComments")}
          <MenuShortcut>{canvasShortcutLabelFor({ id: "toggle-comments" })}</MenuShortcut>
        </MenuCheckboxItem>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

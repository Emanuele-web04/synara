// FILE: CanvasToolbar.tsx
// Purpose: The vertical tool strip at the canvas's left edge (V/H, F/R/T and image insert, C;
//          undo and redo at its foot), on the app's sm toggles and ghost icon buttons, and the
//          zoom menu the inspector's top row shows.
// Layer: Canvas editor UI
// Exports: CanvasToolStrip, CanvasZoomMenu

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "~/i18n";
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
import { ComposerPickerMenuPopup } from "../../chat/ComposerPickerMenuPopup";
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
import { canvasShortcutLabel, canvasShortcutLabelFor } from "./canvasShortcuts";
import { useCanvasCameraCommands } from "./useCanvasCamera";

type ToolEntry = { tool: CanvasTool; key: string; icon: typeof CursorIcon; label: string };

const tool = (
  value: CanvasTool,
  key: string,
  icon: typeof CursorIcon,
  label: string,
): ToolEntry => ({ tool: value, key, icon, label });

// The strip's groups: navigate, create (insert image sits with the shapes), comment; history
// sits at the foot of the strip.
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

const STRIP_SEPARATOR = <span aria-hidden className="my-2 h-px w-4 shrink-0 bg-border" />;

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
      <TooltipPopup side="right" sideOffset={8}>
        <ShortcutTooltip label={label} shortcut={shortcut} />
      </TooltipPopup>
    </Tooltip>
  );
}

/** A one-shot strip action (insert image, undo, redo), in the same chrome as the tools. */
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
 * The vertical tool strip beside the canvas: V/H, F/R/T with image insert, C, and undo and redo
 * at its foot. Same tools, shortcuts and tooltips as the canvas's keys.
 */
export function CanvasToolStrip({
  viewportElement,
  className,
}: {
  /** The canvas this strip drives: inserted images land in its centre, picks focus it. */
  viewportElement: () => HTMLElement | null;
  className?: string;
}) {
  const { t } = useTranslation();
  const editor = useCanvasEditor();
  const active = useCanvasEditorStore((state) => state.tool);
  const setTool = useCanvasEditorStore((state) => state.setTool);
  const file = useRef<HTMLInputElement>(null);
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
    <div
      role="toolbar"
      aria-orientation="vertical"
      aria-label={t("workspace:canvasTools")}
      data-canvas-ui=""
      data-canvas-tool-strip=""
      className={cn(
        "flex w-10 shrink-0 flex-col items-center gap-1 overflow-y-auto border-e border-border py-1.5",
        className,
      )}
    >
      {NAVIGATE_TOOLS.map(renderTool)}
      {STRIP_SEPARATOR}
      {CREATE_TOOLS.map(renderTool)}
      <ActionButton
        label={t("workspace:canvasInsertImage")}
        disabled={editor.readOnly}
        onClick={() => file.current?.click()}
      >
        <ImageIcon />
      </ActionButton>
      {STRIP_SEPARATOR}
      {renderTool(COMMENT_TOOL)}
      <div className="mt-auto flex flex-col items-center gap-1 pt-2">
        <ActionButton
          label={t("workspace:canvasUndo")}
          shortcut={canvasShortcutLabel("z", { modKey: true })}
          disabled={editor.readOnly}
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
          disabled={editor.readOnly}
          onClick={() => {
            void editor.redo();
            refocus();
          }}
        >
          <Redo2Icon />
        </ActionButton>
      </div>
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
 * The zoom percentage with a typed zoom field and the zoom commands: "30% ⌄" in the
 * inspector's top row (or the canvas corner), or the quieter pane-header variant.
 */
export function CanvasZoomMenu({
  viewportElement,
  variant = "default",
  className,
}: {
  viewportElement: () => HTMLElement | null;
  /** `header`: the quiet percentage of a pane title bar (no chevron, 24px tall). */
  variant?: "default" | "header";
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
          <Button
            variant="ghost"
            size="xs"
            data-canvas-ui=""
            className={cn("tabular-nums", className)}
          />
        }
      >
        <ZoomPercent camera={camera} zoom={viewport.zoom} />
        {variant === "default" && <ChevronDownIcon aria-hidden className="size-3" />}
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

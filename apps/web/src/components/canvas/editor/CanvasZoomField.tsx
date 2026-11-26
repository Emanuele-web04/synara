// FILE: CanvasZoomField.tsx
// Purpose: The typed zoom percentage at the top of the canvas zoom menu.
// Layer: Canvas editor UI
// Depends on: the app's input chrome (sm), with the inspector's bare input inside it.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "~/i18n";
import { clampZoom } from "~/lib/designCanvas";
import { cn } from "~/lib/utils";
import { inputControlClassName } from "../../ui/input";
import { INSPECTOR_INPUT_CLASS_NAME } from "../inspector/InspectorControls";

const percentOf = (zoom: number) => String(Math.round(zoom * 100));

/**
 * A zoom percentage the user can type. Enter applies it (clamped to the canvas limits); Escape
 * and blur drop the draft and leave the zoom alone. Inside a menu it keeps typed keys from the
 * menu's typeahead; arrows and Escape still reach the menu.
 */
export function CanvasZoomField({
  zoom,
  onZoom,
  autoFocus = false,
  className,
}: {
  zoom: number;
  /** Receives the clamped zoom factor (1 = 100%). */
  onZoom: (zoom: number) => void;
  /** Focuses and selects the value on mount, so typing replaces it. */
  autoFocus?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(() => percentOf(zoom));
  const [editing, setEditing] = useState(false);
  const value = editing ? draft : percentOf(zoom);
  useEffect(() => {
    if (!autoFocus) return;
    // The menu moves focus to its popup when it opens; take it once that has happened.
    const frame = requestAnimationFrame(() => {
      input.current?.focus({ preventScroll: true });
      input.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [autoFocus]);
  const commit = () => {
    const percent = Number.parseFloat(draft.replace(",", "."));
    setEditing(false);
    if (Number.isFinite(percent) && percent > 0) onZoom(clampZoom(percent / 100));
  };
  return (
    <label className={cn(inputControlClassName("sm"), "gap-1 px-2", className)}>
      <input
        ref={input}
        value={value}
        inputMode="decimal"
        aria-label={t("workspace:canvasZoomLevel")}
        className={INSPECTOR_INPUT_CLASS_NAME}
        onFocus={() => {
          setDraft(percentOf(zoom));
          setEditing(true);
        }}
        onChange={(event) => {
          setEditing(true);
          setDraft(event.target.value.replace(/[^0-9.,]/g, ""));
        }}
        onBlur={() => setEditing(false)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            commit();
            return;
          }
          // Arrows move into the menu items and Escape closes the menu; every other key is
          // typing, which the menu's typeahead must not see.
          if (event.key !== "Escape" && event.key !== "ArrowDown" && event.key !== "ArrowUp")
            event.stopPropagation();
        }}
      />
      <span aria-hidden className="shrink-0 text-muted-foreground">
        %
      </span>
    </label>
  );
}

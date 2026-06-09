import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import { createPanelResizeOverlay, removePanelResizeOverlay } from "~/lib/panelResize";

export interface ReviewSidebarWidthBounds {
  default: number;
  max: number;
  min: number;
}

type ResizeEdge = "left" | "right";

function clampWidth(bounds: ReviewSidebarWidthBounds, value: number): number {
  return Math.min(bounds.max, Math.max(bounds.min, value));
}

function readStoredWidth(storageKey: string, bounds: ReviewSidebarWidthBounds): number {
  if (typeof window === "undefined") {
    return bounds.default;
  }
  const stored = window.localStorage.getItem(storageKey);
  const parsed = stored ? Number.parseInt(stored, 10) : Number.NaN;
  return Number.isFinite(parsed) ? clampWidth(bounds, parsed) : bounds.default;
}

function persistWidth(storageKey: string, width: number): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(storageKey, String(width));
  } catch {
    // Width memory is a convenience; storage failures should not affect review.
  }
}

export function useResizableReviewSidebar(input: {
  bounds: ReviewSidebarWidthBounds;
  edge: ResizeEdge;
  storageKey: string;
}) {
  const [width, setWidth] = useState<number>(() => readStoredWidth(input.storageKey, input.bounds));
  const dragOrigin = useRef<{ x: number; width: number } | null>(null);
  const dragCleanup = useRef<(() => void) | null>(null);

  useEffect(() => {
    setWidth(readStoredWidth(input.storageKey, input.bounds));
  }, [input.bounds, input.storageKey]);

  useEffect(() => {
    persistWidth(input.storageKey, width);
  }, [input.storageKey, width]);

  useEffect(
    () => () => {
      dragCleanup.current?.();
    },
    [],
  );

  const updateWidth = useCallback(
    (nextWidth: number) => setWidth(clampWidth(input.bounds, nextWidth)),
    [input.bounds],
  );

  const handleResizeStart = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      event.preventDefault();
      dragCleanup.current?.();
      dragOrigin.current = { x: event.clientX, width };
      const overlay = createPanelResizeOverlay();

      const onMove = (moveEvent: PointerEvent) => {
        const origin = dragOrigin.current;
        if (!origin) {
          return;
        }
        const delta =
          input.edge === "right" ? moveEvent.clientX - origin.x : origin.x - moveEvent.clientX;
        updateWidth(origin.width + delta);
      };
      const onUp = () => {
        dragOrigin.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        removePanelResizeOverlay(overlay);
        dragCleanup.current = null;
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      dragCleanup.current = onUp;
    },
    [input.edge, updateWidth, width],
  );

  const handleResizeKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const step = event.shiftKey ? 32 : 12;
      const direction = input.edge === "right" ? 1 : -1;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        updateWidth(width - step * direction);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        updateWidth(width + step * direction);
      } else if (event.key === "Home") {
        event.preventDefault();
        updateWidth(input.bounds.min);
      } else if (event.key === "End") {
        event.preventDefault();
        updateWidth(input.bounds.max);
      }
    },
    [input.bounds.max, input.bounds.min, input.edge, updateWidth, width],
  );

  const resetWidth = useCallback(() => {
    updateWidth(input.bounds.default);
  }, [input.bounds.default, updateWidth]);

  return {
    bounds: input.bounds,
    handleResizeKeyDown,
    handleResizeStart,
    resetWidth,
    width,
  };
}

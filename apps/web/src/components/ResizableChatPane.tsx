import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { cn } from "~/lib/utils";

interface ResizeState {
  pointerId: number;
  startX: number;
  startWidth: number;
  pendingWidth: number;
  rafId: number | null;
  restoreBodyCursor: string;
  restoreBodyUserSelect: string;
  onPointerMove: (event: PointerEvent) => void;
  onPointerEnd: (event: PointerEvent) => void;
}

export interface ResizableChatPaneController {
  readonly visible: boolean;
  readonly toggleVisible: () => void;
  readonly width: number;
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly resetWidth: () => void;
  readonly onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}

function readStoredNumber(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  try {
    const value = Number.parseFloat(window.localStorage.getItem(key) ?? "");
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function readStoredVisibility(key: string): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(key) !== "false";
  } catch {
    return true;
  }
}

function storePreference(key: string, value: number | boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Preference persistence is best-effort.
  }
}

export function useResizableChatPane(input: {
  readonly storageKey: string;
  readonly widthStorageKey?: string;
  readonly visibilityStorageKey?: string;
  readonly defaultWidth?: number;
  readonly minWidth?: number;
  readonly maxWidth?: number;
  readonly keyboardStep?: number;
}): ResizableChatPaneController {
  const defaultWidth = input.defaultWidth ?? 384;
  const minWidth = input.minWidth ?? 320;
  const maxWidth = input.maxWidth ?? 600;
  const keyboardStep = input.keyboardStep ?? 24;
  const widthStorageKey = input.widthStorageKey ?? `${input.storageKey}.width`;
  const visibilityStorageKey = input.visibilityStorageKey ?? `${input.storageKey}.visible`;
  const clampWidth = useCallback(
    (width: number) => Math.min(maxWidth, Math.max(minWidth, Math.round(width))),
    [maxWidth, minWidth],
  );
  const [width, setWidth] = useState(() =>
    clampWidth(readStoredNumber(widthStorageKey, defaultWidth)),
  );
  const [visible, setVisible] = useState(() => readStoredVisibility(visibilityStorageKey));
  const resizeStateRef = useRef<ResizeState | null>(null);

  const stopResize = useCallback(() => {
    const state = resizeStateRef.current;
    if (!state || typeof window === "undefined") return;
    if (state.rafId !== null) window.cancelAnimationFrame(state.rafId);
    window.removeEventListener("pointermove", state.onPointerMove);
    window.removeEventListener("pointerup", state.onPointerEnd);
    window.removeEventListener("pointercancel", state.onPointerEnd);
    document.body.style.cursor = state.restoreBodyCursor;
    document.body.style.userSelect = state.restoreBodyUserSelect;
    setWidth(state.pendingWidth);
    storePreference(widthStorageKey, state.pendingWidth);
    resizeStateRef.current = null;
  }, [widthStorageKey]);

  useEffect(() => stopResize, [stopResize]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || typeof window === "undefined") return;
      event.preventDefault();
      event.stopPropagation();
      stopResize();

      const state: ResizeState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: width,
        pendingWidth: width,
        rafId: null,
        restoreBodyCursor: document.body.style.cursor,
        restoreBodyUserSelect: document.body.style.userSelect,
        onPointerMove: () => undefined,
        onPointerEnd: () => undefined,
      };
      state.onPointerMove = (moveEvent) => {
        if (moveEvent.pointerId !== state.pointerId) return;
        state.pendingWidth = clampWidth(state.startWidth + state.startX - moveEvent.clientX);
        if (state.rafId !== null) return;
        state.rafId = window.requestAnimationFrame(() => {
          state.rafId = null;
          setWidth(state.pendingWidth);
        });
      };
      state.onPointerEnd = (endEvent) => {
        if (endEvent.pointerId === state.pointerId) stopResize();
      };
      resizeStateRef.current = state;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", state.onPointerMove);
      window.addEventListener("pointerup", state.onPointerEnd);
      window.addEventListener("pointercancel", state.onPointerEnd);
    },
    [clampWidth, stopResize, width],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const nextWidth =
        event.key === "ArrowLeft"
          ? width + keyboardStep
          : event.key === "ArrowRight"
            ? width - keyboardStep
            : event.key === "Home"
              ? minWidth
              : event.key === "End"
                ? maxWidth
                : null;
      if (nextWidth === null) return;
      event.preventDefault();
      const clamped = clampWidth(nextWidth);
      setWidth(clamped);
      storePreference(widthStorageKey, clamped);
    },
    [clampWidth, keyboardStep, maxWidth, minWidth, width, widthStorageKey],
  );

  return {
    visible,
    toggleVisible: () =>
      setVisible((previous) => {
        const next = !previous;
        storePreference(visibilityStorageKey, next);
        return next;
      }),
    width,
    minWidth,
    maxWidth,
    resetWidth: () => {
      const clamped = clampWidth(defaultWidth);
      setWidth(clamped);
      storePreference(widthStorageKey, clamped);
    },
    onPointerDown,
    onKeyDown,
  };
}

export function ResizableChatPane(props: {
  readonly controller: ResizableChatPaneController;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const pane = props.controller;
  return (
    <>
      <div
        role="separator"
        aria-label="Resize chat panel"
        aria-orientation="vertical"
        aria-valuemin={pane.minWidth}
        aria-valuemax={pane.maxWidth}
        aria-valuenow={pane.width}
        tabIndex={pane.visible ? 0 : -1}
        title="Drag to resize chat panel"
        className={cn(
          "group relative z-10 w-0 shrink-0 cursor-col-resize outline-none",
          pane.visible ? "hidden lg:block" : "hidden",
        )}
        onPointerDown={pane.onPointerDown}
        onDoubleClick={pane.resetWidth}
        onKeyDown={pane.onKeyDown}
      >
        <span
          className="absolute inset-y-0 left-[-3px] w-1.5 cursor-col-resize bg-transparent transition-colors group-hover:bg-[var(--color-background-button-secondary-hover)] group-focus-visible:bg-[var(--color-background-button-secondary-hover)]"
          aria-hidden="true"
        />
        <span
          className="pointer-events-none absolute inset-y-0 left-0 w-px bg-[var(--app-surface-divider)] transition-colors group-hover:bg-[var(--color-text-accent)] group-focus-visible:bg-[var(--color-text-accent)]"
          aria-hidden="true"
        />
      </div>
      <aside
        className={cn(
          "min-h-[18rem] w-full shrink-0 bg-[var(--color-background-surface)] lg:h-full lg:w-[var(--resizable-chat-pane-width)]",
          pane.visible ? "flex" : "hidden",
          props.className,
        )}
        style={{ "--resizable-chat-pane-width": `${pane.width}px` } as CSSProperties}
      >
        {props.children}
      </aside>
    </>
  );
}

// FILE: useComputerPreviewFloat.ts
// Purpose: Detached-window behavior for the in-chat computer preview card.
// Layer: Chat surface hook
// Depends on: computerPreviewStore floating map, ComputerPreviewPopover.logic
//             clamp helpers.
//
// Owns everything the floating card needs that is not rendering: the stored
// viewport position (clamped back on screen every render so a shrinking
// window can never strand it), the pointer-drag that updates it, and the
// pop-out handoff that seeds the float from the card's docked rect.

import type { ThreadId } from "@synara/contracts";
import { type PointerEvent, type RefObject, useMemo, useRef } from "react";

import {
  selectThreadComputerPreviewFloating,
  useComputerPreviewStore,
  type ComputerPreviewFloatingPosition,
} from "../../computerPreviewStore";
import { clampComputerPreviewFloat } from "../chat/ComputerPreviewPopover.logic";

export interface ComputerPreviewFloat {
  /** Stored position once clamped into the current viewport; undefined while docked. */
  readonly position: ComputerPreviewFloatingPosition | undefined;
  /** Detach the card at its current on-screen rect. */
  readonly popOut: () => void;
  /** Re-dock the card into the rail. */
  readonly dock: () => void;
  readonly onFloatPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  readonly onFloatPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  readonly onFloatPointerEnd: (event: PointerEvent<HTMLDivElement>) => void;
}

export function useComputerPreviewFloat(input: {
  readonly threadId: ThreadId;
  readonly cardRef: RefObject<HTMLDivElement | null>;
  /** Rendered card width/height, used for viewport clamping. */
  readonly cardWidthPx: number;
  readonly cardHeightPx: number;
}): ComputerPreviewFloat {
  const { threadId, cardRef } = input;
  const floating = useComputerPreviewStore(selectThreadComputerPreviewFloating(threadId));
  const setPreviewFloating = useComputerPreviewStore((store) => store.setPreviewFloating);
  const movePreviewFloating = useComputerPreviewStore((store) => store.movePreviewFloating);
  const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);

  const position = useMemo(
    () =>
      floating === undefined
        ? undefined
        : clampComputerPreviewFloat({
            x: floating.x,
            y: floating.y,
            cardWidthPx: input.cardWidthPx,
            cardHeightPx: input.cardHeightPx,
            viewportWidthPx:
              typeof window === "undefined" ? Number.MAX_SAFE_INTEGER : window.innerWidth,
            viewportHeightPx:
              typeof window === "undefined" ? Number.MAX_SAFE_INTEGER : window.innerHeight,
          }),
    [floating, input.cardWidthPx, input.cardHeightPx],
  );

  const popOut = () => {
    const rect = cardRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPreviewFloating(
      threadId,
      clampComputerPreviewFloat({
        x: rect.left,
        y: rect.top,
        cardWidthPx: rect.width,
        cardHeightPx: rect.height,
        viewportWidthPx: window.innerWidth,
        viewportHeightPx: window.innerHeight,
      }),
    );
  };

  const dock = () => setPreviewFloating(threadId, null);

  const onFloatPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (floating === undefined || event.button !== 0) return;
    // Buttons inside the card (dock, close) must not start a drag.
    if ((event.target as HTMLElement).closest("button")) return;
    const rect = cardRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onFloatPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (floating === undefined || !drag || drag.pointerId !== event.pointerId) return;
    const rect = cardRef.current?.getBoundingClientRect();
    movePreviewFloating(
      threadId,
      clampComputerPreviewFloat({
        x: event.clientX - drag.offsetX,
        y: event.clientY - drag.offsetY,
        cardWidthPx: rect?.width ?? input.cardWidthPx,
        cardHeightPx: rect?.height ?? input.cardHeightPx,
        viewportWidthPx: window.innerWidth,
        viewportHeightPx: window.innerHeight,
      }),
    );
  };

  const onFloatPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return { position, popOut, dock, onFloatPointerDown, onFloatPointerMove, onFloatPointerEnd };
}

/** Window geometry shared by action routing, observation and fake captures. */
import type { ComputerPoint, ComputerRect, ComputerWindow } from "@synara/contracts";

import { ComputerBackendError } from "./ComputerBackend.ts";

/**
 * Windows stacked above `windowId` whose bounds contain `point` — what a bare
 * coordinate click at that point would hit instead of the named window.
 *
 * Empty when the display server reports no stacking order, or none for the
 * named window: an unknown order cannot establish that anything is above
 * anything, and inventing occlusion from bounds alone would refuse clicks that
 * are perfectly safe. Bounds are frame rects, so an overlap is an upper bound
 * on real occlusion — the covering window may be translucent or shaped — which
 * is the safe direction, because the remedy is raising the target either way.
 */
export function windowsCoveringPoint(
  windows: readonly ComputerWindow[],
  windowId: string,
  point: ComputerPoint,
): readonly ComputerWindow[] {
  const depth = windows.find((window) => window.id === windowId)?.stackingIndex;
  if (depth === undefined) return [];
  return windows.filter(
    (window) =>
      window.id !== windowId &&
      window.visible &&
      !window.minimized &&
      window.stackingIndex !== undefined &&
      window.stackingIndex < depth &&
      rectContainsPoint(window.bounds, point),
  );
}

/**
 * The window a bare coordinate action at `point` was delivered to: the topmost
 * visible, unminimized window whose frame contains the point — the same
 * stacking rule the compositor applies to an unscoped click.
 *
 * With one candidate the stacking order is irrelevant. With several, every
 * candidate must report a stacking index: ranking only the windows that have
 * one could crown a window that an unranked one actually covers, and a wrong
 * answer here photographs a window the action never touched.
 */
export function topmostWindowAtPoint(
  windows: readonly ComputerWindow[],
  point: ComputerPoint,
): ComputerWindow | undefined {
  const candidates = windows.filter(
    (window) => window.visible && !window.minimized && rectContainsPoint(window.bounds, point),
  );
  if (candidates.length <= 1) return candidates[0];
  if (candidates.some((window) => window.stackingIndex === undefined)) return undefined;
  return candidates.reduce((top, window) =>
    (window.stackingIndex as number) < (top.stackingIndex as number) ? window : top,
  );
}

export function rectContainsPoint(rect: ComputerRect | undefined, point: ComputerPoint): boolean {
  if (!rect) return false;
  return (
    point.x >= rect.x &&
    point.y >= rect.y &&
    point.x < rect.x + rect.width &&
    point.y < rect.y + rect.height
  );
}

/**
 * A window's rect, or a refusal that names why there is none.
 *
 * Absent bounds are a property of the backend, not of the window. Every caller
 * here needs a rect to do arithmetic on, and the alternatives are both
 * lies — treating the origin as the window's position puts a click on the wrong
 * monitor, and returning an empty capture tells a model the window is blank. So
 * the geometry-dependent paths refuse, and say which capability is missing so
 * the caller can pick a coordinate-based approach instead.
 */
export function requireWindowBounds(
  window: Pick<ComputerWindow, "id" | "bounds">,
  action: string,
): ComputerRect {
  if (window.bounds) return window.bounds;
  throw new ComputerBackendError(
    `This desktop reports no geometry for window ${JSON.stringify(window.id)}, so ${action} cannot be resolved. ` +
      "The display server exposes window titles and activation but no position or size " +
      "(capabilities.windowBounds is false); use full-screen capture and desktop coordinates instead.",
  );
}

// FILE: windowState.ts
// Purpose: Persists and safely restores the desktop window's normal bounds.
// Layer: Desktop main process

import * as FS from "node:fs";
import * as Path from "node:path";

export interface DesktopWindowBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PersistedDesktopWindowState {
  readonly version: 1;
  readonly bounds: DesktopWindowBounds;
  readonly isMaximized: boolean;
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function isWindowBounds(value: unknown): value is DesktopWindowBounds {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    isFiniteInteger(candidate.x) &&
    isFiniteInteger(candidate.y) &&
    isFiniteInteger(candidate.width) &&
    candidate.width > 0 &&
    isFiniteInteger(candidate.height) &&
    candidate.height > 0
  );
}

export function parseDesktopWindowState(value: unknown): PersistedDesktopWindowState | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    !isWindowBounds(candidate.bounds) ||
    typeof candidate.isMaximized !== "boolean"
  ) {
    return null;
  }
  return {
    version: 1,
    bounds: candidate.bounds,
    isMaximized: candidate.isMaximized,
  };
}

export function readDesktopWindowState(filePath: string): PersistedDesktopWindowState | null {
  try {
    return parseDesktopWindowState(JSON.parse(FS.readFileSync(filePath, "utf8")));
  } catch {
    return null;
  }
}

export function writeDesktopWindowState(
  filePath: string,
  state: PersistedDesktopWindowState,
): void {
  FS.mkdirSync(Path.dirname(filePath), { recursive: true });
  FS.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function intersectionArea(left: DesktopWindowBounds, right: DesktopWindowBounds): number {
  const width = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
  );
  const height = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
  );
  return width * height;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function resolveVisibleWindowBounds(input: {
  readonly savedBounds: DesktopWindowBounds;
  readonly displayWorkAreas: ReadonlyArray<DesktopWindowBounds>;
  readonly minimumWidth: number;
  readonly minimumHeight: number;
}): DesktopWindowBounds {
  const { savedBounds } = input;
  const [firstWorkArea, ...remainingWorkAreas] = input.displayWorkAreas;
  if (!firstWorkArea) {
    return savedBounds;
  }

  let targetWorkArea = firstWorkArea;
  let largestIntersection = intersectionArea(savedBounds, targetWorkArea);
  for (const workArea of remainingWorkAreas) {
    const area = intersectionArea(savedBounds, workArea);
    if (area > largestIntersection) {
      targetWorkArea = workArea;
      largestIntersection = area;
    }
  }

  const width = Math.min(targetWorkArea.width, Math.max(input.minimumWidth, savedBounds.width));
  const height = Math.min(targetWorkArea.height, Math.max(input.minimumHeight, savedBounds.height));
  const centeredX = targetWorkArea.x + Math.round((targetWorkArea.width - width) / 2);
  const centeredY = targetWorkArea.y + Math.round((targetWorkArea.height - height) / 2);

  return {
    x:
      largestIntersection === 0
        ? centeredX
        : clamp(savedBounds.x, targetWorkArea.x, targetWorkArea.x + targetWorkArea.width - width),
    y:
      largestIntersection === 0
        ? centeredY
        : clamp(savedBounds.y, targetWorkArea.y, targetWorkArea.y + targetWorkArea.height - height),
    width,
    height,
  };
}

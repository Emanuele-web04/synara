// FILE: petPosition.ts
// Purpose: Keeps Codex pet position persistence and viewport clamping separate from rendering.
// Layer: Global pet overlay domain helpers
// Exports: pet position helpers used by renderer and desktop overlay sync

import { PET_RENDER_HEIGHT, PET_RENDER_WIDTH } from "./petModel";

const PET_MARGIN = 12;
const PET_POSITION_STORAGE_KEY = "dpcode:codex-pet-position";

export interface PetPosition {
  readonly x: number;
  readonly y: number;
}

export function readStoredPosition(): PetPosition | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PET_POSITION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PetPosition>;
    if (typeof parsed.x !== "number" || typeof parsed.y !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function storePosition(position: PetPosition): void {
  try {
    window.localStorage.setItem(PET_POSITION_STORAGE_KEY, JSON.stringify(position));
  } catch {
    // Best-effort persistence only; dragging should still work in private contexts.
  }
}

export function defaultPosition(): PetPosition {
  if (typeof window === "undefined") return { x: 24, y: 24 };
  return {
    x: window.innerWidth - PET_RENDER_WIDTH - 28,
    y: window.innerHeight - PET_RENDER_HEIGHT - 92,
  };
}

export function clampPosition(position: PetPosition): PetPosition {
  if (typeof window === "undefined") return position;
  const maxX = Math.max(PET_MARGIN, window.innerWidth - PET_RENDER_WIDTH - PET_MARGIN);
  const maxY = Math.max(PET_MARGIN, window.innerHeight - PET_RENDER_HEIGHT - PET_MARGIN);
  return {
    x: Math.min(maxX, Math.max(PET_MARGIN, position.x)),
    y: Math.min(maxY, Math.max(PET_MARGIN, position.y)),
  };
}

// FILE: petVisibility.ts
// Purpose: Persists whether the Codex pet overlay is shown or user-dismissed.
// Layer: Global pet overlay domain helpers
// Exports: localStorage-backed visibility helpers and an event name for UI sync

const PET_ENABLED_STORAGE_KEY = "dpcode:codex-pet-enabled";

export const PET_VISIBILITY_CHANGED_EVENT = "dpcode:codex-pet-visibility-changed";

export function readPetEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(PET_ENABLED_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function storePetEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(PET_ENABLED_STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // Best-effort preference persistence only; the in-memory state still updates.
  }
}

export function dispatchPetVisibilityChanged(enabled: boolean): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(PET_VISIBILITY_CHANGED_EVENT, { detail: { enabled } }));
}

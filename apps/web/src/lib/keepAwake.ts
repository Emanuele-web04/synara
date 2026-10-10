// FILE: keepAwake.ts
// Purpose: Keep-awake (caffeinate) copy for the Settings "System" section.
// Layer: Web lib (pure)
// Exports: KEEP_AWAKE_MODE_OPTIONS and status label helpers.

import type { KeepAwakeMode, ServerKeepAwakeState } from "@synara/contracts";

export interface KeepAwakeModeOption {
  readonly value: KeepAwakeMode;
  readonly label: string;
  readonly description: string;
}

export const KEEP_AWAKE_ROW_TITLE = "Keep computer awake";

export const KEEP_AWAKE_MODE_OPTIONS: readonly KeepAwakeModeOption[] = [
  { value: "always", label: "On", description: "Keep this computer awake at all times." },
  {
    value: "agent",
    label: "Agent",
    description: "Keep this computer awake while an agent is working.",
  },
  { value: "off", label: "Off", description: "Let the system sleep normally." },
];

export function keepAwakeModeLabel(mode: KeepAwakeMode): string {
  return KEEP_AWAKE_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? mode;
}

export function keepAwakeActivityLabel(active: boolean): "Active" | "Idle" {
  return active ? "Active" : "Idle";
}

export function keepAwakeStatusLabel(state: Pick<ServerKeepAwakeState, "mode" | "active">): string {
  return `${keepAwakeModeLabel(state.mode)} · ${keepAwakeActivityLabel(state.active)}`;
}

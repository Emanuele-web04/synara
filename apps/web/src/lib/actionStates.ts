// FILE: actionStates.ts
// Purpose: Map a WorkLogEntry to an action state (label + color + loader) for the
//          dynamic island and sidebar dotmatrix loaders.
// Layer: Web UI shared logic
// Depends on: workEntryClassification (category), dotmatrix loaders (visuals).

import type { ComponentType } from "react";

import { DotmSquare11 } from "~/components/ui/dotm-square-11";
import { DotmSquare12 } from "~/components/ui/dotm-square-12";
import { DotmSquare13 } from "~/components/ui/dotm-square-13";
import { DotmSquare17 } from "~/components/ui/dotm-square-17";
import type { DotMatrixCommonProps } from "~/lib/dotmatrix-core";
import type { WorkLogEntry } from "~/session-logic";
import {
  classifyWorkEntry,
  type WorkEntryCategory,
} from "~/lib/workEntryClassification";

export type ActionStateName =
  | "thinking"
  | "reading"
  | "editing"
  | "running-command"
  | "error";

// Compact island view merges thinking+reading into "processing" — at 16px the
// distinction between the two loaders is invisible. Expanded view shows the full 5.
export type CompactActionStateName =
  | "processing"
  | "editing"
  | "running-command"
  | "error";

export interface ActionState {
  state: ActionStateName;
  compactState: CompactActionStateName;
  color: string;
  loader: ComponentType<DotMatrixCommonProps>;
  label: string;
}

export type LoaderColorPreset = "synara" | "spectrum" | "mono";

// Exactly 3 preset themes. Locked — no per-color customization (too complex for v1).
// Synara: accent-based (uses the app accent color for all states, error in red).
// Spectrum: distinct hues per state (maximum distinguishability).
// Mono: grayscale + accent for error (subtle, for users who want minimal color).
const ACTION_COLOR_PRESETS: Record<
  LoaderColorPreset,
  Record<ActionStateName, string>
> = {
  synara: {
    thinking: "var(--accent)",
    reading: "var(--accent)",
    editing: "var(--accent)",
    "running-command": "var(--accent)",
    error: "var(--destructive)",
  },
  spectrum: {
    thinking: "#a855f7", // purple
    reading: "#3b82f6", // blue
    editing: "#f97316", // orange
    "running-command": "#10b981", // green
    error: "#ef4444", // red
  },
  mono: {
    thinking: "var(--muted-foreground)",
    reading: "var(--muted-foreground)",
    editing: "var(--muted-foreground)",
    "running-command": "var(--muted-foreground)",
    error: "var(--destructive)",
  },
};

const CATEGORY_TO_STATE: Record<
  WorkEntryCategory,
  { state: ActionStateName; compactState: CompactActionStateName }
> = {
  thinking: { state: "thinking", compactState: "processing" },
  reading: { state: "reading", compactState: "processing" },
  editing: { state: "editing", compactState: "editing" },
  "running-command": {
    state: "running-command",
    compactState: "running-command",
  },
  error: { state: "error", compactState: "error" },
};

const STATE_TO_LOADER: Record<ActionStateName, ComponentType<DotMatrixCommonProps>> = {
  thinking: DotmSquare11, // Echo Ring
  reading: DotmSquare12, // Origin Wave
  editing: DotmSquare17, // Half Helix
  "running-command": DotmSquare13, // Core Rotor
  error: DotmSquare11, // Echo Ring (error color)
};

// Strip control characters (RTL override, zero-width, etc.) and truncate.
// Full original text is available via the `title` attribute on hover in the UI.
function sanitizeLabel(value: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "");
  const trimmed = stripped.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}

export function actionColorFor(
  state: ActionStateName,
  preset: LoaderColorPreset,
): string {
  return ACTION_COLOR_PRESETS[preset][state];
}

export function mapWorkLogToActionState(
  workEntry: WorkLogEntry,
  preset: LoaderColorPreset = "synara",
): ActionState {
  const category = classifyWorkEntry(workEntry);
  const { state, compactState } = CATEGORY_TO_STATE[category];
  return {
    state,
    compactState,
    color: ACTION_COLOR_PRESETS[preset][state],
    loader: STATE_TO_LOADER[state],
    label: sanitizeLabel(workEntry.label),
  };
}

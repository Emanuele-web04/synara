// FILE: useProfileAvatarColor.ts
// Purpose: Locally-persisted accent color for the Profile avatar (the green circle behind the
// initials). Backs the avatar "edit" affordance in the Edit-profile dialog. Local-only, no I/O.
// Layer: web profile feature.

import { useCallback } from "react";
import { Schema } from "effect";
import { useLocalStorage } from "~/hooks/useLocalStorage";

const PROFILE_AVATAR_COLOR_STORAGE_KEY = "synara:profile:avatarColor:v1";

// A compact palette of solid avatar accents. The first entry is the default.
export const PROFILE_AVATAR_COLORS: readonly string[] = [
  "#22c55e", // emerald (default)
  "#3b82f6", // blue
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#f59e0b", // amber
  "#ef4444", // red
  "#14b8a6", // teal
  "#64748b", // slate
];

const DEFAULT_AVATAR_COLOR = PROFILE_AVATAR_COLORS[0]!;

// Empty string means "use the default".
const StoredColorSchema = Schema.String;

export function useProfileAvatarColor() {
  const [stored, setStored] = useLocalStorage(
    PROFILE_AVATAR_COLOR_STORAGE_KEY,
    "",
    StoredColorSchema,
  );

  const color = stored.trim().length > 0 ? stored.trim() : DEFAULT_AVATAR_COLOR;

  const setColor = useCallback(
    (next: string) => {
      setStored(next === DEFAULT_AVATAR_COLOR ? "" : next);
    },
    [setStored],
  );

  return { color, setColor } as const;
}

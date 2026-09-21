import { Schema } from "effect";
import { useLocalStorage } from "~/hooks/useLocalStorage";

const PROFILE_AVATAR_COLOR_STORAGE_KEY = "synara:profile:avatarColor:v1";

// A compact palette of solid avatar accents. The first entry is the default.
export const PROFILE_AVATAR_COLORS: readonly string[] = [
  "#22c55e",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#f59e0b",
  "#ef4444",
  "#14b8a6",
  "#64748b",
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

  const setColor = (next: string) => {
    setStored(next === DEFAULT_AVATAR_COLOR ? "" : next);
  };

  return { color, setColor } as const;
}

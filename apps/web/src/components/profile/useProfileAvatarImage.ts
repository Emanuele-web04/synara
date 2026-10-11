// FILE: useProfileAvatarImage.ts
// Purpose: Locally-persisted profile photo (a small, compressed data URL) for the avatar.
// When set it takes precedence over the accent color. Local-only, no I/O.
// Layer: web profile feature.

import { Schema } from "effect";
import { useLocalStorage } from "~/hooks/useLocalStorage";

const PROFILE_AVATAR_IMAGE_STORAGE_KEY = "synara:profile:avatarImage:v1";

// Empty string means "no photo".
const StoredImageSchema = Schema.String;

export function useProfileAvatarImage() {
  const [stored, setStored] = useLocalStorage(
    PROFILE_AVATAR_IMAGE_STORAGE_KEY,
    "",
    StoredImageSchema,
  );

  const image = stored.trim().length > 0 ? stored : null;

  const setImage = (next: string | null) => {
    setStored(next ?? "");
  };

  return { image, setImage } as const;
}

// FILE: useProfileName.ts
// Purpose: Editable, locally-persisted display name for the Profile. Falls back to the
// server-derived default (home-dir basename) until the user overrides it. Local-only.
// Layer: web profile feature.

import { useCallback } from "react";
import { Schema } from "effect";
import { useLocalStorage } from "~/hooks/useLocalStorage";

const PROFILE_NAME_STORAGE_KEY = "synara:profile:name:v1";

// Empty string means "use the server default".
const StoredNameSchema = Schema.String;

export function useProfileName(defaultName: string) {
  const [stored, setStored] = useLocalStorage(PROFILE_NAME_STORAGE_KEY, "", StoredNameSchema);

  const name = stored.trim().length > 0 ? stored.trim() : defaultName;

  const setName = useCallback(
    (next: string) => {
      const trimmed = next.trim();
      setStored(trimmed === defaultName ? "" : trimmed);
    },
    [defaultName, setStored],
  );

  return { name, setName } as const;
}

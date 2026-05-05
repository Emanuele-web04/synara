// FILE: useCodexPets.ts
// Purpose: Loads local Codex pet manifests from the renderer asset route.
// Layer: Global pet overlay data hook
// Exports: useCodexPets

import { useEffect, useState } from "react";

import type { CodexPetManifest } from "./petModel";

export function useCodexPets(): CodexPetManifest[] {
  const [pets, setPets] = useState<CodexPetManifest[]>([]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/codex-pets")
      .then((response) => (response.ok ? response.json() : Promise.reject(response)))
      .then((data: { pets?: CodexPetManifest[] }) => {
        if (!cancelled) {
          setPets(Array.isArray(data.pets) ? data.pets : []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPets([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return pets;
}

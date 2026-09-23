// FILE: useStarredModels.ts
// Purpose: React binding for the persisted starred model presets.
// Layer: Web hooks
// Depends on: useLocalStorage and the starred model storage helpers.

import { useState } from "react";

import {
  normalizeStarredModels,
  seedStarredModelsFromLegacyFavorites,
  STARRED_MODELS_STORAGE_KEY,
  type StarredModel,
  StarredModelsSchema,
  toggleStarredModel,
  unstarModel,
} from "~/lib/starredModels";
import { useLocalStorage } from "./useLocalStorage";

export function useStarredModels(): {
  starredModels: ReadonlyArray<StarredModel>;
  toggleStarredModel: (entry: StarredModel) => void;
  unstarModel: (entry: Pick<StarredModel, "provider" | "model">) => void;
} {
  // Until the first edit writes the new key, legacy per-provider favourites stand in.
  const [legacySeed] = useState(seedStarredModelsFromLegacyFavorites);
  const [stored, setStored] = useLocalStorage(
    STARRED_MODELS_STORAGE_KEY,
    legacySeed,
    StarredModelsSchema,
  );
  return {
    starredModels: normalizeStarredModels(stored),
    toggleStarredModel: (entry) => setStored((current) => toggleStarredModel(current, entry)),
    unstarModel: (entry) => setStored((current) => unstarModel(current, entry)),
  };
}

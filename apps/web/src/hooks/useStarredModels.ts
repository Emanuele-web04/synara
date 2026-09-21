import { useState } from "react";

import {
  normalizeStarredModels,
  seedStarredModelsFromLegacyFavorites,
  STARRED_MODELS_STORAGE_KEY,
  type StarredModel,
  StarredModelsSchema,
  toggleStarredModel,
} from "~/lib/starredModels";
import { useLocalStorage } from "./useLocalStorage";

export function useStarredModels(): {
  starredModels: ReadonlyArray<StarredModel>;
  toggleStarredModel: (entry: StarredModel) => void;
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
  };
}

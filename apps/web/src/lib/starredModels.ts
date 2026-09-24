// FILE: starredModels.ts
// Purpose: Storage schema + pure helpers for starred model presets (provider + model + traits).
// Layer: Web local-storage helpers used by the composer model picker and model cycle shortcuts.
// Depends on: legacy per-provider favorite slugs (modelFavorites) for the one-time seed.

import type { ProviderKind } from "@synara/contracts";
import { Schema } from "effect";

import { isProviderKind } from "../providerOrdering";
import { FAVORITE_MODEL_STORAGE_KEYS, readFavoriteModelSlugs } from "./modelFavorites";

export const STARRED_MODELS_STORAGE_KEY = "synara:starred-models:v1";

// A starred preset pins the traits the user composed once so one click restores them.
// `null` traits mean "leave whatever the provider currently uses" (legacy favorites,
// models without that control).
export const StarredModelSchema = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
  effort: Schema.NullOr(Schema.String),
  fastMode: Schema.NullOr(Schema.Boolean),
  thinking: Schema.NullOr(Schema.Boolean),
});
export const StarredModelsSchema = Schema.Array(StarredModelSchema);

export interface StarredModel {
  readonly provider: ProviderKind;
  readonly model: string;
  readonly effort: string | null;
  readonly fastMode: boolean | null;
  readonly thinking: boolean | null;
}

export type StoredStarredModel = typeof StarredModelSchema.Type;

export function starredModelKey(
  entry: Pick<StoredStarredModel, "provider" | "model" | "effort" | "fastMode" | "thinking">,
): string {
  // JSON keeps the key unambiguous: model slugs may contain any separator character.
  return JSON.stringify([
    entry.provider,
    entry.model,
    entry.effort ?? "",
    entry.fastMode === null ? "" : String(entry.fastMode),
    entry.thinking === null ? "" : String(entry.thinking),
  ]);
}

// Provider + model only. A provider tab row shares its traits with every model of that
// provider, so it counts as starred when any preset of the model exists.
export function starredModelSlotKey(entry: Pick<StoredStarredModel, "provider" | "model">): string {
  return JSON.stringify([entry.provider, entry.model]);
}

// Drops entries for providers this build no longer knows and de-duplicates by key,
// preserving the user's order.
export function normalizeStarredModels(
  stored: ReadonlyArray<StoredStarredModel>,
): ReadonlyArray<StarredModel> {
  const seen = new Set<string>();
  const result: StarredModel[] = [];
  for (const entry of stored) {
    if (!isProviderKind(entry.provider) || entry.model.trim().length === 0) continue;
    const key = starredModelKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...entry, provider: entry.provider });
  }
  return result;
}

export function toggleStarredModel(
  current: ReadonlyArray<StoredStarredModel>,
  entry: StarredModel,
): StoredStarredModel[] {
  const key = starredModelKey(entry);
  const normalized = normalizeStarredModels(current);
  return normalized.some((candidate) => starredModelKey(candidate) === key)
    ? normalized.filter((candidate) => starredModelKey(candidate) !== key)
    : [...normalized, entry];
}

// Removes every preset of a model, whatever traits each one pins.
export function unstarModel(
  current: ReadonlyArray<StoredStarredModel>,
  entry: Pick<StoredStarredModel, "provider" | "model">,
): StoredStarredModel[] {
  const slot = starredModelSlotKey(entry);
  return normalizeStarredModels(current).filter(
    (candidate) => starredModelSlotKey(candidate) !== slot,
  );
}

// Legacy per-provider favorites become trait-less presets until the user first edits stars.
export function seedStarredModelsFromLegacyFavorites(): StoredStarredModel[] {
  const providers = Object.keys(FAVORITE_MODEL_STORAGE_KEYS) as Array<
    keyof typeof FAVORITE_MODEL_STORAGE_KEYS
  >;
  return providers.flatMap((provider) =>
    readFavoriteModelSlugs(provider).map((model) => ({
      provider,
      model,
      effort: null,
      fastMode: null,
      thinking: null,
    })),
  );
}

function readStoredStarredModels(): ReadonlyArray<StarredModel> {
  try {
    const raw = globalThis.localStorage?.getItem(STARRED_MODELS_STORAGE_KEY);
    if (!raw) return normalizeStarredModels(seedStarredModelsFromLegacyFavorites());
    return normalizeStarredModels(
      Schema.decodeUnknownSync(StarredModelsSchema)(JSON.parse(raw) as unknown),
    );
  } catch {
    return [];
  }
}

// Model slugs the cycle shortcut should prefer: starred presets plus legacy favorites.
export function readStarredModelSlugs(provider: ProviderKind): string[] {
  const starred = readStoredStarredModels()
    .filter((entry) => entry.provider === provider)
    .map((entry) => entry.model);
  return Array.from(new Set([...starred, ...readFavoriteModelSlugs(provider)]));
}

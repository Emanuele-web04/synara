import { ProviderKind } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FAVORITE_MODEL_STORAGE_KEYS, readFavoriteModelSlugs } from "./modelFavorites";

describe("model favourites", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(ProviderKind.literals)(
    "reads favourites for %s using its own storage key",
    (provider) => {
      const getItem = vi.fn((key: string) =>
        key === FAVORITE_MODEL_STORAGE_KEYS[provider]
          ? JSON.stringify(["selected-model", "selected-model", "", "   "])
          : null,
      );
      vi.stubGlobal("localStorage", { getItem });
      expect(readFavoriteModelSlugs(provider)).toEqual(["selected-model"]);
      expect(getItem).toHaveBeenCalledExactlyOnceWith(FAVORITE_MODEL_STORAGE_KEYS[provider]);
    },
  );

  it("keeps the same slug independent across providers", () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) =>
        key === FAVORITE_MODEL_STORAGE_KEYS.cline ? JSON.stringify(["default"]) : null,
    });
    expect(readFavoriteModelSlugs("cline")).toEqual(["default"]);
    expect(readFavoriteModelSlugs("codex")).toEqual([]);
  });

  it.each(["not json", "{}", '["valid", 12]'])("ignores invalid preferences: %s", (raw) => {
    vi.stubGlobal("localStorage", { getItem: () => raw });
    expect(readFavoriteModelSlugs("cline")).toEqual([]);
  });

  it("works when browser storage is unavailable", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(readFavoriteModelSlugs("cline")).toEqual([]);
  });
});

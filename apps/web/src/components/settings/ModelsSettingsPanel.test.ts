import { getModelOptions } from "@synara/shared/model";
import { describe, expect, it } from "vitest";

import { MAX_CUSTOM_MODEL_LENGTH } from "~/appSettings";

import { validateCustomModelInput } from "./ModelsSettingsPanel";

describe("validateCustomModelInput", () => {
  it("returns the same validation messages as the custom-model editor", () => {
    expect(validateCustomModelInput({ provider: "codex", value: "   ", savedModels: [] })).toEqual({
      error: "settings:modelSlugRequired",
    });

    const builtIn = getModelOptions("codex")[0]!.slug;
    expect(
      validateCustomModelInput({ provider: "codex", value: builtIn, savedModels: [] }),
    ).toEqual({ error: "settings:modelAlreadyBuiltIn" });

    expect(
      validateCustomModelInput({
        provider: "codex",
        value: "x".repeat(MAX_CUSTOM_MODEL_LENGTH + 1),
        savedModels: [],
      }),
    ).toEqual({
      error: "settings:modelSlugTooLong",
    });

    expect(
      validateCustomModelInput({
        provider: "codex",
        value: " custom/model ",
        savedModels: ["custom/model"],
      }),
    ).toEqual({ error: "settings:customModelAlreadySaved" });
  });

  it("returns the normalized model when it can be saved", () => {
    expect(
      validateCustomModelInput({
        provider: "codex",
        value: " custom/model ",
        savedModels: [],
      }),
    ).toEqual({ model: "custom/model" });
  });
});

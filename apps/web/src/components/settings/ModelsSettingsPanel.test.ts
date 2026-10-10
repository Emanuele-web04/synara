import { getModelOptions } from "@synara/shared/model";
import { describe, expect, it } from "vitest";

import { MAX_CUSTOM_MODEL_LENGTH } from "~/appSettings";

import { validateCustomModelInput } from "./ModelsSettingsPanel";

describe("validateCustomModelInput", () => {
  it("returns the same validation messages as the custom-model editor", () => {
    expect(validateCustomModelInput({ provider: "codex", value: "   ", savedModels: [] })).toEqual({
      error: "Enter a model slug.",
    });

    const builtIn = getModelOptions("codex")[0]!.slug;
    expect(
      validateCustomModelInput({ provider: "codex", value: builtIn, savedModels: [] }),
    ).toEqual({ error: "That model is already built in." });

    expect(
      validateCustomModelInput({
        provider: "codex",
        value: "x".repeat(MAX_CUSTOM_MODEL_LENGTH + 1),
        savedModels: [],
      }),
    ).toEqual({
      error: `Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`,
    });

    expect(
      validateCustomModelInput({
        provider: "codex",
        value: " custom/model ",
        savedModels: ["custom/model"],
      }),
    ).toEqual({ error: "That custom model is already saved." });
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

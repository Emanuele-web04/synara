import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_SERVER_SETTINGS, ModelSelection } from "@synara/contracts";
import { PROVIDER_DESCRIPTORS } from "@synara/shared/providerMetadata";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  AppSettingsSchema,
  appSettingsPatchToServerSettingsPatch,
  getAppModelOptions,
  getProviderStartOptions,
  getCustomModelsByProvider,
} from "./appSettings";
import { normalizeModelSelection } from "./composerDraftModels";
import {
  buildModelSelection,
  buildNextProviderOptions,
  mergeDynamicModelOptions,
} from "./providerModelOptions";
import { ProviderIcon } from "./components/ProviderIcon";

const selected = { provider: "cline", model: "Vendor/MixedCase-Model" } as const;

describe("Cline frontend provider", () => {
  it("preserves Cline and exact model IDs through schema and draft reloads", () => {
    expect(Schema.decodeUnknownSync(ModelSelection)(selected)).toEqual(selected);
    expect(normalizeModelSelection(JSON.parse(JSON.stringify(selected)))).toEqual(selected);
    expect(buildModelSelection("cline", selected.model)).toEqual(selected);
  });
  it("exposes Cline settings and passes custom binary paths to the server", () => {
    const settings = AppSettingsSchema.makeUnsafe({
      clineBinaryPath: "/custom/cline",
      customClineModels: [selected.model],
    });
    expect(getProviderStartOptions(settings)?.cline).toEqual({ binaryPath: "/custom/cline" });
    expect(getCustomModelsByProvider(settings).cline).toEqual([selected.model]);
    expect(
      appSettingsPatchToServerSettingsPatch({
        clineBinaryPath: "/custom/cline",
        customClineModels: [selected.model],
      }),
    ).toMatchObject({
      providers: { cline: { binaryPath: "/custom/cline", customModels: [selected.model] } },
    });
    expect(DEFAULT_SERVER_SETTINGS.providers.cline.binaryPath).toBe("cline");
  });
  it("shows discovered names while retaining custom models and the configured default", () => {
    const choices = mergeDynamicModelOptions({
      provider: "cline",
      staticOptions: getAppModelOptions("cline", ["local/Custom"]),
      dynamicModels: [{ slug: selected.model, name: "My configured model" }],
    });
    expect(choices).toContainEqual(
      expect.objectContaining({ slug: selected.model, name: "My configured model" }),
    );
    expect(choices.some((choice) => choice.slug === "default")).toBe(true);
    expect(choices.some((choice) => choice.slug === "local/Custom")).toBe(true);
    expect(buildNextProviderOptions("cline", undefined, { reasoningEffort: "high" })).toEqual({});
  });
  it("uses the official theme-aware Cline glyph with accessible props", () => {
    const markup = renderToStaticMarkup(
      createElement(ProviderIcon, {
        provider: "cline",
        "aria-hidden": false,
        "aria-label": "Cline",
        className: "size-4",
      }),
    );
    expect(markup).toContain('viewBox="0 0 47 50"');
    expect(markup).toContain('fill="currentColor"');
    expect(markup).toContain('aria-label="Cline"');
    expect(markup).not.toContain("http://localhost");
  });
  it("does not advertise an unsupported usage API", () => {
    expect(PROVIDER_DESCRIPTORS.find((provider) => provider.kind === "cline")?.usage).toBeNull();
  });
});

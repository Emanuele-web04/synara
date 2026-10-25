import "../index.css";

import { DEFAULT_SERVER_SETTINGS, type NativeApi, ThreadId } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { ProviderModelPicker } from "../components/chat/ProviderModelPicker";
import { ComposerModelPicker } from "../components/chat/ComposerModelPicker";
import * as nativeApi from "../nativeApi";
import { useProviderModelCatalog } from "./useProviderModelCatalog";

vi.mock("../nativeApi", { spy: true });

vi.mock("../appSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../appSettings")>();
  const settings = actual.AppSettingsSchema.makeUnsafe({});
  return {
    ...actual,
    useAppSettings: () => ({ settings, serverSettings: DEFAULT_SERVER_SETTINGS }),
  };
});

afterEach(() => vi.restoreAllMocks());

it.each(["standalone", "composer"] as const)(
  "the real %s OMP picker requires a catalog model selection, never a legacy role fallback",
  async (picker) => {
    const listModels = vi.fn().mockResolvedValue({
      models: [{ slug: "upstream/catalog-model", name: "Catalog model" }],
      roles: [{ name: "smol", model: "upstream/catalog-model", thinkingLevel: "high" }],
      source: "omp-cli",
      cached: false,
    });
    vi.mocked(nativeApi.ensureNativeApi).mockReturnValue({
      provider: { listModels },
    } as unknown as NativeApi);
    const onProviderModelChange = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    function Picker() {
      const catalog = useProviderModelCatalog({
        selectedProvider: "omp",
        discoveryEnabled: false,
        cwd: "/project",
        modelHintByProvider: { omp: "role:smol" },
      });
      return picker === "composer" ? (
        <ComposerModelPicker
          provider="omp"
          model="role:smol"
          lockedProvider="omp"
          threadId={ThreadId.makeUnsafe("omp-legacy-role-picker")}
          modelOptionsByProvider={catalog.modelOptionsByProvider}
          modelOptionsByProviderInstance={catalog.modelOptionsByProviderInstance}
          loadingModelProviders={catalog.loadingModelProviders}
          onProviderModelChange={onProviderModelChange}
          modelOptions={undefined}
          prompt=""
          onPromptChange={() => undefined}
        />
      ) : (
        <ProviderModelPicker
          provider="omp"
          model="role:smol"
          lockedProvider="omp"
          modelOptionsByProvider={catalog.modelOptionsByProvider}
          modelOptionsByProviderInstance={catalog.modelOptionsByProviderInstance}
          loadingModelProviders={catalog.loadingModelProviders}
          onProviderModelChange={onProviderModelChange}
        />
      );
    }

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <Picker />
      </QueryClientProvider>,
    );
    try {
      await page
        .getByRole("button", {
          name: picker === "composer" ? "Change model and reasoning" : /Select OMP model/,
        })
        .click();
      const row = page.getByRole(picker === "composer" ? "menuitem" : "menuitemradio", {
        name: /Catalog model/,
      });
      await expect.element(row).toBeVisible();
      await expect
        .element(page.getByRole("status"))
        .toHaveTextContent(
          "This saved OMP role is no longer supported. Choose an OMP model before sending.",
        );
      expect(onProviderModelChange).not.toHaveBeenCalled();
      await expect
        .element(page.getByRole("menuitemradio", { name: /smol|role:/i }))
        .not.toBeInTheDocument();
      await expect.element(page.getByText("Roles", { exact: true })).not.toBeInTheDocument();
      await row.click();
      expect(onProviderModelChange).toHaveBeenCalledExactlyOnceWith(
        "omp",
        "upstream/catalog-model",
        picker === "composer" ? { instanceId: "omp" } : "omp",
      );
      expect(listModels).toHaveBeenCalledExactlyOnceWith({ provider: "omp", instanceId: "omp" });
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  },
);

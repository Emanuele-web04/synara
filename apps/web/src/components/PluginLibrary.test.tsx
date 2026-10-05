import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";

import { DEFAULT_PROVIDER_ORDER } from "~/providerOrdering";
import { PluginLibrary } from "./PluginLibrary";

const settings = vi.hoisted(() => ({ disabledProviders: [] as string[] }));
vi.mock("~/appSettings", () => ({ useAppSettings: () => ({ settings }) }));
vi.mock("~/store", () => ({ useStore: () => null }));
vi.mock("~/focusedChatContext", () => ({
  useFocusedChatContext: () => ({ activeProject: null, activeThread: null, focusedThreadId: null }),
}));
vi.mock("~/hooks/useDesktopTopBarGutter", () => ({
  useDesktopTopBarTrafficLightGutterClassName: () => "",
  useDesktopTopBarWindowControlsGutterClassName: () => "",
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: undefined, isLoading: false }),
}));

afterEach(() => {
  settings.disabledProviders = [];
});

it("does not fall back to a disabled provider when no enabled provider supports discovery", () => {
  settings.disabledProviders = ["codex"];
  const markup = renderToStaticMarkup(<PluginLibrary embedded />);
  expect(markup).not.toContain("Codex");
  expect(markup).toContain("Plugins unavailable for Claude");
});

it("offers a recovery hint when every provider is disabled", () => {
  settings.disabledProviders = [...DEFAULT_PROVIDER_ORDER];
  const markup = renderToStaticMarkup(<PluginLibrary embedded />);
  expect(markup).not.toContain("Codex");
  expect(markup).toContain("Enable a provider in Settings");
});

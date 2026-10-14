import "~/index.css";

import { MODEL_OPTIONS_BY_PROVIDER, type ModelSelection } from "@synara/contracts";
import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { AppSettingsSchema } from "~/appSettings";
import { GroupModelRow } from "./GroupModelEffortRow";

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: { cwd: "/tmp/group" } }),
}));
vi.mock("~/appSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/appSettings")>()),
  useAppSettings: () => ({
    settings: AppSettingsSchema.makeUnsafe({
      providerInstances: {
        claude_work: { driver: "claudeAgent", displayName: "Work", enabled: true },
      },
    }),
  }),
}));
vi.mock("~/hooks/useProviderStatusesForLocalConfig", () => ({
  useProviderStatusesForLocalConfig: () =>
    ["claudeAgent", "claude_work"].map((instanceId) => ({
      provider: "claudeAgent",
      driver: "claudeAgent",
      instanceId,
      status: "ready",
      available: true,
      authStatus: "authenticated",
      checkedAt: "2026-10-01T00:00:00.000Z",
    })),
}));
vi.mock("~/hooks/useProviderModelCatalog", () => ({
  useProviderModelCatalog: () => ({
    modelOptionsByProvider: MODEL_OPTIONS_BY_PROVIDER,
    modelOptionsByProviderInstance: {
      claudeAgent: [{ slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }],
      claude_work: [{ slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }],
    },
    loadingModelProviders: {},
    discoveryErrorsByProvider: {},
    runtimeModelsByProvider: {
      claudeAgent: [
        { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", supportsAutoMode: true },
      ],
    },
    runtimeModelsByProviderInstance: {
      claudeAgent: [
        { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", supportsAutoMode: true },
      ],
      claude_work: [
        { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", supportsAutoMode: false },
      ],
    },
  }),
}));

it("commits a Hub account's own runtime capabilities when switching accounts", async () => {
  const onChange = vi.fn();
  const screen = await render(
    <GroupModelRow
      title="Coordinator model"
      description="Account and model used by the coordinator."
      selection={{ provider: "claudeAgent", model: "claude-sonnet-4-6", instanceId: "claudeAgent" }}
      defaultSelection={null}
      projectCwd="/tmp/group"
      onChange={onChange}
    />,
  );
  try {
    await page.getByRole("button").click();
    await page.getByRole("menuitem", { name: "Claude · Work", exact: true }).hover();
    await page.getByRole("menuitemradio", { name: "Claude Sonnet 4.6", exact: true }).click();
    const selected = onChange.mock.lastCall?.[0] as ModelSelection;
    expect(selected).toEqual({
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
      instanceId: "claude_work",
      supportsAutoMode: false,
    });
  } finally {
    await screen.unmount();
  }
});

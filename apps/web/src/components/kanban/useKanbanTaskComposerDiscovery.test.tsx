import { MODEL_OPTIONS_BY_PROVIDER, ThreadId, type ProviderKind } from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import { AppSettingsSchema, getProviderInstanceOptions } from "~/appSettings";
import { useKanbanTaskComposerDiscovery } from "./useKanbanTaskComposerDiscovery";

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: undefined, isLoading: false, isFetching: false }),
}));

function renderModelChoices(disabledProviders: ProviderKind[]) {
  const settings = AppSettingsSchema.makeUnsafe({ disabledProviders });
  function Choices() {
    const { composerMenuItems } = useKanbanTaskComposerDiscovery({
      composerTrigger: { kind: "slash-model", query: "", rangeStart: 0, rangeEnd: 1 },
      selectedProvider: "codex",
      selectedProviderInstanceId: "codex",
      modelOptionsByProvider: MODEL_OPTIONS_BY_PROVIDER,
      modelOptionsByProviderInstance: {
        codex: [{ slug: "saved-codex-model", name: "Saved Codex model" }],
        claudeAgent: [{ slug: "saved-claude-model", name: "Saved Claude model" }],
      },
      providerInstances: getProviderInstanceOptions(settings),
      selectedRuntimeAgents: [],
      selectedProjectCwd: null,
      serverCwd: null,
      serverHomeDir: null,
      scratchThreadId: ThreadId.makeUnsafe("kanban-provider-visibility"),
      providerOptionsForDispatch: undefined,
      hiddenProviders: [],
      providerOrder: settings.providerOrder,
      piAgentDir: null,
      ompAgentDir: null,
    });
    return (
      <ul>
        {composerMenuItems.map((item) => (
          <li key={item.id}>{item.label}</li>
        ))}
      </ul>
    );
  }
  return renderToStaticMarkup(<Choices />);
}

it("hides cached models of a disabled provider in Kanban autocomplete, including the selected provider", () => {
  const disabled = renderModelChoices(["codex"]);
  expect(disabled.includes("Saved Codex model")).toBe(false);
  expect(disabled.includes("Saved Claude model")).toBe(true);
  expect(renderModelChoices([]).includes("Saved Codex model")).toBe(true);
});

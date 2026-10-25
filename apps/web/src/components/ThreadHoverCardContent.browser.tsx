import "../index.css";

import { ThreadId, type ProviderModelDescriptor } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { providerModelsQueryOptions } from "~/lib/providerDiscoveryReactQuery";
import { ThreadHoverCardContent } from "./ThreadHoverCardContent";

const runtimeModel: ProviderModelDescriptor = {
  slug: "gpt-6.1-sol",
  name: "GPT-6.1 Sol",
  supportedReasoningEfforts: [
    { value: "medium", label: "Medium" },
    { value: "xhigh", label: "Extra High" },
  ],
  defaultReasoningEffort: "medium",
  supportsFastMode: true,
};

it("updates hover effort and Fast from the selected account's cached catalog", async () => {
  const client = new QueryClient();
  const catalog = providerModelsQueryOptions({ provider: "codex", instanceId: "codex_work" });
  client.setQueryData(
    providerModelsQueryOptions({ provider: "codex", instanceId: "codex_personal" }).queryKey,
    { models: [runtimeModel], source: "codex", cached: true },
  );
  const renderCard = (instanceId: string) => (
    <QueryClientProvider client={client}>
      <div className="w-64">
        <ThreadHoverCardContent
          threadId={ThreadId.makeUnsafe("hover-model")}
          title="Review hover metadata"
          timeLabel="now"
          projectName={null}
          projectCwd={null}
          projectAppearance={null}
          sourceProjectName={null}
          branch={null}
          worktreeName={null}
          pullRequest={null}
          onOpenPullRequest={() => {}}
          status={null}
          model={{
            provider: "codex",
            instanceId,
            model: "gpt-6.1-sol",
            options: { reasoningEffort: "xhigh", fastMode: true },
          }}
          modelCatalogQueryOptions={providerModelsQueryOptions({ provider: "codex", instanceId })}
        />
      </div>
    </QueryClientProvider>
  );
  const screen = await render(renderCard("codex_work"));
  try {
    await expect.element(screen.getByText("Extra High")).not.toBeInTheDocument();
    await expect.element(screen.getByLabelText("Fast mode")).not.toBeInTheDocument();
    client.setQueryData(catalog.queryKey, {
      models: [runtimeModel],
      source: "codex",
      cached: true,
    });
    await expect.element(screen.getByText("Extra High")).toBeVisible();
    await expect.element(screen.getByLabelText("Fast mode")).toBeVisible();
    await screen.rerender(renderCard("codex_other"));
    await expect
      .element(screen.getByText("Extra High"), { timeout: 1_000 })
      .not.toBeInTheDocument();
    await expect.element(screen.getByLabelText("Fast mode")).not.toBeInTheDocument();
    expect(client.isFetching()).toBe(0);
  } finally {
    await screen.unmount();
    client.clear();
  }
});

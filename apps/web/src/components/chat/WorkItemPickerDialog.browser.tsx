import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { WorkItemAttachment } from "@synara/contracts";

const harness = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock("~/nativeApi", () => ({
  onNativeApiServerCapabilitiesChange: () => () => undefined,
  readNativeApiServerCapability: () => true,
  ensureNativeApi: () => ({ workItems: { search: harness.search } }),
}));
import { WorkItemPickerDialog } from "./WorkItemPickerDialog";

it("keeps partial search results selectable while displaying the warning and retry", async () => {
  const item: WorkItemAttachment = {
    kind: "issue",
    number: 7,
    title: "Preserve the draft",
    state: "open",
    url: "https://github.com/owner/repo/issues/7",
    bodyExcerpt: "Repro steps",
    createdAt: "2026-10-10T00:00:00Z",
    updatedAt: "2026-10-10T00:00:00Z",
  };
  harness.search.mockResolvedValue({
    available: true,
    items: [item],
    errorHint: "Some GitHub results may be missing because a search request failed.",
  });
  const onSelect = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={client}>
      <WorkItemPickerDialog
        open
        onOpenChange={() => undefined}
        cwd="/repo"
        selectedItems={[]}
        onSelect={onSelect}
        onRemove={() => undefined}
      />
    </QueryClientProvider>,
  );
  try {
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Some GitHub results may be missing");
    await page.getByRole("button", { name: "Issue #7 Preserve the draft" }).click();
    expect(onSelect).toHaveBeenCalledWith(item);
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await vi.waitFor(() => expect(harness.search).toHaveBeenCalledTimes(2));
  } finally {
    await screen.unmount();
    client.clear();
  }
});

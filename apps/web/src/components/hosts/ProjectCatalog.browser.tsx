import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { afterEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn() }));
vi.mock("~/lib/hosts/executionContext", async (original) => ({
  ...(await original<typeof import("~/lib/hosts/executionContext")>()),
  readExecutionContext: () => ({
    controller: { environmentId: "catalog-controller", channel: "beta" },
    execution: { environmentId: "mini", label: "Mac mini" },
    remote: {
      accountAuthority: "https://account.test",
      userId: "owner",
      organizationId: "personal",
      channel: "beta",
    },
  }),
}));
vi.mock("~/store", () => ({
  useStore: (select: (value: unknown) => unknown) =>
    select({ projects: [], threadsHydrated: false }),
}));
vi.mock("~/lib/accountReactQuery", () => ({
  accountStatusQueryOptions: () => ({
    queryKey: ["catalog-fixture-account"],
    queryFn: () => ({ state: "signed-out" }),
  }),
}));
vi.mock("~/lib/projectCatalog/navigation", () => ({ openCatalogCheckout: fixture.open }));
import { emptyCatalog, type CatalogCheckout } from "~/lib/projectCatalog/model";
import { projectCatalogKey, saveProjectCatalog } from "~/lib/projectCatalog/storage";
import { emitWsTransportState } from "~/wsTransportEvents";
import { ProjectCatalogDialog } from "./ProjectCatalogDialog";

const first: CatalogCheckout = {
  environmentId: "mini",
  projectId: "same-id",
  name: "Synara",
  cwd: "/code/synara",
  hostName: "Mac mini",
  channel: "beta",
  observedAt: "2026-09-27T21:00:00Z",
  repositoryUrls: [],
};
const second: CatalogCheckout = {
  ...first,
  environmentId: "catalog-controller",
  cwd: "/Users/me/Developer/synara",
  hostName: "MacBook",
};
afterEach(() => {
  localStorage.removeItem(projectCatalogKey()!);
  document.documentElement.classList.remove("dark");
  fixture.open.mockClear();
});
it.each(["light", "dark"])(
  "requires a checkout choice and preserves both host identities when linking (%s)",
  async (theme) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    await page.viewport(1000, 1000);
    saveProjectCatalog(projectCatalogKey()!, { ...emptyCatalog(), checkouts: [first, second] });
    emitWsTransportState("open");
    await render(
      <QueryClientProvider client={new QueryClient()}>
        <ProjectCatalogDialog onClose={fixture.close} />
      </QueryClientProvider>,
    );
    await page.getByRole("checkbox", { name: "Select Synara on Mac mini" }).click();
    await page.getByRole("checkbox", { name: "Select Synara on MacBook" }).click();
    await page.getByRole("textbox", { name: "New group name" }).fill("Synara across my computers");
    await page.getByRole("button", { name: "Link selected" }).click();
    await expect
      .element(page.getByRole("textbox", { name: "Group name", exact: true }))
      .toHaveValue("Synara across my computers");
    expect(fixture.open).not.toHaveBeenCalled();
    await page.screenshot({ path: `./__screenshots__/project-catalog-${theme}.png` });
    await page.getByRole("button", { name: "Switch and open", exact: true }).click();
    expect(fixture.open).toHaveBeenCalledWith(second);
  },
);
it("shows an offline catalog without allowing an execution or metadata change", async () => {
  saveProjectCatalog(projectCatalogKey()!, { ...emptyCatalog(), checkouts: [first, second] });
  emitWsTransportState("closed");
  await render(
    <QueryClientProvider client={new QueryClient()}>
      <ProjectCatalogDialog onClose={fixture.close} />
    </QueryClientProvider>,
  );
  await expect.element(page.getByRole("status")).toHaveTextContent("Offline catalog");
  await expect.element(page.getByRole("button", { name: "Switch and open" })).toBeDisabled();
  await expect
    .element(page.getByRole("checkbox", { name: "Select Synara on Mac mini" }))
    .toBeDisabled();
  expect(fixture.open).not.toHaveBeenCalled();
});

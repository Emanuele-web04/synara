import "../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useOnboardingDialogStore } from "../onboarding/onboardingDialogStore";
import { ProjectImportAnnouncementDialog } from "../projectImport/ProjectImportAnnouncementDialog";
import { useProjectImportDialogStore } from "../projectImport/projectImportDialogStore";

vi.mock("../lib/serverReactQuery", () => ({
  serverConfigQueryOptions: () => ({
    queryKey: ["server", "config"],
    queryFn: async () => ({ worktreesDir: "/first/worktrees" }),
    staleTime: Infinity,
  }),
}));
const clients: QueryClient[] = [];
const storageKey = "synara:project-import-announcement:v1";

beforeEach(() => {
  localStorage.removeItem(storageKey);
  useOnboardingDialogStore.setState({
    isOpen: false,
    openReason: null,
    engaged: false,
    startupGateSettled: true,
  });
  useProjectImportDialogStore.setState({ isOpen: false, initialProviders: null });
});
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  localStorage.removeItem(storageKey);
});
async function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <ProjectImportAnnouncementDialog />
    </QueryClientProvider>,
  );
}

it("opens the project import dialog from the call to action and does not announce again", async () => {
  await renderDialog();
  await page.getByRole("button", { name: "Import projects" }).click();
  expect(useProjectImportDialogStore.getState().isOpen).toBe(true);
  expect(JSON.parse(localStorage.getItem(storageKey) ?? "[]")).toContain("/first/worktrees");
  await expect.element(page.getByRole("button", { name: "Not now" })).not.toBeInTheDocument();
});

it("stays dismissed after Not now without opening the import dialog", async () => {
  const first = await renderDialog();
  await page.getByRole("button", { name: "Not now" }).click();
  await expect.element(page.getByRole("button", { name: "Not now" })).not.toBeInTheDocument();
  expect(useProjectImportDialogStore.getState().isOpen).toBe(false);
  await first.unmount();

  await renderDialog();
  await expect
    .element(page.getByRole("heading", { name: "Import projects" }))
    .not.toBeInTheDocument();
});

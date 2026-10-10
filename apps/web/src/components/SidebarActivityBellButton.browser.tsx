import "../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { TASKS_COACHMARK } from "./OneTimeCoachmark";
import { AppRail, railItemGlyphs } from "./AppRail";
import { SidebarPrimaryAction } from "./SidebarPrimaryAction";
import { TasksIcon } from "~/lib/icons";
import { useFeatureTourStore } from "../featureTour/store";
import { useOnboardingDialogStore } from "../onboarding/onboardingDialogStore";
import { ProjectImportAnnouncementDialog } from "../projectImport/ProjectImportAnnouncementDialog";
import { useProjectImportDialogStore } from "../projectImport/projectImportDialogStore";
import { createBrowserTestServerConfig } from "../test/browserHarness";
import { useAnnouncementSheetSlotStore } from "./announcementSheetSlot";
import { FeatureTourDialog } from "./FeatureTourDialog";
import { SidebarActivityBellButton } from "./Sidebar";
import { SidebarProvider } from "./ui/sidebar";
import { TooltipProvider } from "./ui/tooltip";

vi.mock("../lib/serverReactQuery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/serverReactQuery")>()),
  serverConfigQueryOptions: () => ({
    queryKey: ["server", "config"],
    queryFn: async () => createBrowserTestServerConfig("2026-10-06T00:00:00Z"),
    staleTime: Infinity,
  }),
}));

const activityKey = "synara:activity-onboarding:v1";
const importKey = "synara:project-import-announcement:v1";
const tourKey = "synara:feature-tour:since-0.9.2:v1";
const coachmark = "See running tasks, completed work, and anything that needs your attention.";
const clients: QueryClient[] = [];
const screens: Awaited<ReturnType<typeof render>>[] = [];

beforeEach(() => {
  for (const key of [activityKey, importKey, tourKey, "synara:tasks-onboarding:v1"])
    localStorage.removeItem(key);
  useOnboardingDialogStore.setState({
    isOpen: false,
    startupGateSettled: true,
    betaWelcomePending: false,
  });
  useAnnouncementSheetSlotStore.setState({ owner: null, handedOff: false, startupSettled: false });
  useFeatureTourStore.setState({ replay: false });
  useProjectImportDialogStore.setState({ isOpen: false });
});
afterEach(async () => {
  for (const screen of screens.splice(0)) await screen.unmount();
  for (const client of clients.splice(0)) client.clear();
  for (const key of [activityKey, importKey, tourKey, "synara:tasks-onboarding:v1"])
    localStorage.removeItem(key);
});

async function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const screen = await render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        {/* Mount the hint first so React effect order cannot stand in for arbitration. */}
        <SidebarActivityBellButton
          active={false}
          showUnreadDot={false}
          shortcutLabel={null}
          onClick={() => {}}
        />
        <ProjectImportAnnouncementDialog />
        <FeatureTourDialog />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  screens.push(screen);
  return screen;
}

it("waits for import and the feature tour before showing and remembering the Activity coachmark", async () => {
  const screen = await show();
  await expect.element(page.getByRole("dialog", { name: "Import projects" })).toBeVisible();
  expect(page.getByText(coachmark).all()).toHaveLength(0);
  expect(localStorage.getItem(activityKey)).toBeNull();
  await page.getByRole("button", { name: "Not now" }).click();
  await expect
    .element(page.getByRole("dialog", { name: "A new home for your work" }))
    .toBeVisible();
  expect(page.getByText(coachmark).all()).toHaveLength(0);
  expect(localStorage.getItem(activityKey)).toBeNull();
  await page.getByRole("button", { name: "Skip tour" }).click();
  await expect.element(page.getByText(coachmark)).toBeVisible();
  expect(localStorage.getItem(activityKey)).toBe("seen");
  await page.getByRole("button", { name: "Switch to activity view" }).click();
  await expect.element(page.getByText(coachmark)).not.toBeInTheDocument();
  await screen.unmount();
  screens.splice(screens.indexOf(screen), 1);
  await show();
  await expect.element(page.getByText(coachmark)).not.toBeInTheDocument();
});

it("leaves Activity unseen when import confirmation hands off to another flow", async () => {
  await show();
  await page.getByRole("button", { name: "Import projects" }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(page.getByText(coachmark).all()).toHaveLength(0);
  expect(localStorage.getItem(activityKey)).toBeNull();
});

it("remembers an explicit Activity click while its coachmark is still queued", async () => {
  useOnboardingDialogStore.setState({ startupGateSettled: false });
  await show();
  expect(page.getByText(coachmark).all()).toHaveLength(0);
  await page.getByRole("button", { name: "Switch to activity view" }).click();
  expect(localStorage.getItem(activityKey)).toBe("seen");
});

it("shows after previously seen announcements and releases the slot when the hint expires", async () => {
  const installation = "/repo/.codex/worktrees";
  localStorage.setItem(importKey, JSON.stringify([installation]));
  localStorage.setItem(tourKey, JSON.stringify([installation]));
  await show();
  await expect.element(page.getByText(coachmark)).toBeVisible();
  expect(localStorage.getItem(activityKey)).toBe("seen");
  await expect.element(page.getByText(coachmark)).not.toBeInTheDocument();
  expect(useAnnouncementSheetSlotStore.getState().owner).toBeNull();
  expect(localStorage.getItem(activityKey)).toBe("seen");
});

it("queues the Tasks hint behind Activity and remembers selection across layouts", async () => {
  const selectTasks = vi.fn();
  useAnnouncementSheetSlotStore.setState({ startupSettled: true });
  const screen = await render(
    <TooltipProvider>
      <SidebarActivityBellButton
        active={false}
        showUnreadDot={false}
        shortcutLabel={null}
        onClick={() => {}}
      />
      <SidebarProvider>
        <ul>
          <SidebarPrimaryAction
            icon={TasksIcon}
            label="Open tasks"
            onClick={selectTasks}
            coachmark={TASKS_COACHMARK}
          />
        </ul>
      </SidebarProvider>
    </TooltipProvider>,
  );
  screens.push(screen);
  const copy = "Keep your to-dos in one place and hand them to an agent when you’re ready.";
  await expect.element(page.getByText(coachmark)).toBeVisible();
  expect(page.getByText(copy).all()).toHaveLength(0);
  await page.getByRole("button", { name: "Switch to activity view" }).click();
  await expect.element(page.getByText(copy)).toBeVisible();
  await page.getByRole("button", { name: "Open tasks" }).click();
  expect(selectTasks).toHaveBeenCalledOnce();
  await expect.element(page.getByText(copy)).not.toBeInTheDocument();
  expect(localStorage.getItem("synara:tasks-onboarding:v1")).toBe("seen");
  await screen.unmount();
  screens.splice(screens.indexOf(screen), 1);
  const remounted = await render(
    <TooltipProvider>
      <AppRail
        items={[
          {
            id: "tasks",
            glyphs: railItemGlyphs("tasks"),
            label: "Tasks",
            badge: null,
            active: false,
            onSelect: selectTasks,
          },
        ]}
        shortcuts={[]}
        bottomItems={[]}
      />
    </TooltipProvider>,
  );
  screens.push(remounted);
  expect(page.getByText(copy).all()).toHaveLength(0);
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  expect(selectTasks).toHaveBeenCalledTimes(2);
});

// FILE: SidebarArchivedThreadsSection.browser.tsx
// Purpose: Characterizes the sidebar's Archived section: the folded list of archived
//          chats, its paging, and the per-row restore action.
// Layer: Browser UI test

import "../index.css";

import { ProjectId, ThreadId } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { DEFAULT_INTERACTION_MODE, type SidebarThreadSummary } from "../types";
import { SidebarArchivedThreadsSection } from "./SidebarArchivedThreadsSection";

function makeArchivedThread(
  id: string,
  overrides: Partial<SidebarThreadSummary> = {},
): SidebarThreadSummary {
  return {
    id: ThreadId.makeUnsafe(id),
    projectId: ProjectId.makeUnsafe("project-archived"),
    title: `Archived ${id}`,
    modelSelection: { provider: "codex", model: "gpt-5.4" },
    interactionMode: DEFAULT_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    session: null,
    createdAt: "2026-07-19T12:00:00.000Z",
    archivedAt: "2026-07-19T13:00:00.000Z",
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
    pendingBackgroundWorkCount: 0,
    ...overrides,
  };
}

function renderSection(threads: readonly SidebarThreadSummary[], onRestore = vi.fn()) {
  return render(
    <SidebarArchivedThreadsSection
      threads={threads}
      resolveProjectLabel={() => "Project Alpha"}
      open
      onToggle={() => {}}
      onRestore={onRestore}
    />,
  );
}

describe("SidebarArchivedThreadsSection", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("lists archived chats with their project and restores from the row", async () => {
    const thread = makeArchivedThread("archived-1");
    const onRestore = vi.fn();
    const screen = await renderSection([thread], onRestore);

    await expect
      .element(screen.getByRole("button", { name: "Archived", exact: true }))
      .toBeVisible();
    await expect
      .element(screen.getByTestId(`archived-thread-${thread.id}`))
      .toHaveTextContent(thread.title);
    await expect.element(screen.getByText("Project Alpha")).toBeVisible();

    await screen.getByTestId(`thread-restore-${thread.id}`).click();

    expect(onRestore).toHaveBeenCalledWith(thread.id);
  });

  it("renders nothing when no chats are archived", async () => {
    const screen = await renderSection([]);

    expect(screen.container.textContent).toBe("");
  });

  it("pages the list so a long archive does not push the sidebar down", async () => {
    const threads = Array.from({ length: 25 }, (_, index) =>
      makeArchivedThread(`archived-${index + 1}`),
    );
    const screen = await renderSection(threads);

    expect(screen.container.querySelectorAll("[data-testid^='archived-thread-']").length).toBe(20);

    await screen.getByRole("button", { name: "Show more" }).click();

    expect(screen.container.querySelectorAll("[data-testid^='archived-thread-']").length).toBe(25);
  });
});

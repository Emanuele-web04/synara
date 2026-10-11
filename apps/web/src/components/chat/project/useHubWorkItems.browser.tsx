import {
  ProjectId,
  ThreadId,
  type HubWorkItem,
  type ProjectAgentOverview,
  type ProjectAgentStreamEvent,
} from "@synara/contracts";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  listeners: new Set<(event: ProjectAgentStreamEvent) => void>(),
  getOverview: vi.fn(),
  subscribe: vi.fn(async () => undefined),
  unsubscribe: vi.fn(async () => undefined),
}));
vi.mock("~/nativeApi", () => ({
  readNativeApi: () => ({
    projectAgent: {
      getOverview: harness.getOverview,
      subscribe: harness.subscribe,
      unsubscribe: harness.unsubscribe,
      onEvent: (listener: (event: ProjectAgentStreamEvent) => void) => {
        harness.listeners.add(listener);
        return () => {
          harness.listeners.delete(listener);
        };
      },
    },
  }),
}));

import { useHubWorkItems } from "./useHubWorkItems";

const projectId = ProjectId.makeUnsafe("hub-a");
const otherProjectId = ProjectId.makeUnsafe("hub-b");
const item: HubWorkItem = {
  id: "work-a",
  title: "Repair login",
  sourceThreadId: ThreadId.makeUnsafe("coordinator"),
  sourceMessageId: null,
  workerThreadId: null,
  state: "queued",
  queueReason: "Waiting for a slot",
  resultSummary: null,
  progress: null,
  revision: 1,
  createdAt: "2026-10-02T12:00:00.000Z",
  updatedAt: "2026-10-02T12:00:00.000Z",
};

function overview(id: ProjectId, items: readonly HubWorkItem[]): ProjectAgentOverview {
  return { projectId: id, hubWorkItems: items } as ProjectAgentOverview;
}

function Probe() {
  const [id, setId] = useState<ProjectId | null>(projectId);
  const items = useHubWorkItems(id);
  return (
    <>
      <button onClick={() => setId(otherProjectId)}>Switch hub</button>
      <button onClick={() => setId(null)}>Leave coordinator</button>
      <output>
        {items.map((entry) => `${entry.title}: ${entry.state}`).join(",") || "No work"}
      </output>
    </>
  );
}

function emit(event: ProjectAgentStreamEvent) {
  for (const listener of harness.listeners) listener(event);
}

describe("coordinator Hub work subscription", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.listeners.clear();
  });

  it("keeps newer stream state when the initial overview or a reconnect snapshot arrives late", async () => {
    let resolveOverview!: (value: ProjectAgentOverview) => void;
    harness.getOverview.mockImplementation(
      () =>
        new Promise<ProjectAgentOverview>((resolve) => {
          resolveOverview = resolve;
        }),
    );
    const screen = await render(<Probe />);
    try {
      emit({
        type: "work-item-upserted",
        projectId,
        workItem: { ...item, state: "completed", revision: 2 },
      });
      await expect
        .element(page.getByText("Repair login: completed", { exact: true }))
        .toBeInTheDocument();
      resolveOverview(overview(projectId, [item]));
      await vi.waitFor(() => expect(harness.getOverview).toHaveBeenCalledOnce());
      emit({ type: "snapshot", overview: overview(projectId, [item]) });
      await expect
        .element(page.getByText("Repair login: completed", { exact: true }))
        .toBeInTheDocument();
      expect(document.querySelector("output")?.textContent).toBe("Repair login: completed");
    } finally {
      await screen.unmount();
    }
    expect(harness.listeners.size).toBe(0);
    expect(harness.unsubscribe).toHaveBeenCalledWith({ projectId });
  });

  it("isolates Hub navigation from late responses and closes subscriptions when leaving the coordinator", async () => {
    let resolveOld!: (value: ProjectAgentOverview) => void;
    harness.getOverview.mockImplementation(({ projectId: requested }: { projectId: ProjectId }) =>
      requested === projectId
        ? new Promise<ProjectAgentOverview>((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve(
            overview(otherProjectId, [{ ...item, id: "work-b", title: "Other work" }]),
          ),
    );
    const screen = await render(<Probe />);
    try {
      await page.getByRole("button", { name: "Switch hub" }).click();
      await expect
        .element(page.getByText("Other work: queued", { exact: true }))
        .toBeInTheDocument();
      resolveOld(overview(projectId, [item]));
      emit({
        type: "work-item-upserted",
        projectId,
        workItem: { ...item, state: "failed", revision: 3 },
      });
      await expect
        .element(page.getByText("Other work: queued", { exact: true }))
        .toBeInTheDocument();
      await page.getByRole("button", { name: "Leave coordinator" }).click();
      await expect.element(page.getByText("No work", { exact: true })).toBeInTheDocument();
      expect(harness.listeners.size).toBe(0);
      expect(harness.unsubscribe).toHaveBeenCalledWith({ projectId: otherProjectId });
    } finally {
      await screen.unmount();
    }
  });
});

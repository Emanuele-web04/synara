import {
  ProjectId,
  ThreadId,
  type HubWorkItem,
  type ProjectAgentStreamEvent,
  type ProjectAgentSummary,
} from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  listSummaries: vi.fn(),
  getOverview: vi.fn(),
  subscribe: vi.fn(async () => undefined),
  unsubscribe: vi.fn(async () => undefined),
  listeners: new Set<(event: ProjectAgentStreamEvent) => void>(),
}));
vi.mock("~/nativeApi", () => ({
  readNativeApi: () => ({
    projectAgent: {
      listSummaries: harness.listSummaries,
      getOverview: harness.getOverview,
      subscribe: harness.subscribe,
      unsubscribe: harness.unsubscribe,
      onEvent: (listener: (event: ProjectAgentStreamEvent) => void) => {
        harness.listeners.add(listener);
        return () => harness.listeners.delete(listener);
      },
    },
  }),
}));

import {
  loadProjectAgentSummaries,
  useProjectAgentSummaries,
  useProjectAgentSummariesStore,
} from "./useProjectAgentSummaries";
import { useHubWorkItems } from "./useHubWorkItems";
import { HubWorkItemCards } from "../group/HubWorkItemCard";

const projectId = ProjectId.makeUnsafe("hub-polling");
const workerId = ThreadId.makeUnsafe("worker-needs-recovery");
const summary: ProjectAgentSummary = {
  projectId,
  configured: true,
  coordinatorName: "Coordinator",
  coordinatorThreadId: ThreadId.makeUnsafe("coordinator-polling"),
  coordinatorIcon: null,
  coordinatorColor: null,
  coordinatorStatus: "idle",
  revision: 1,
  memberThreadIds: [workerId],
  needsYouThreadIds: [],
};

function Probe() {
  const { summariesByProjectId } = useProjectAgentSummaries();
  return <output>{summariesByProjectId.get(projectId)?.needsYouThreadIds?.length ?? 0}</output>;
}

function CoordinatorProbe() {
  const { summariesByProjectId, coordinatorThreadIds } = useProjectAgentSummaries();
  const isCoordinator = coordinatorThreadIds.has(summary.coordinatorThreadId!);
  const workItems = useHubWorkItems(isCoordinator ? projectId : null);
  return (
    <>
      <output>{summariesByProjectId.get(projectId)?.needsYouThreadIds?.length ?? 0}</output>
      <HubWorkItemCards items={workItems} />
    </>
  );
}

describe("closed Hub recovery attention", () => {
  it.each(["stale row", "missing row"] as const)(
    "preserves a newer streamed configuration when an earlier summaries request returns a %s",
    async (response) => {
      useProjectAgentSummariesStore.setState({ summariesByProjectId: new Map(), loaded: false });
      let resolveRequest!: (value: { summaries: ProjectAgentSummary[] }) => void;
      harness.listSummaries.mockReturnValueOnce(
        new Promise<{ summaries: ProjectAgentSummary[] }>((resolve) => {
          resolveRequest = resolve;
        }),
      );
      const screen = await render(<Probe />);
      try {
        const request = loadProjectAgentSummaries();
        const event: ProjectAgentStreamEvent = {
          type: "config-upserted",
          config: {
            projectId,
            coordinatorThreadId: summary.coordinatorThreadId!,
            coordinatorName: "Renamed coordinator",
            coordinatorModelSelection: { provider: "codex", model: "gpt-5-codex" },
            limits: {
              maxConcurrentWorkers: 3,
              maxNewWorkersPerTurn: 4,
              maxWorkerCreationsPerGoal: 12,
              maxAutomaticContinuationsPerGoal: 20,
              maxRepairRoundsPerTask: 2,
            },
            captureEnabled: true,
            enabled: true,
            automationId: null,
            pausedAt: "2026-10-02T12:00:00.000Z",
            revision: 2,
            createdAt: "2026-10-02T11:00:00.000Z",
            updatedAt: "2026-10-02T12:00:00.000Z",
            disabledAt: null,
          },
        };
        for (const listener of harness.listeners) listener(event);
        resolveRequest({ summaries: response === "stale row" ? [summary] : [] });
        await request;
        expect(
          useProjectAgentSummariesStore.getState().summariesByProjectId.get(projectId),
        ).toMatchObject({
          coordinatorName: "Renamed coordinator",
          revision: 2,
          pausedAt: "2026-10-02T12:00:00.000Z",
        });
      } finally {
        await screen.unmount();
      }
    },
  );

  it("retains coordinator cards and membership after a transient refresh failure and retries on the next period", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    useProjectAgentSummariesStore.setState({ summariesByProjectId: new Map(), loaded: false });
    harness.listSummaries.mockResolvedValue({ summaries: [summary] });
    const workItem: HubWorkItem = {
      id: "work-survives-refresh",
      title: "Repair login",
      sourceThreadId: summary.coordinatorThreadId!,
      sourceMessageId: null,
      workerThreadId: workerId,
      state: "working",
      queueReason: null,
      progress: null,
      resultSummary: null,
      revision: 1,
      createdAt: "2026-10-02T12:00:00.000Z",
      updatedAt: "2026-10-02T12:00:00.000Z",
    };
    harness.getOverview.mockResolvedValue({ projectId, hubWorkItems: [workItem] });
    const screen = await render(<CoordinatorProbe />);
    try {
      await vi.waitFor(() =>
        expect(document.querySelector('article[aria-label="Work: Repair login"]')).not.toBeNull(),
      );
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      harness.listSummaries.mockRejectedValueOnce(new Error("Temporary request failure"));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(
        useProjectAgentSummariesStore.getState().summariesByProjectId.get(projectId)
          ?.memberThreadIds,
      ).toEqual([workerId]);
      expect(document.querySelector('article[aria-label="Work: Repair login"]')).not.toBeNull();

      const failedRequests = harness.listSummaries.mock.calls.length;
      harness.listSummaries.mockResolvedValue({
        summaries: [{ ...summary, needsYouThreadIds: [workerId] }],
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(harness.listSummaries.mock.calls.length).toBe(failedRequests + 1);
      await vi.waitFor(() => expect(document.querySelector("output")?.textContent).toBe("1"), {
        timeout: 1_000,
      });
      expect(document.querySelector('article[aria-label="Work: Repair login"]')).not.toBeNull();
    } finally {
      await screen.unmount();
      Reflect.deleteProperty(document, "visibilityState");
      vi.useRealTimers();
    }
  });

  it("shares a visible 30-second refresh and refreshes recovery state on returning to the window", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let visibility = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    useProjectAgentSummariesStore.setState({ summariesByProjectId: new Map(), loaded: false });
    harness.listSummaries.mockResolvedValue({ summaries: [summary] });
    const screen = await render(
      <>
        <Probe />
        <Probe />
      </>,
    );
    try {
      await vi.waitFor(() => expect(useProjectAgentSummariesStore.getState().loaded).toBe(true));
      // Allow the visible interval's immediate refresh to finish before measuring the next period.
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      const initialRequests = harness.listSummaries.mock.calls.length;
      harness.listSummaries.mockResolvedValue({
        summaries: [{ ...summary, needsYouThreadIds: [workerId] }],
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(harness.listSummaries.mock.calls.length).toBe(initialRequests + 1);
      await vi.waitFor(
        () =>
          expect(
            [...document.querySelectorAll("output")].map((entry) => entry.textContent),
          ).toEqual(["1", "1"]),
        { timeout: 1_000 },
      );

      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      const visibleRequests = harness.listSummaries.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      window.dispatchEvent(new Event("focus"));
      expect(harness.listSummaries.mock.calls.length).toBe(visibleRequests);

      harness.listSummaries.mockResolvedValue({ summaries: [summary] });
      visibility = "visible";
      window.dispatchEvent(new Event("focus"));
      await vi.waitFor(
        () =>
          expect(
            [...document.querySelectorAll("output")].map((entry) => entry.textContent),
          ).toEqual(["0", "0"]),
        { timeout: 1_000 },
      );
    } finally {
      await screen.unmount();
      Reflect.deleteProperty(document, "visibilityState");
      vi.useRealTimers();
    }
  });
});

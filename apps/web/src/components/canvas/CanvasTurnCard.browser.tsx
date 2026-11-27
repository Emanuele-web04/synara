import "../../index.css";

import { ThreadId, type CanvasTurnActivity, type CanvasWork } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const native = vi.hoisted(() => ({
  canvas: {
    get: vi.fn(),
    getAsset: vi.fn(),
    turnActivity: vi.fn(),
    restoreTurn: vi.fn(),
  },
}));
vi.mock("../../nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../nativeApi")>()),
  ensureNativeApi: () => native,
  readNativeApi: () => undefined,
}));
const shown = vi.hoisted(() => ({ work: null as unknown }));
vi.mock("./canvasPane", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./canvasPane")>()),
  useCanvasWork: () => ({
    connection: { supported: true, negotiating: false, disconnected: false },
    query: { data: shown.work, isError: false },
  }),
}));

import { useStore } from "~/store";
import type { SidebarThreadSummary } from "~/types";
import { CanvasTurnCard } from "./CanvasTurnCard";
import { at, frameOf, workOf } from "./editor/canvasEditorTestHarness";

const thread = ThreadId.makeUnsafe("chat1");
const work = workOf([frameOf("f1", [], [], { title: "Pricing" })]);
const activity = (restoredAt: string | null): CanvasTurnActivity => ({
  threadId: thread,
  turnId: "turn1",
  workId: "work1",
  workTitle: "Work",
  pageId: "page1",
  pageTitle: "Page 1",
  createdFrameIds: [],
  updatedFrameIds: ["f1"],
  firstFrameId: "f1",
  createdAt: at(1),
  updatedAt: at(2),
  restorable: restoredAt === null,
  restoredAt,
});
const indicator = () => document.querySelector('[data-canvas-page-activity="work"]');
const restoreButton = () =>
  document.querySelector<HTMLButtonElement>('button[aria-label="Restore previous version"]');

describe("canvas turn card", () => {
  beforeEach(() => {
    shown.work = work;
    for (const mock of Object.values(native.canvas)) mock.mockReset();
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows the agent indicator by its title while its turn still runs", async () => {
    native.canvas.turnActivity.mockResolvedValue({ activities: [activity(null)] });
    const turn = (state: "running" | "completed", turnId = "turn1") =>
      useStore.setState({
        sidebarThreadSummaryById: {
          [thread]: {
            id: thread,
            session: { status: state === "running" ? "running" : "ready" },
            latestTurn: {
              turnId,
              state,
              startedAt: at(1),
              completedAt: state === "running" ? null : at(5),
            },
          } as unknown as SidebarThreadSummary,
        },
      });
    turn("running");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={client}>
        <CanvasTurnCard
          threadId={thread}
          turnId="turn1"
          workId="work1"
          workTitle="Work"
          pageId="page1"
        />
      </QueryClientProvider>,
    );
    try {
      await vi.waitFor(() => expect(indicator()).toBeTruthy());
      expect(indicator()!.getAttribute("aria-label")).toBe("An agent is working on this canvas");
      // The turn ends: the indicator fades away.
      turn("completed");
      await vi.waitFor(() => expect(indicator()).toBeNull());
      // A later turn running does not light an earlier turn's card.
      turn("running", "turn2");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(indicator()).toBeNull();
    } finally {
      await screen.unmount();
      useStore.setState({ sidebarThreadSummaryById: {} });
    }
  });

  it("names its restore button on hover and shows a spinner while the restore runs", async () => {
    let restored = false;
    native.canvas.turnActivity.mockImplementation(async () => ({
      activities: [activity(restored ? at(3) : null)],
    }));
    let finish: ((value: CanvasWork) => void) | undefined;
    native.canvas.restoreTurn.mockImplementation(
      () =>
        new Promise<CanvasWork>((resolve) => {
          finish = (value) => {
            restored = true;
            resolve(value);
          };
        }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={client}>
        <CanvasTurnCard
          threadId={thread}
          turnId="turn1"
          workId="work1"
          workTitle="Work"
          pageId="page1"
        />
      </QueryClientProvider>,
    );
    try {
      await vi.waitFor(() => expect(restoreButton()).toBeTruthy());
      // Hovering the icon names it, as the app's other icon buttons do.
      await page.getByRole("button", { name: "Restore previous version" }).hover();
      await vi.waitFor(() =>
        expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toBe(
          "Restore previous version",
        ),
      );
      restoreButton()!.click();
      await page.getByRole("button", { name: "Restore", exact: true }).click();
      // While the restore runs: the app's spinner in place of the icon, and no second press.
      await vi.waitFor(() =>
        expect(restoreButton()!.querySelector('[role="status"]')).toBeTruthy(),
      );
      expect(restoreButton()!.disabled).toBe(true);
      expect(native.canvas.restoreTurn).toHaveBeenCalledWith({
        workId: "work1",
        threadId: thread,
        turnId: "turn1",
      });
      finish!(work);
      // Done: the card says so and offers no second restore.
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain("Restored to the previous version"),
      );
      expect(restoreButton()).toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});

// FILE: ComputerPreviewPopover.browser.tsx
// Purpose: Interactive coverage the server-markup test cannot reach — the
//          mounted-armed -> live transition, close hiding for the task,
//          expand routing to the dock pane path while staying live, and Stop
//          hitting the desktop-control interrupt.
// Layer: Component browser tests (vitest-browser-react + playwright)
// Depends on: ComputerPreviewPopover, the real computerPreviewStore.

import { ThreadId } from "@synara/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useComputerPreviewStore } from "../../computerPreviewStore";
import { ComputerPreviewPopover } from "./ComputerPreviewPopover";

const fixture = vi.hoisted(() => ({
  agentActive: false,
  visibleDesktop: false,
  stopRequested: false,
  stop: vi.fn(),
}));

vi.mock("~/hooks/useThreadComputerStateSeed", () => ({
  useThreadComputerStateSeed: () => {},
}));
vi.mock("~/hooks/useComputerDesktopControl", () => ({
  useComputerDesktopControl: () => ({
    agentActive: fixture.agentActive,
    visibleDesktop: fixture.visibleDesktop,
    stopRequested: fixture.stopRequested,
    stop: fixture.stop,
    stopError: null,
  }),
}));
vi.mock("../computer/useComputerImageStream", () => ({
  useComputerImageStream: () => ({
    status: { kind: "streaming" },
    dimensions: { width: 100, height: 100 },
  }),
}));
vi.mock("../../appSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../appSettings")>()),
  useAppSettings: () => ({ settings: { autoOpenComputerPane: true } }),
}));
vi.mock("../../computerStateStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../computerStateStore")>()),
  useComputerStateStore: (selector: (store: unknown) => unknown) =>
    selector({ threadStatesByThreadId: {}, lastActionByThreadId: {} }),
}));

const threadId = ThreadId.makeUnsafe("preview-thread");

const session = () => useComputerPreviewStore.getState().sessionsByThreadId[threadId];

beforeEach(() => {
  useComputerPreviewStore.getState().clear();
  fixture.agentActive = false;
  fixture.visibleDesktop = false;
  fixture.stopRequested = false;
  fixture.stop.mockReset();
});

it("keeps a background session armed until the thread is viewed, then goes live", async () => {
  useComputerPreviewStore.getState().requestPreviewSurface(threadId);
  // No surface mounted: the session waits armed instead of going live.
  expect(session()?.phase).toBe("armed");

  const screen = await render(<ComputerPreviewPopover threadId={threadId} />);
  await expect.poll(() => session()?.phase).toBe("live");
  await screen.unmount();
});

it("hides for the rest of the task when closed", async () => {
  useComputerPreviewStore.getState().requestPreviewSurface(threadId);
  const screen = await render(<ComputerPreviewPopover threadId={threadId} />);
  await expect.poll(() => session()?.phase).toBe("live");

  await screen.getByRole("button", { name: "Hide the computer preview", exact: false }).click();
  await expect.poll(() => session()?.phase).toBe("hidden-for-task");
  await screen.unmount();
});

it("does not expose the disabled Computer pane", async () => {
  useComputerPreviewStore.getState().requestPreviewSurface(threadId);
  const screen = await render(<ComputerPreviewPopover threadId={threadId} />);
  await expect.poll(() => session()?.phase).toBe("live");

  await expect
    .element(screen.getByRole("button", { name: "Open the Computer pane", exact: true }))
    .not.toBeInTheDocument();
  await screen.unmount();
});

it("leaves stopping to the composer: no stop control on the card", async () => {
  fixture.agentActive = true;
  useComputerPreviewStore.getState().requestPreviewSurface(threadId);
  const screen = await render(<ComputerPreviewPopover threadId={threadId} />);
  await expect.poll(() => session()?.phase).toBe("live");

  await expect
    .element(screen.getByRole("button", { name: "Stop the agent controlling", exact: false }))
    .not.toBeInTheDocument();
  await screen.unmount();
});

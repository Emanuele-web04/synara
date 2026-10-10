import "../../index.css";
import { ProjectId, ThreadId } from "@synara/contracts";
import { page } from "vitest/browser";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { ReactNode } from "react";
import { collectLeaves } from "../../splitView.logic";
import { useSplitViewStore } from "../../splitViewStore";
import { useRightDockStore } from "../../rightDockStore";
import { toastManager } from "../ui/toast";
import {
  runningSubagentRosterItem,
  subagentRosterItem,
} from "./environment/subagentRosterFixtures";
import { SubagentsDockPane, SubagentsList } from "./SubagentsDockPane";
import { SplitChatSurface } from "./SplitChatSurface";

const state = vi.hoisted(() => ({
  navigate: vi.fn(async (_input: unknown) => {}),
  dispatch: vi.fn(async (_input: unknown) => {}),
  roster: { active: [] as unknown[], previous: [] as unknown[] },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => state.navigate,
}));
vi.mock("../../nativeApi", () => ({
  readNativeApi: () => ({ orchestration: { dispatchCommand: state.dispatch } }),
}));
vi.mock("./useSubagentStripSource", () => ({
  useThreadSubagentRoster: () => ({
    roster: state.roster,
    source: { stripSourceThreadId: "parent", subagentParentRow: null },
  }),
}));
vi.mock("../../hooks/useHandleNewChat", () => ({
  useHandleNewChat: () => ({ handleNewChat: vi.fn() }),
}));
vi.mock("../../hooks/useBrowserPanelDesktopBridge", () => ({
  useBrowserPanelDesktopBridge: () => {},
}));
vi.mock("./ChatPaneKeepAlive", () => ({
  KeptChatPane: ({ children }: { children: ReactNode }) => children,
  ChatPaneBody: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./ChatThreadSurfacePrimitives", () => ({
  DeferredChatView: () => <div>Transcript</div>,
  ChatMountLoader: () => null,
  LazyBrowserPanel: () => null,
  LazyDiffPanel: () => null,
  noopChatSurfaceAction: () => {},
}));
const parent = ThreadId.makeUnsafe("parent");
const other = ThreadId.makeUnsafe("other");
const child = runningSubagentRosterItem("Scout");
beforeEach(() => {
  vi.clearAllMocks();
  state.roster = { active: [child], previous: [] };
  useRightDockStore.setState({ dockStateByThreadId: {} });
});

it("expands and collapses finished rows without leaving hidden buttons reachable", async () => {
  const screen = await render(
    <SubagentsList
      roster={{
        active: [],
        previous: Array.from({ length: 12 }, (_, i) => subagentRosterItem(`Done ${i}`)),
      }}
      parent={null}
      nowMs={0}
      onOpen={() => {}}
      onStop={() => {}}
      onBackground={() => {}}
    />,
  );
  try {
    const extra = page.getByRole("button", { name: "Open subagent Done 11 (Completed)" });
    expect(extra.elements()).toHaveLength(0);
    await page.getByRole("button", { name: "Show 2 more" }).click();
    await expect.element(extra).toBeVisible();
    await page.getByRole("button", { name: "Show less" }).click();
    expect(extra.elements()).toHaveLength(0);
  } finally {
    await screen.unmount();
  }
});

it.each(["Stop subagent Scout", "Run Scout in background"])(
  "reports rejected %s commands",
  async (label) => {
    state.dispatch.mockRejectedValueOnce(new Error("Provider disconnected"));
    const feedback = vi.spyOn(toastManager, "add");
    const screen = await render(<SubagentsDockPane hostThreadId={parent} />);
    try {
      await page.getByRole("button", { name: label, exact: true }).click({ force: true });
      await expect.poll(() => feedback.mock.calls.length).toBe(1);
      expect(feedback.mock.calls[0]?.[0]).toMatchObject({
        type: "error",
        description: "Provider disconnected",
      });
    } finally {
      feedback.mockRestore();
      await screen.unmount();
    }
  },
);

it("opens the subagent dock in a split pane, keeps its destination in that pane, and closes it", async () => {
  await page.viewport(1800, 1000);
  const split = useSplitViewStore.getState().createFromDrop({
    sourceThreadId: parent,
    ownerProjectId: ProjectId.makeUnsafe("project"),
    droppedThreadId: other,
    direction: "horizontal",
    side: "second",
  });
  const sourcePane = collectLeaves(useSplitViewStore.getState().splitViewsById[split]!.root).find(
    (leaf) => leaf.threadId === parent,
  )!;
  useRightDockStore.getState().openPane(parent, { kind: "subagents" });
  const screen = await render(<SplitChatSurface splitViewId={split} routeThreadId={parent} />);
  try {
    await expect
      .element(page.getByRole("button", { name: "Open subagent Scout (Running)" }))
      .toBeVisible();
    await page.getByRole("button", { name: "Open subagent Scout (Running)" }).click();
    await expect
      .poll(
        () =>
          collectLeaves(useSplitViewStore.getState().splitViewsById[split]!.root).find(
            (leaf) => leaf.id === sourcePane.id,
          )?.threadId,
      )
      .toBe(child.threadId);
    expect(state.navigate.mock.calls.at(-1)?.[0]).toMatchObject({
      params: { threadId: child.threadId },
    });
    await page.getByRole("button", { name: "Hide subagents", exact: true }).click();
    await expect
      .poll(
        () => page.getByRole("button", { name: "Open subagent Scout (Running)" }).elements().length,
      )
      .toBe(0);
  } finally {
    await screen.unmount();
    useSplitViewStore.getState().removeSplitView(split);
  }
});

it("keeps completed-only relative time current after the last active run settles", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let nowMs = Date.parse("2026-10-10T10:01:10Z");
  const clock = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
  state.roster = { active: [], previous: [subagentRosterItem("Finished")] };
  const screen = await render(<SubagentsDockPane hostThreadId={parent} />);
  try {
    await expect.element(page.getByText("just now", { exact: true })).toBeVisible();
    nowMs += 120_000;
    await vi.advanceTimersByTimeAsync(120_000);
    await expect.element(page.getByText("2m ago", { exact: true })).toBeVisible();
  } finally {
    await screen.unmount();
    vi.useRealTimers();
    clock.mockRestore();
  }
});

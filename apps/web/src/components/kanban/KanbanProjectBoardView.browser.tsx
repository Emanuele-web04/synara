// Real-chromium render of the v2 attention-first board over seeded state.
import "../../index.css";

import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

vi.mock("~/appSettings", () => ({
  useAppSettings: () => ({
    settings: { defaultProvider: "codex", sidebarProjectSortOrder: "manual" },
    setSetting: vi.fn(),
  }),
  getProviderStartOptions: () => [],
  resolveAssistantDeliveryMode: () => "default",
}));
vi.mock("~/hooks/useProviderStatusesForLocalConfig", () => ({
  useProviderStatusesForLocalConfig: () => [READY_CODEX_STATUS],
}));
vi.mock("~/hooks/useProviderStatusRefresh", () => ({
  useRefreshProviderStatusesNow: () => () => undefined,
}));
vi.mock("../../lib/kanbanDispatch", () => ({
  dispatchKanbanDraftCardAsGoal: vi.fn().mockResolvedValue({ kind: "dispatched" }),
  kanbanDispatchFailureToast: vi.fn().mockReturnValue({
    type: "error",
    title: "Mock toast",
    description: "mock",
  }),
}));

import type { ServerProviderStatus, ThreadId } from "@synara/contracts";
import { KANBAN_ATTENTION_LABELS, KANBAN_COLUMN_V2_LABELS } from "@synara/shared/kanban";
import { dispatchKanbanDraftCardAsGoal } from "../../lib/kanbanDispatch";
import { KanbanProjectBoardView } from "./KanbanProjectBoardView";
import type { KanbanCard, KanbanProjectBoard } from "./kanban.logic";
import { useKanbanUiStore } from "../../kanbanUiStore";

const dispatchAsGoalMock = vi.mocked(dispatchKanbanDraftCardAsGoal);

// A usable provider status: with no usable status the drop handler toasts
// "Provider status is still loading" and never reaches the dispatch call.
const READY_CODEX_STATUS: ServerProviderStatus = {
  provider: "codex",
  status: "ready",
  available: true,
  authStatus: "authenticated",
  checkedAt: "2026-08-21T12:00:00.000Z",
  message: "Codex is ready.",
};

const NOW_MS = Date.parse("2026-08-21T12:00:00.000Z");

function makeCard(id: string, column: KanbanCard["column"], overrides?: Partial<KanbanCard>) {
  return {
    cardId: `thread:${id}`,
    threadId: id as ThreadId,
    projectId: "project-1" as KanbanCard["projectId"],
    column,
    title: `Card ${id}`,
    provider: "codex",
    isTerminal: false,
    branch: null,
    envMode: null,
    worktreePath: null,
    thread: null,
    draftPrompt: "",
    draftHasAttachments: false,
    sortTimestamp: NOW_MS,
    timestamp: new Date(NOW_MS).toISOString(),
    activeWorkStartedAt: column === "inProgress" ? new Date(NOW_MS).toISOString() : null,
    isOptimisticDispatch: false,
    ...overrides,
  } satisfies KanbanCard;
}

const board = {
  projectId: "project-1" as KanbanProjectBoard["projectId"],
  projectName: "Demo",
  projectKind: "project" as const,
  draft: [makeCard("draft-1", "draft")],
  inProgress: [makeCard("live-1", "inProgress")],
  awaitingYou: [
    makeCard("awaiting-1", "awaitingYou", { attention: ["awaiting-approval"], needsReview: true }),
  ],
  done: [makeCard("done-1", "done")],
  totalCount: 4,
  hiddenCount: 0,
} satisfies KanbanProjectBoard;

/**
 * The inner card `<button>` for a draft title. (A plain role query is ambiguous:
 * the sortable wrapper `li` also carries `role="button"`.)
 */
function findCardButton(titleSnippet: string): HTMLButtonElement | null {
  const match = [...document.querySelectorAll("li button")].find((candidate) =>
    candidate.textContent?.includes(titleSnippet),
  );
  return (match ?? null) as HTMLButtonElement | null;
}

/**
 * Drives a dnd-kit PointerSensor drag with synthetic pointer events: pointerdown
 * on the card (the sortable `li` picks it up through bubbling), then moves and
 * pointerup which bubble up to the owner document where the sensor listens.
 * Moves walk past the 6px activation constraint and land over the target
 * column's droppable list; collision is coordinate-based.
 */
async function dragCardOntoColumn(titleSnippet: string, columnHeading: string) {
  const source = findCardButton(titleSnippet);
  if (!source) {
    throw new Error(`missing card button containing "${titleSnippet}"`);
  }
  const columnSection = [...document.querySelectorAll("section")].find((candidate) =>
    [...candidate.querySelectorAll("h3")].some((heading) => heading.textContent === columnHeading),
  );
  const target = columnSection?.querySelector("ul");
  if (!target) {
    throw new Error(`missing droppable list for column "${columnHeading}"`);
  }
  const from = source.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  const fromX = from.x + from.width / 2;
  const fromY = from.y + from.height / 2;
  const toX = to.x + to.width / 2;
  const toY = to.y + to.height / 2;
  const pointerEvent = (type: "pointerdown" | "pointermove" | "pointerup", x: number, y: number) =>
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      pointerId: 1,
      isPrimary: true,
      pointerType: "mouse",
    });
  // Real drags space input across frames, letting React flush the measure /
  // collision effects between events. A synchronous burst would deliver every
  // event before any effect runs, so collisions (and `over`) never compute.
  const frame = () => new Promise((resolve) => window.setTimeout(resolve, 16));
  source.dispatchEvent(pointerEvent("pointerdown", fromX, fromY));
  await frame();
  const steps = 8;
  for (let step = 1; step <= steps; step++) {
    source.dispatchEvent(
      pointerEvent(
        "pointermove",
        fromX + ((toX - fromX) * step) / steps,
        fromY + ((toY - fromY) * step) / steps,
      ),
    );
    await frame();
  }
  source.dispatchEvent(pointerEvent("pointerup", toX, toY));
}

describe("KanbanProjectBoardView v2 (browser)", () => {
  it("renders the four-column attention-first layout with pills and filter", async () => {
    await render(
      <KanbanProjectBoardView
        board={board}
        onOpenCard={vi.fn()}
        onNewTask={vi.fn()}
        prByThreadId={new Map()}
        nowMs={NOW_MS}
        viewMode="v2"
      />,
    );

    for (const label of Object.values(KANBAN_COLUMN_V2_LABELS)) {
      await expect.element(page.getByRole("heading", { name: label })).toBeVisible();
    }
    for (const cardTitle of ["Card draft-1", "Card live-1", "Card awaiting-1", "Card done-1"]) {
      await expect.element(page.getByText(cardTitle)).toBeVisible();
    }
    await expect
      .element(page.getByText(KANBAN_ATTENTION_LABELS["awaiting-approval"]))
      .toBeVisible();
    await expect.element(page.getByText("Needs review")).toBeVisible();
  });

  it("keeps classic mode at three columns without the awaiting-you column", async () => {
    const { unmount } = await render(
      <KanbanProjectBoardView
        board={{ ...board, awaitingYou: [] }}
        onOpenCard={vi.fn()}
        onNewTask={vi.fn()}
        prByThreadId={new Map()}
        nowMs={NOW_MS}
        viewMode="classic"
      />,
    );

    for (const label of ["Draft", "In Progress"] as const) {
      await expect.element(page.getByRole("heading", { name: label })).toBeVisible();
    }
    expect(document.body.textContent).not.toContain(KANBAN_COLUMN_V2_LABELS.awaitingYou);
    await unmount();
  });

  it("dispatches a draft drop on In Progress WITH the goal variant", async () => {
    dispatchAsGoalMock.mockClear();
    const goalBoard = {
      ...board,
      draft: [
        makeCard("goal-1", "draft", {
          cardId: "draft:goal-1",
          title: "Sendable goal card",
          draftPrompt: "Write the goal down",
        }),
      ],
    } satisfies KanbanProjectBoard;
    const { unmount } = await render(
      <KanbanProjectBoardView
        board={goalBoard}
        onOpenCard={vi.fn()}
        onNewTask={vi.fn()}
        prByThreadId={new Map()}
        nowMs={NOW_MS}
        viewMode="v2"
      />,
    );
    try {
      await expect.poll(() => findCardButton("Sendable goal card") !== null).toBe(true);
      await dragCardOntoColumn("Sendable goal card", KANBAN_COLUMN_V2_LABELS.inProgress);
      await expect.poll(() => dispatchAsGoalMock.mock.calls.length, { timeout: 5000 }).toBe(1);
      expect(dispatchAsGoalMock).toHaveBeenCalledWith(
        expect.objectContaining({
          card: expect.objectContaining({ threadId: "goal-1" }),
        }),
      );
    } finally {
      await unmount();
    }
  });

  it("reorders draft cards with Alt+Arrow keys", async () => {
    const reorderBoard = {
      ...board,
      draft: [
        makeCard("key-1", "draft", { cardId: "draft:key-1", title: "Key card one" }),
        makeCard("key-2", "draft", { cardId: "draft:key-2", title: "Key card two" }),
      ],
    } satisfies KanbanProjectBoard;
    // Start from a clean slate: earlier tests may have stored an order.
    const reorderProjectId = "project-1" as KanbanProjectBoard["projectId"];
    useKanbanUiStore.getState().setDraftOrder(reorderProjectId, ["draft:key-1", "draft:key-2"]);
    const { unmount } = await render(
      <KanbanProjectBoardView
        board={reorderBoard}
        onOpenCard={vi.fn()}
        onNewTask={vi.fn()}
        prByThreadId={new Map()}
        nowMs={NOW_MS}
        viewMode="v2"
      />,
    );
    try {
      await expect.poll(() => findCardButton("Key card one") !== null).toBe(true);
      findCardButton("Key card one")?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "ArrowDown",
          altKey: true,
        }),
      );
      await expect
        .poll(() => useKanbanUiStore.getState().draftOrderByProjectId["project-1"], {
          timeout: 5000,
        })
        .toEqual(["draft:key-2", "draft:key-1"]);
    } finally {
      await unmount();
    }
  });
});

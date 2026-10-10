import { ThreadId, TurnId } from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";

import { localSubagentThreadId } from "../ChatView.selectors";
import { makeActivity, makeState, makeThread } from "../../storeTestFixtures";
import { useStore } from "../../store";
import {
  getRetainedThreadDetailIdsSnapshot,
  resetRetainedThreadDetailSubscriptionsForTests,
} from "../../threadDetailSubscriptionRetention";
import type { AppState } from "../../storeState";
import { useThreadSubagentRoster } from "./useSubagentStripSource";

// Run the real hook's effects at the subscription boundary without a DOM renderer.
// Store selectors, child enrichment and the retention registry remain real.
const effects = vi.hoisted(() => [] as Array<() => void | (() => void)>);
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) => effects.push(effect),
}));
// SSR normally reads Zustand's initial snapshot; this probe reads the current
// real store so each rendered snapshot represents a delivered detail update.
vi.mock("../../store", async (original) => {
  const actual = await original<typeof import("../../store")>();
  return {
    ...actual,
    useStore: Object.assign(
      (selector: (state: AppState) => unknown) => selector(actual.useStore.getState()),
      actual.useStore,
    ),
  };
});
const cleanups: Array<() => void> = [];
const initialState = useStore.getState();
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  effects.length = 0;
  resetRetainedThreadDetailSubscriptionsForTests();
  useStore.setState(initialState, true);
});

it.each(["closed", "completed"])(
  "retains live siblings from a child roster and reflects %s settlement",
  (settlement) => {
    const parentId = ThreadId.makeUnsafe("parent-roster");
    const childId = localSubagentThreadId(parentId, "child");
    const siblingId = localSubagentThreadId(parentId, "sibling");
    const session = {
      provider: "codex" as const,
      status: "ready" as const,
      orchestrationStatus: "running" as const,
      createdAt: "2026-10-10T10:00:00.000Z",
      updatedAt: "2026-10-10T10:00:00.000Z",
    };
    const parent = makeThread({
      id: parentId,
      activities: ["child", "sibling"].map((receiver) =>
        makeActivity({
          id: `launch-${receiver}`,
          kind: "tool.completed",
          payload: {
            itemType: "collab_agent_tool_call",
            status: "completed",
            data: {
              toolCallId: `launch-${receiver}`,
              toolName: "spawn_agent",
              receiverThreadId: receiver,
              agentStates: { [receiver]: { status: "running" } },
            },
          },
        }),
      ),
    });
    const children = [childId, siblingId].map((id) =>
      makeThread({ id, parentThreadId: parentId, session }),
    );
    const slices = [parent, ...children].map(makeState);
    const state = { ...slices[0] } as AppState;
    for (const key of Object.keys(state) as Array<keyof AppState>) {
      if (key === "threadIds") state.threadIds = slices.flatMap((slice) => slice.threadIds ?? []);
      else if (key.endsWith("ById") || key.endsWith("ByThreadId")) {
        Object.assign(state, { [key]: Object.assign({}, ...slices.map((slice) => slice[key])) });
      }
    }
    useStore.setState(state);
    let roster: ReturnType<typeof useThreadSubagentRoster>["roster"] | undefined;
    function Probe() {
      roster = useThreadSubagentRoster(childId).roster;
      return null;
    }
    renderToStaticMarkup(<Probe />);
    for (const effect of effects.splice(0)) {
      const cleanup = effect();
      if (cleanup) cleanups.push(cleanup);
    }
    expect(roster?.active.map((item) => item.threadId)).toContain(siblingId);
    expect(getRetainedThreadDetailIdsSnapshot()).toEqual(
      expect.arrayContaining([parentId, siblingId]),
    );

    // The parent's launch remains running: only the child's own streamed session
    // confirms that this sibling is done.
    useStore.setState({
      threadSessionById: {
        ...state.threadSessionById,
        [siblingId]: {
          ...session,
          status: settlement === "closed" ? "closed" : "ready",
          orchestrationStatus: "idle",
          updatedAt: "2026-10-10T10:01:00.000Z",
        },
      },
      threadTurnStateById: {
        ...state.threadTurnStateById,
        [siblingId]: {
          latestTurn: {
            turnId: TurnId.makeUnsafe("sibling-turn"),
            state: "completed",
            requestedAt: session.createdAt,
            startedAt: session.createdAt,
            completedAt: "2026-10-10T10:01:00.000Z",
            assistantMessageId: null,
          },
        },
      },
    });
    renderToStaticMarkup(<Probe />);
    expect(roster?.active.map((item) => item.threadId)).not.toContain(siblingId);
    expect(roster?.previous.find((item) => item.threadId === siblingId)?.isActive).toBe(false);
  },
);

import { MessageId, TurnId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { evictThreadDetailFromClientState } from "./storeProjection";
import { makeActivity, makeState, makeThread } from "./storeTestFixtures";
import { collectByIds, getThreadFromState } from "./threadDerivation";
import type { Thread } from "./types";

const at = "2026-10-30T00:00:00.000Z";
const details: Pick<Thread, "messages" | "activities" | "proposedPlans" | "turnDiffSummaries"> = {
  messages: [
    { id: MessageId.makeUnsafe("m"), role: "user", text: "kept", createdAt: at, streaming: false },
  ],
  activities: [makeActivity({ payload: { detail: "kept" } })],
  proposedPlans: [
    {
      id: "p",
      turnId: null,
      planMarkdown: "kept",
      implementedAt: null,
      implementationThreadId: null,
      createdAt: at,
      updatedAt: at,
    },
  ],
  turnDiffSummaries: [{ turnId: TurnId.makeUnsafe("t"), completedAt: at, files: [] }],
};
const slices = [
  ["messages", "messageIdsByThreadId", "messageByThreadId"],
  ["activities", "activityIdsByThreadId", "activityByThreadId"],
  ["proposedPlans", "proposedPlanIdsByThreadId", "proposedPlanByThreadId"],
  ["turnDiffSummaries", "turnDiffIdsByThreadId", "turnDiffSummaryByThreadId"],
] as const;

describe("thread derivation", () => {
  it("preserves sparse order, duplicate references, falsy filtering and collection caching", () => {
    const values: Record<string, unknown> = {
      a: { value: "a" },
      b: { value: "b" },
      zero: 0,
      no: false,
      blank: "",
      nil: null,
      nan: NaN,
      undefined: "not a sparse entry",
    };
    const ids = ["b", "hole", "a", "b", "zero", "no", "blank", "nil", "nan", "missing"];
    delete ids[1];
    const empty: unknown[] = [];
    const result = collectByIds(ids, values, empty);
    expect(result).toEqual([values.b, values.a, values.b]);
    expect(result[0]).toBe(result[2]);
    expect(collectByIds(ids, values, [])).toBe(result);
    expect(collectByIds(ids.slice(), values, [])).not.toBe(result);
    expect(collectByIds(undefined, values, empty)).toBe(empty);
    expect(collectByIds([], values, empty)).toBe(empty);
    expect(collectByIds(ids, undefined, empty)).toBe(empty);
  });

  it.each(slices)(
    "reuses identity when empty %s records are replaced or removed",
    (_, ids, records) => {
      const state = makeState(makeThread());
      const id = state.threadIds![0]!;
      const before = getThreadFromState(state, id);
      expect(
        getThreadFromState({ ...state, [ids]: { [id]: [] }, [records]: { [id]: {} } }, id),
      ).toBe(before);
      expect(getThreadFromState({ ...state, [ids]: {}, [records]: {} }, id)).toBe(before);
    },
  );

  it.each(slices)(
    "preserves current-only identity, updates and eviction for %s",
    (collection, ids) => {
      const thread = makeThread({ [collection]: details[collection] });
      const state = makeState(thread);
      const first = getThreadFromState(state, thread.id)!;
      expect(getThreadFromState({ ...state }, thread.id)).toBe(first);

      const changed = { ...state, [ids]: { [thread.id]: state[ids]![thread.id]!.slice() } };
      expect(getThreadFromState(changed, thread.id)).toEqual(first);
      expect(getThreadFromState(changed, thread.id)).not.toBe(first);
      const restored = getThreadFromState(state, thread.id)!;
      expect(restored).toEqual(first);
      expect(restored).not.toBe(first);
      expect(getThreadFromState(state, thread.id)).toBe(restored);

      const pending = MessageId.makeUnsafe("pending");
      const updated = getThreadFromState(
        {
          ...state,
          threadTurnStateById: {
            [thread.id]: { latestTurn: null, pendingTurnStartMessageId: pending },
          },
        },
        thread.id,
      )!;
      expect(updated.pendingTurnStartMessageId).toBe(pending);
      expect(updated[collection]).toBe(restored[collection]);
      expect(restored.pendingTurnStartMessageId).toBeUndefined();

      const evicted = evictThreadDetailFromClientState(state, thread.id);
      expect(evicted.threadShellById).toBe(state.threadShellById);
      expect(getThreadFromState(evicted, thread.id)?.[collection]).toEqual([]);
      expect(first[collection]).toEqual(details[collection]);
      expect(getThreadFromState(state, thread.id)).toEqual(first);
    },
  );
});

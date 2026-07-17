import { ThreadId } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultWorkflowRunUiThreadState,
  sanitizeWorkflowRunUiStateByThreadId,
  selectWorkflowRunUiThreadState,
  useWorkflowRunUiStore,
} from "./workflowRunUiStore";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");

describe("workflowRunUiStore", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    useWorkflowRunUiStore.setState({ stateByThreadId: {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps paused/dismissed flags scoped to the owning thread", () => {
    useWorkflowRunUiStore.getState().markPaused(THREAD_A, "task-1");
    useWorkflowRunUiStore.getState().markDismissed(THREAD_B, "task-2");

    expect(
      selectWorkflowRunUiThreadState(THREAD_A)(useWorkflowRunUiStore.getState()),
    ).toMatchObject({
      pausedByUser: ["task-1"],
      dismissed: [],
    });
    expect(
      selectWorkflowRunUiThreadState(THREAD_B)(useWorkflowRunUiStore.getState()),
    ).toMatchObject({
      pausedByUser: [],
      dismissed: ["task-2"],
    });
  });

  it("returns the default empty state for threads without tracked flags", () => {
    expect(selectWorkflowRunUiThreadState(THREAD_A)(useWorkflowRunUiStore.getState())).toEqual(
      createDefaultWorkflowRunUiThreadState(),
    );
  });

  it("returns the default empty state when threadId is null", () => {
    expect(selectWorkflowRunUiThreadState(null)(useWorkflowRunUiStore.getState())).toEqual(
      createDefaultWorkflowRunUiThreadState(),
    );
  });

  it("reuses one fallback snapshot for threads without tracked flags", () => {
    const selector = selectWorkflowRunUiThreadState(THREAD_A);

    expect(selector(useWorkflowRunUiStore.getState())).toBe(
      selector(useWorkflowRunUiStore.getState()),
    );
  });

  it("markPaused is idempotent for a repeated task id", () => {
    useWorkflowRunUiStore.getState().markPaused(THREAD_A, "task-1");
    const afterFirst = useWorkflowRunUiStore.getState().stateByThreadId[THREAD_A];
    useWorkflowRunUiStore.getState().markPaused(THREAD_A, "task-1");
    const afterSecond = useWorkflowRunUiStore.getState().stateByThreadId[THREAD_A];

    expect(afterSecond).toBe(afterFirst);
    expect(afterSecond?.pausedByUser).toEqual(["task-1"]);
  });

  it("unmarkPaused removes a paused task id", () => {
    useWorkflowRunUiStore.getState().markPaused(THREAD_A, "task-1");
    useWorkflowRunUiStore.getState().markPaused(THREAD_A, "task-2");
    useWorkflowRunUiStore.getState().unmarkPaused(THREAD_A, "task-1");

    expect(
      selectWorkflowRunUiThreadState(THREAD_A)(useWorkflowRunUiStore.getState()).pausedByUser,
    ).toEqual(["task-2"]);
  });

  it("unmarkPaused is a no-op for an unknown thread or task id", () => {
    const before = useWorkflowRunUiStore.getState();
    useWorkflowRunUiStore.getState().unmarkPaused(THREAD_A, "task-1");
    expect(useWorkflowRunUiStore.getState()).toBe(before);

    useWorkflowRunUiStore.getState().markPaused(THREAD_A, "task-1");
    const afterMark = useWorkflowRunUiStore.getState();
    useWorkflowRunUiStore.getState().unmarkPaused(THREAD_A, "unknown-task");
    expect(useWorkflowRunUiStore.getState()).toBe(afterMark);
  });

  it("clearThread drops all tracked flags for the thread", () => {
    useWorkflowRunUiStore.getState().markPaused(THREAD_A, "task-1");
    useWorkflowRunUiStore.getState().markDismissed(THREAD_A, "task-2");
    useWorkflowRunUiStore.getState().clearThread(THREAD_A);

    expect(useWorkflowRunUiStore.getState().stateByThreadId[THREAD_A]).toBeUndefined();
  });

  it("caps each list at the newest entries once it grows beyond the limit", () => {
    for (let index = 0; index < 55; index += 1) {
      useWorkflowRunUiStore.getState().markPaused(THREAD_A, `task-${index}`);
    }
    const pausedByUser =
      useWorkflowRunUiStore.getState().stateByThreadId[THREAD_A]?.pausedByUser ?? [];

    expect(pausedByUser.length).toBe(50);
    expect(pausedByUser[0]).toBe("task-5");
    expect(pausedByUser.at(-1)).toBe("task-54");
  });
});

describe("sanitizeWorkflowRunUiStateByThreadId", () => {
  it("returns an empty record for non-object input", () => {
    expect(sanitizeWorkflowRunUiStateByThreadId(undefined)).toEqual({});
    expect(sanitizeWorkflowRunUiStateByThreadId([{ pausedByUser: ["task-1"] }])).toEqual({});
  });

  it("keeps valid entries and drops malformed ones", () => {
    const result = sanitizeWorkflowRunUiStateByThreadId({
      "thread-a": { pausedByUser: ["task-1", "task-1", 42], dismissed: ["task-2"] },
      "thread-b": { pausedByUser: [], dismissed: [] },
      "thread-c": "nope",
      "thread-d": null,
    });

    expect(result["thread-a"]).toEqual({ pausedByUser: ["task-1"], dismissed: ["task-2"] });
    expect(result["thread-b"]).toBeUndefined();
    expect(result["thread-c"]).toBeUndefined();
    expect(result["thread-d"]).toBeUndefined();
  });

  it("drops the unsafe __proto__ key", () => {
    const result = sanitizeWorkflowRunUiStateByThreadId(
      JSON.parse('{"__proto__": {"pausedByUser": ["task-1"], "dismissed": []}}'),
    );
    expect(Object.hasOwn(result, "__proto__")).toBe(false);
  });
});

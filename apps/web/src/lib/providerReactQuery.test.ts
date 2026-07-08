// FILE: providerReactQuery.test.ts
// Purpose: Verifies provider query keys, RPC dispatch, and checkpoint retry behavior.
// Layer: Web data fetching tests
// Depends on: Vitest, React Query, and the native API bridge mock.

import { ThreadId, type NativeApi } from "@synara/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHECKPOINT_DIFF_PENDING_REFETCH_INTERVAL_MS,
  CHECKPOINT_DIFF_PENDING_REFETCH_MAX_ATTEMPTS,
  checkpointDiffQueryOptions,
  isCheckpointTemporarilyUnavailable,
  providerQueryKeys,
  resolveCheckpointDiffQueryDisplayState,
} from "./providerReactQuery";
import * as nativeApi from "../nativeApi";

const threadId = ThreadId.makeUnsafe("thread-id");

function mockNativeApi(input: {
  getTurnDiff: ReturnType<typeof vi.fn>;
  getFullThreadDiff: ReturnType<typeof vi.fn>;
}) {
  vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
    orchestration: {
      getTurnDiff: input.getTurnDiff,
      getFullThreadDiff: input.getFullThreadDiff,
    },
  } as unknown as NativeApi);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("providerQueryKeys.checkpointDiff", () => {
  it("includes cacheScope so reused turn counts do not collide", () => {
    const baseInput = {
      threadId,
      fromTurnCount: 1,
      toTurnCount: 2,
      ignoreWhitespace: true,
    } as const;

    expect(
      providerQueryKeys.checkpointDiff({
        ...baseInput,
        cacheScope: "turn:old-turn",
      }),
    ).not.toEqual(
      providerQueryKeys.checkpointDiff({
        ...baseInput,
        cacheScope: "turn:new-turn",
      }),
    );
  });

  it("includes ignoreWhitespace so whitespace modes do not collide", () => {
    const baseInput = {
      threadId,
      fromTurnCount: 1,
      toTurnCount: 2,
      cacheScope: "turn:abc",
    } as const;

    expect(
      providerQueryKeys.checkpointDiff({
        ...baseInput,
        ignoreWhitespace: true,
      }),
    ).not.toEqual(
      providerQueryKeys.checkpointDiff({
        ...baseInput,
        ignoreWhitespace: false,
      }),
    );
  });
});

describe("checkpointDiffQueryOptions", () => {
  it("forwards checkpoint range to the provider API", async () => {
    const getTurnDiff = vi.fn().mockResolvedValue({ diff: "patch" });
    const getFullThreadDiff = vi.fn().mockResolvedValue({ diff: "patch" });
    mockNativeApi({ getTurnDiff, getFullThreadDiff });

    const options = checkpointDiffQueryOptions({
      threadId,
      fromTurnCount: 3,
      toTurnCount: 4,
      ignoreWhitespace: true,
      cacheScope: "turn:abc",
    });

    const queryClient = new QueryClient();
    await queryClient.fetchQuery(options);

    expect(getTurnDiff).toHaveBeenCalledWith({
      threadId,
      fromTurnCount: 3,
      toTurnCount: 4,
      ignoreWhitespace: true,
    });
    expect(getFullThreadDiff).not.toHaveBeenCalled();
  });

  it("uses full thread diff API only for conversation-wide ranges from zero", async () => {
    const getTurnDiff = vi.fn().mockResolvedValue({ diff: "patch" });
    const getFullThreadDiff = vi.fn().mockResolvedValue({ diff: "patch" });
    mockNativeApi({ getTurnDiff, getFullThreadDiff });

    const options = checkpointDiffQueryOptions({
      threadId,
      fromTurnCount: 0,
      toTurnCount: 2,
      ignoreWhitespace: false,
      cacheScope: "conversation:turn-a,turn-b",
    });

    const queryClient = new QueryClient();
    await queryClient.fetchQuery(options);

    expect(getFullThreadDiff).toHaveBeenCalledWith({
      threadId,
      toTurnCount: 2,
      ignoreWhitespace: false,
    });
    expect(getTurnDiff).not.toHaveBeenCalled();
  });

  it("uses turn diff API for single-turn ranges that start from zero", async () => {
    const getTurnDiff = vi.fn().mockResolvedValue({ diff: "patch" });
    const getFullThreadDiff = vi.fn().mockResolvedValue({ diff: "patch" });
    mockNativeApi({ getTurnDiff, getFullThreadDiff });

    const options = checkpointDiffQueryOptions({
      threadId,
      fromTurnCount: 0,
      toTurnCount: 1,
      ignoreWhitespace: true,
      cacheScope: "turn:turn-1",
    });

    const queryClient = new QueryClient();
    await queryClient.fetchQuery(options);

    expect(getTurnDiff).toHaveBeenCalledWith({
      threadId,
      fromTurnCount: 0,
      toTurnCount: 1,
      ignoreWhitespace: true,
    });
    expect(getFullThreadDiff).not.toHaveBeenCalled();
  });

  it("fails fast on invalid range and does not call provider RPC", async () => {
    const getTurnDiff = vi.fn().mockResolvedValue({ diff: "patch" });
    const getFullThreadDiff = vi.fn().mockResolvedValue({ diff: "patch" });
    mockNativeApi({ getTurnDiff, getFullThreadDiff });

    const options = checkpointDiffQueryOptions({
      threadId,
      fromTurnCount: 4,
      toTurnCount: 3,
      ignoreWhitespace: true,
      cacheScope: "turn:invalid",
    });

    const queryClient = new QueryClient();

    await expect(queryClient.fetchQuery(options)).rejects.toThrow(
      "Checkpoint diff is unavailable.",
    );
    expect(getTurnDiff).not.toHaveBeenCalled();
    expect(getFullThreadDiff).not.toHaveBeenCalled();
  });

  it("retries checkpoint-not-ready errors longer than generic failures", () => {
    const options = checkpointDiffQueryOptions({
      threadId,
      fromTurnCount: 1,
      toTurnCount: 2,
      ignoreWhitespace: true,
      cacheScope: "turn:abc",
    });
    const retry = options.retry;
    expect(typeof retry).toBe("function");
    if (typeof retry !== "function") {
      throw new Error("Expected retry to be a function.");
    }

    expect(retry(1, new Error("Checkpoint turn count 2 exceeds current turn count 1."))).toBe(true);
    expect(retry(11, new Error("Checkpoint diff is not available yet for turn 2."))).toBe(true);
    expect(retry(12, new Error("Checkpoint diff is not available yet for turn 2."))).toBe(false);
    expect(
      retry(3, new Error("Filesystem checkpoint is unavailable for turn 2 in thread thread-1.")),
    ).toBe(false);
    expect(retry(2, new Error("Something else failed."))).toBe(true);
    expect(retry(3, new Error("Something else failed."))).toBe(false);
  });

  it("backs off longer for checkpoint-not-ready errors", () => {
    const options = checkpointDiffQueryOptions({
      threadId,
      fromTurnCount: 1,
      toTurnCount: 2,
      ignoreWhitespace: true,
      cacheScope: "turn:abc",
    });
    const retryDelay = options.retryDelay;
    expect(typeof retryDelay).toBe("function");
    if (typeof retryDelay !== "function") {
      throw new Error("Expected retryDelay to be a function.");
    }

    const checkpointDelay = retryDelay(
      4,
      new Error("Checkpoint turn count 2 exceeds current turn count 1."),
    );
    const genericDelay = retryDelay(4, new Error("Network failure"));

    expect(typeof checkpointDelay).toBe("number");
    expect(typeof genericDelay).toBe("number");
    expect((checkpointDelay ?? 0) > (genericDelay ?? 0)).toBe(true);
  });

  it("keeps polling while checkpoint diffs are still materializing", () => {
    const options = checkpointDiffQueryOptions({
      threadId,
      fromTurnCount: 1,
      toTurnCount: 2,
      ignoreWhitespace: true,
      cacheScope: "turn:abc",
    });
    const refetchInterval = options.refetchInterval;
    expect(typeof refetchInterval).toBe("function");
    if (typeof refetchInterval !== "function") {
      throw new Error("Expected refetchInterval to be a function.");
    }

    expect(
      refetchInterval({
        state: { error: new Error("Checkpoint diff is not available yet for turn 1.") },
      } as never),
    ).toBe(CHECKPOINT_DIFF_PENDING_REFETCH_INTERVAL_MS);
    expect(refetchInterval({ state: { error: new Error("Permanent failure.") } } as never)).toBe(
      false,
    );
    expect(
      refetchInterval({
        state: {
          error: new Error("Checkpoint diff is not available yet for turn 1."),
          errorUpdateCount: CHECKPOINT_DIFF_PENDING_REFETCH_MAX_ATTEMPTS,
        },
      } as never),
    ).toBe(false);
  });
});

describe("resolveCheckpointDiffQueryDisplayState", () => {
  it("shows loading instead of an error while retries are in flight", () => {
    const pendingError = new Error("Checkpoint diff is not available yet for turn 1.");

    expect(
      resolveCheckpointDiffQueryDisplayState({
        isLoading: false,
        isFetching: true,
        data: undefined,
        error: pendingError,
      }),
    ).toEqual({
      isLoading: true,
      error: null,
    });
  });

  it("surfaces the normalized error once fetching stops", () => {
    expect(
      resolveCheckpointDiffQueryDisplayState({
        isLoading: false,
        isFetching: false,
        data: undefined,
        error: new Error("Checkpoint diff is not available yet for turn 1."),
      }),
    ).toEqual({
      isLoading: false,
      error: "Checkpoint diff is not available yet for turn 1.",
    });
  });
});

describe("isCheckpointTemporarilyUnavailable", () => {
  it("recognizes placeholder checkpoint errors", () => {
    expect(
      isCheckpointTemporarilyUnavailable(
        new Error("Checkpoint diff is not available yet for turn 1."),
      ),
    ).toBe(true);
    expect(
      isCheckpointTemporarilyUnavailable(new Error("Filesystem checkpoint is unavailable.")),
    ).toBe(false);
  });
});

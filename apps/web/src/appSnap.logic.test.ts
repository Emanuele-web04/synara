import { ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  APPSNAP_RECENT_TARGET_WINDOW_MS,
  createLatestAppSnapRequestGuard,
  hasPersistedAppSnapCapture,
  resolveAppSnapTarget,
} from "./appSnap.logic";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");
const available = (threadId: ThreadId) => threadId === THREAD_A || threadId === THREAD_B;

describe("createLatestAppSnapRequestGuard", () => {
  it("invalidates an older async toggle when a newer request begins", () => {
    const guard = createLatestAppSnapRequestGuard();
    const enableRequest = guard.begin();
    const disableRequest = guard.begin();

    expect(guard.isCurrent(enableRequest)).toBe(false);
    expect(guard.isCurrent(disableRequest)).toBe(true);
  });
});

describe("resolveAppSnapTarget", () => {
  it("uses a task interacted with during the last 60 seconds", () => {
    expect(
      resolveAppSnapTarget({
        captureAtMs: 100_000,
        lastInteraction: { threadId: THREAD_A, splitViewId: "split-a", atMs: 50_000 },
        lastAppSnap: null,
        isThreadAvailable: available,
      }),
    ).toEqual({
      kind: "existing",
      target: { threadId: THREAD_A, splitViewId: "split-a" },
    });
  });

  it("keeps consecutive AppSnaps on their previous target", () => {
    expect(
      resolveAppSnapTarget({
        captureAtMs: 100_000,
        lastInteraction: null,
        lastAppSnap: { threadId: THREAD_B, atMs: 90_000 },
        isThreadAvailable: available,
      }),
    ).toEqual({ kind: "existing", target: { threadId: THREAD_B } });
  });

  it("starts a fresh task after the recent window expires", () => {
    expect(
      resolveAppSnapTarget({
        captureAtMs: 100_000,
        lastInteraction: {
          threadId: THREAD_A,
          atMs: 100_000 - APPSNAP_RECENT_TARGET_WINDOW_MS - 1,
        },
        lastAppSnap: null,
        isThreadAvailable: available,
      }),
    ).toEqual({ kind: "fresh" });
  });

  it("does not revive a deleted recent task", () => {
    expect(
      resolveAppSnapTarget({
        captureAtMs: 100_000,
        lastInteraction: { threadId: THREAD_A, atMs: 99_000 },
        lastAppSnap: { threadId: THREAD_B, atMs: 98_000 },
        isThreadAvailable: () => false,
      }),
    ).toEqual({ kind: "fresh" });
  });

  it("lets newer explicit interaction override AppSnap affinity", () => {
    expect(
      resolveAppSnapTarget({
        captureAtMs: 100_000,
        lastInteraction: { threadId: THREAD_B, atMs: 99_800 },
        lastAppSnap: { threadId: THREAD_A, atMs: 99_500 },
        isThreadAvailable: available,
      }),
    ).toEqual({ kind: "existing", target: { threadId: THREAD_B } });
  });

  it("keeps a newer AppSnap affinity over older task interaction", () => {
    expect(
      resolveAppSnapTarget({
        captureAtMs: 100_000,
        lastInteraction: { threadId: THREAD_B, atMs: 99_000 },
        lastAppSnap: { threadId: THREAD_A, atMs: 99_500 },
        isThreadAvailable: available,
      }),
    ).toEqual({ kind: "existing", target: { threadId: THREAD_A } });
  });
});

describe("hasPersistedAppSnapCapture", () => {
  it("finds a capture persisted before native acknowledgement", () => {
    expect(
      hasPersistedAppSnapCapture(
        [
          {
            persistedAttachments: [
              {
                source: {
                  kind: "appsnap",
                  captureId: "capture-replayed",
                },
              },
            ],
            promptHistorySavedDraft: null,
          },
        ],
        "capture-replayed",
      ),
    ).toBe(true);
  });

  it("checks prompt-history snapshots and ignores other captures", () => {
    const drafts = [
      {
        persistedAttachments: [],
        promptHistorySavedDraft: {
          persistedAttachments: [{ source: { kind: "appsnap", captureId: "capture-saved" } }],
        },
      },
    ];

    expect(hasPersistedAppSnapCapture(drafts, "capture-saved")).toBe(true);
    expect(hasPersistedAppSnapCapture(drafts, "capture-other")).toBe(false);
  });

  it("returns false when durable capture metadata is absent", () => {
    expect(
      hasPersistedAppSnapCapture(
        [
          {
            persistedAttachments: [],
            promptHistorySavedDraft: null,
          },
        ],
        "capture-live-only",
      ),
    ).toBe(false);
  });
});

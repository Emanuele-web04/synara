import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { resolveDisposableThreadIdToDispose } from "./disposableThread";

const PROJECT_ID = ProjectId.makeUnsafe("project-disposable");
const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");

describe("resolveDisposableThreadIdToDispose", () => {
  it("returns null when the focused thread does not change", () => {
    expect(
      resolveDisposableThreadIdToDispose({
        previousThreadId: THREAD_A,
        nextThreadId: THREAD_A,
        draftThreadsByThreadId: {
          [THREAD_A]: {
            projectId: PROJECT_ID,
            createdAt: "2026-04-07T10:00:00.000Z",
            runtimeMode: "full-access",
            interactionMode: "default",
            entryPoint: "chat",
            branch: null,
            worktreePath: null,
            envMode: "local",
            isTemporary: true,
          },
        },
      }),
    ).toBeNull();
  });

  it("returns null when previous thread is not temporary", () => {
    expect(
      resolveDisposableThreadIdToDispose({
        previousThreadId: THREAD_A,
        nextThreadId: THREAD_B,
        draftThreadsByThreadId: {
          [THREAD_A]: {
            projectId: PROJECT_ID,
            createdAt: "2026-04-07T10:00:00.000Z",
            runtimeMode: "full-access",
            interactionMode: "default",
            entryPoint: "chat",
            branch: null,
            worktreePath: null,
            envMode: "local",
          },
        },
      }),
    ).toBeNull();
  });

  it("returns the previous thread when it is temporary and focus moves away", () => {
    expect(
      resolveDisposableThreadIdToDispose({
        previousThreadId: THREAD_A,
        nextThreadId: THREAD_B,
        draftThreadsByThreadId: {
          [THREAD_A]: {
            projectId: PROJECT_ID,
            createdAt: "2026-04-07T10:00:00.000Z",
            runtimeMode: "full-access",
            interactionMode: "default",
            entryPoint: "chat",
            branch: null,
            worktreePath: null,
            envMode: "local",
            isTemporary: true,
          },
        },
      }),
    ).toBe(THREAD_A);
  });

  it("uses the captured previous temporary flag when draft metadata was already cleared", () => {
    expect(
      resolveDisposableThreadIdToDispose({
        previousThreadId: THREAD_A,
        nextThreadId: THREAD_B,
        previousThreadWasTemporary: true,
        draftThreadsByThreadId: {},
      }),
    ).toBe(THREAD_A);
  });
});

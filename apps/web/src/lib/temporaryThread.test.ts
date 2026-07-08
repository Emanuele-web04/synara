// FILE: temporaryThread.test.ts
// Purpose: Verifies focus-switch cleanup decisions for temporary threads.
// Layer: Web route/domain helper tests

import { ProjectId, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { resolveTemporaryThreadIdToDelete } from "./temporaryThread";

const PROJECT_ID = ProjectId.makeUnsafe("project-temporary");
const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");

describe("resolveTemporaryThreadIdToDelete", () => {
  it("returns null when the focused thread does not change", () => {
    expect(
      resolveTemporaryThreadIdToDelete({
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
      resolveTemporaryThreadIdToDelete({
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
      resolveTemporaryThreadIdToDelete({
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
      resolveTemporaryThreadIdToDelete({
        previousThreadId: THREAD_A,
        nextThreadId: THREAD_B,
        previousThreadWasTemporary: true,
        draftThreadsByThreadId: {},
      }),
    ).toBe(THREAD_A);
  });
});

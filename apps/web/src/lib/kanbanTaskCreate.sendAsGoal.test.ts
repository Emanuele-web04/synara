// FILE: kanbanTaskCreate.sendAsGoal.test.ts
// Purpose: Verifies create-and-send routes through the goal dispatch variant only
//          when the dialog's "send as goal" toggle is on (default off).
// Layer: Web Kanban lib tests

import { ProjectId } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  dispatch: vi.fn(),
  dispatchAsGoal: vi.fn(),
}));

vi.mock("./kanbanDispatch", () => ({
  dispatchKanbanDraftThread: harness.dispatch,
  dispatchKanbanDraftThreadAsGoal: harness.dispatchAsGoal,
}));

vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => ({
      registerDraftThread: vi.fn(),
      copyTransferableComposerState: vi.fn(),
      setPrompt: vi.fn(),
      setModelSelection: vi.fn(),
      setRuntimeMode: vi.fn(),
      setInteractionMode: vi.fn(),
    }),
  },
}));

import { createAndSendKanbanTask } from "./kanbanTaskCreate";

const BASE_INPUT = {
  projectId: ProjectId.makeUnsafe("project-kanban-goal"),
  prompt: "Ship the kanban v2 goal flow",
  modelSelection: { provider: "codex", model: "gpt-5.4" },
  runtimeMode: "approval-required",
  interactionMode: "debug",
  envMode: "local",
  defaultProvider: "codex",
  assistantDeliveryMode: "buffered",
} as const;

beforeEach(() => {
  harness.dispatch.mockReset();
  harness.dispatchAsGoal.mockReset();
  harness.dispatch.mockResolvedValue({ kind: "dispatched" });
  harness.dispatchAsGoal.mockResolvedValue({ kind: "dispatched" });
});

describe("createAndSendKanbanTask send-as-goal routing", () => {
  it("uses plain dispatch by default", async () => {
    const { result } = await createAndSendKanbanTask({ ...BASE_INPUT });

    expect(result).toEqual({ kind: "dispatched" });
    expect(harness.dispatch).toHaveBeenCalledTimes(1);
    expect(harness.dispatchAsGoal).not.toHaveBeenCalled();
    expect(harness.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: BASE_INPUT.projectId,
        thread: null,
        defaultProvider: "codex",
        assistantDeliveryMode: "buffered",
      }),
    );
  });

  it("routes through the goal dispatch variant when sendAsGoal is true", async () => {
    const { threadId, result } = await createAndSendKanbanTask({
      ...BASE_INPUT,
      sendAsGoal: true,
    });

    expect(result).toEqual({ kind: "dispatched" });
    expect(harness.dispatchAsGoal).toHaveBeenCalledTimes(1);
    expect(harness.dispatch).not.toHaveBeenCalled();
    expect(harness.dispatchAsGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId,
        projectId: BASE_INPUT.projectId,
        thread: null,
      }),
    );
  });
});

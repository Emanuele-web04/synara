// FILE: projectDelete.test.ts
// Purpose: Verifies project deletion reconciles local state only after server acceptance.

import { ProjectId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import { deleteProjectFromClient } from "./projectDelete";

describe("deleteProjectFromClient", () => {
  it("reconciles local state after the delete command succeeds", async () => {
    const projectId = ProjectId.makeUnsafe("project-delete");
    const order: string[] = [];
    const dispatchCommand = vi.fn(async () => {
      order.push("dispatch");
      return { sequence: 12 };
    });
    const removeDeletedProjectFromClientState = vi.fn(() => {
      order.push("remove");
    });

    await deleteProjectFromClient({
      api: { dispatchCommand },
      projectId,
      removeDeletedProjectFromClientState,
    });

    expect(dispatchCommand).toHaveBeenCalledWith({
      type: "project.delete",
      commandId: expect.any(String),
      projectId,
    });
    expect(removeDeletedProjectFromClientState).toHaveBeenCalledWith(projectId);
    expect(order).toEqual(["dispatch", "remove"]);
  });

  it("keeps local state when the delete command fails", async () => {
    const projectId = ProjectId.makeUnsafe("project-delete-failed");
    const dispatchCommand = vi.fn(async () => {
      throw new Error("delete rejected");
    });
    const removeDeletedProjectFromClientState = vi.fn();

    await expect(
      deleteProjectFromClient({
        api: { dispatchCommand },
        projectId,
        removeDeletedProjectFromClientState,
      }),
    ).rejects.toThrow("delete rejected");

    expect(removeDeletedProjectFromClientState).not.toHaveBeenCalled();
  });
});

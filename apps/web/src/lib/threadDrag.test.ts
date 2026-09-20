import { ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  isThreadDragTransfer,
  readThreadDragPayload,
  resolveSidebarFolderDropTarget,
  THREAD_DRAG_MIME,
} from "./threadDrag";

function dataTransfer(input: { types?: string[]; payload?: string }) {
  return {
    types: input.types ?? [],
    getData: (type: string) => (type === THREAD_DRAG_MIME ? (input.payload ?? "") : ""),
  } as Pick<DataTransfer, "getData" | "types">;
}

describe("threadDrag", () => {
  it("recognizes only the Synara thread MIME type", () => {
    expect(isThreadDragTransfer(dataTransfer({ types: [THREAD_DRAG_MIME] }))).toBe(true);
    expect(isThreadDragTransfer(dataTransfer({ types: ["Files"] }))).toBe(false);
  });

  it("parses a valid thread payload", () => {
    expect(
      readThreadDragPayload(dataTransfer({ payload: JSON.stringify({ threadId: "thread-a" }) })),
    ).toEqual({ threadId: ThreadId.makeUnsafe("thread-a") });
  });

  it("rejects malformed and empty payloads", () => {
    expect(readThreadDragPayload(dataTransfer({ payload: "{" }))).toBeNull();
    expect(readThreadDragPayload(dataTransfer({ payload: JSON.stringify({ threadId: "" }) }))).toBeNull();
  });

  it("treats the folder's left gutter as the project root", () => {
    expect(
      resolveSidebarFolderDropTarget({ clientX: 118, containerLeft: 100, folderId: "folder-a" }),
    ).toBeNull();
    expect(
      resolveSidebarFolderDropTarget({ clientX: 121, containerLeft: 100, folderId: "folder-a" }),
    ).toBe("folder-a");
  });
});

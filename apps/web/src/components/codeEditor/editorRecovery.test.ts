import { QueryClient } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";

const { flush, unsaved } = vi.hoisted(() => ({ flush: vi.fn(), unsaved: vi.fn() }));
vi.mock("~/lib/workspaceEditorSession", () => ({
  flushWorkspaceEditors: flush,
  hasUnsavedWorkspaceEditors: unsaved,
}));
import { reloadEditorAfterSave } from "./editorRecovery";

beforeEach(() => {
  flush.mockReset().mockResolvedValue(true);
  unsaved.mockReset().mockReturnValue(false);
});

it("waits for all native buffers to save before requesting a fresh document", async () => {
  const client = new QueryClient();
  let saved!: (value: boolean) => void;
  flush.mockReturnValue(
    new Promise<boolean>((resolve) => {
      saved = resolve;
    }),
  );
  const reload = vi.fn();
  const recovery = reloadEditorAfterSave(client, reload);
  expect(flush).toHaveBeenCalledWith(client);
  expect(reload).not.toHaveBeenCalled();
  saved(true);
  await recovery;
  expect(reload).toHaveBeenCalledOnce();
});

it.each(["failed write", "new unsaved buffer", "rejected write"])(
  "retains the document and draft after a %s",
  async (failure) => {
    if (failure === "failed write") flush.mockResolvedValue(false);
    if (failure === "new unsaved buffer") unsaved.mockReturnValue(true);
    if (failure === "rejected write") flush.mockRejectedValue(new Error("write failed"));
    const reload = vi.fn();
    await expect(reloadEditorAfterSave(new QueryClient(), reload)).rejects.toThrow();
    expect(reload).not.toHaveBeenCalled();
  },
);

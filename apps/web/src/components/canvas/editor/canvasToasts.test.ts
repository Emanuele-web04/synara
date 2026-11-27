import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toasts = vi.hoisted(() => ({
  add: vi.fn((_toast: unknown) => "toast1"),
  update: vi.fn(),
  close: vi.fn(),
}));
vi.mock("../../ui/toast", () => ({ toastManager: toasts }));

import { DEFAULT_TOAST_TIMEOUT_MS } from "../../ui/toast.logic";
import { useCanvasEditorStore } from "../canvasStores";
import { CANVAS_JOB_TOAST_DELAY_MS, runCanvasJob, showHiddenCanvasComments } from "./canvasToasts";

const outcome = {
  success: (files: number) => `Exported ${files} files`,
  failure: (cause: unknown) => ({ title: "Export failed", description: String(cause) }),
};
/** A job that settles when told to. */
function deferred() {
  let settle!: { resolve: (value: number) => void; reject: (cause: unknown) => void };
  const promise = new Promise<number>((resolve, reject) => (settle = { resolve, reject }));
  return { job: () => promise, ...settle };
}

describe("runCanvasJob", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const mock of Object.values(toasts)) mock.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("shows the loading toast for a long job and turns it into the success toast", async () => {
    const { job, resolve } = deferred();
    const run = runCanvasJob("Exporting…", job, outcome);
    await vi.advanceTimersByTimeAsync(CANVAS_JOB_TOAST_DELAY_MS);
    expect(toasts.add).toHaveBeenCalledWith({ type: "loading", title: "Exporting…", timeout: 0 });
    resolve(2);
    await expect(run).resolves.toBe(2);
    expect(toasts.update).toHaveBeenCalledWith("toast1", {
      type: "success",
      title: "Exported 2 files",
      timeout: DEFAULT_TOAST_TIMEOUT_MS,
    });
    expect(toasts.add).toHaveBeenCalledTimes(1);
  });

  it("turns the loading toast into the error toast when the job fails", async () => {
    const { job, reject } = deferred();
    const run = runCanvasJob("Exporting…", job, outcome);
    await vi.advanceTimersByTimeAsync(CANVAS_JOB_TOAST_DELAY_MS);
    reject("disk full");
    await expect(run).resolves.toBeNull();
    expect(toasts.update).toHaveBeenCalledWith("toast1", {
      type: "error",
      title: "Export failed",
      description: "disk full",
      timeout: DEFAULT_TOAST_TIMEOUT_MS,
    });
  });

  it("shows only the outcome of a quick job, and closes the toast when there is none", async () => {
    await expect(runCanvasJob("Exporting…", async () => 1, outcome)).resolves.toBe(1);
    await vi.advanceTimersByTimeAsync(CANVAS_JOB_TOAST_DELAY_MS * 2);
    expect(toasts.add).toHaveBeenCalledTimes(1);
    expect(toasts.add).toHaveBeenCalledWith({ type: "success", title: "Exported 1 files" });

    const { job, resolve } = deferred();
    const run = runCanvasJob("Adding image…", job, { failure: outcome.failure });
    await vi.advanceTimersByTimeAsync(CANVAS_JOB_TOAST_DELAY_MS);
    resolve(0);
    await run;
    expect(toasts.close).toHaveBeenCalledWith("toast1");
    expect(toasts.update).not.toHaveBeenCalled();
  });
});

describe("showHiddenCanvasComments", () => {
  beforeEach(() => toasts.add.mockClear());

  it("shows comments hidden with ⇧C, with the toast ⇧C shows, and does nothing otherwise", () => {
    const t = ((key: string) => key) as never;
    useCanvasEditorStore.setState({ commentsHidden: false });
    showHiddenCanvasComments(t);
    expect(toasts.add).not.toHaveBeenCalled();
    useCanvasEditorStore.setState({ commentsHidden: true });
    showHiddenCanvasComments(t);
    expect(useCanvasEditorStore.getState().commentsHidden).toBe(false);
    expect(toasts.add).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "workspace:canvasToastCommentsShown" }),
    );
  });
});

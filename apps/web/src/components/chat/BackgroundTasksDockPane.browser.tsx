import "../../index.css";
import { ThreadId } from "@synara/contracts";
import { page } from "vitest/browser";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { WorkLogBackgroundTask } from "../../workLog";
import { toastManager } from "../ui/toast";
import { BackgroundTasksDockPane } from "./BackgroundTasksDockPane";

const state = vi.hoisted(() => ({
  dispatch: vi.fn(async (_input: unknown) => {}),
  tasks: [] as WorkLogBackgroundTask[],
}));
vi.mock("../../nativeApi", () => ({
  readNativeApi: () => ({ orchestration: { dispatchCommand: state.dispatch } }),
}));
vi.mock("./useThreadBackgroundTasks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useThreadBackgroundTasks")>()),
  useThreadBackgroundTasks: () => state.tasks,
}));

const thread = ThreadId.makeUnsafe("thread");
const devServer: WorkLogBackgroundTask = {
  taskId: "task-dev",
  taskType: "local_bash",
  description: null,
  command: "env -u SYNARA_AUTH_TOKEN SYNARA_PORT=3947 bun run dev:server",
  status: "running",
  startedAt: "2026-10-10T00:00:00.000Z",
  completedAt: null,
  exitCode: null,
};
const failedServer: WorkLogBackgroundTask = {
  ...devServer,
  taskId: "task-old",
  command: "env SYNARA_PORT=3899 bun run dev:server",
  status: "failed",
  completedAt: "2026-10-10T00:00:01.000Z",
  exitCode: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  state.tasks = [failedServer, devServer];
});

it("offers Stop only for running tasks and stops that task", async () => {
  const screen = await render(<BackgroundTasksDockPane hostThreadId={thread} />);
  try {
    await expect.element(page.getByText("failed · exit 1", { exact: true })).toBeVisible();
    const stop = page.getByRole("button", { name: /^Stop background task/ });
    expect(stop.elements()).toHaveLength(1);

    await page.getByText("running", { exact: true }).hover();
    await stop.click();
    expect(state.dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: "thread.task.stop", threadId: thread, taskId: "task-dev" }),
    );
  } finally {
    await screen.unmount();
  }
});

it("reports a rejected stop instead of leaving the task silently running", async () => {
  state.dispatch.mockRejectedValueOnce(new Error("Provider disconnected"));
  const feedback = vi.spyOn(toastManager, "add");
  const screen = await render(<BackgroundTasksDockPane hostThreadId={thread} />);
  try {
    await page.getByText("running", { exact: true }).hover();
    await page.getByRole("button", { name: /^Stop background task/ }).click();
    await expect.poll(() => feedback.mock.calls.length).toBe(1);
    expect(feedback.mock.calls[0]?.[0]).toMatchObject({
      type: "error",
      description: "Provider disconnected",
    });
  } finally {
    feedback.mockRestore();
    await screen.unmount();
  }
});

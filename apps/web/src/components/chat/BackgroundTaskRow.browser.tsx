import "../../index.css";

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import type { WorkLogBackgroundTask } from "../../workLog";
import { BackgroundTaskRow, BackgroundTaskStopContext } from "./BackgroundTaskRow";

const task: WorkLogBackgroundTask = {
  taskId: "background-build",
  taskType: "command",
  description: "Build the application",
  command: "bun run build",
  status: "running",
  startedAt: "2026-10-10T00:00:00.000Z",
  completedAt: null,
  exitCode: null,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T00:00:12.000Z"));
});

afterEach(async () => {
  await cleanup();
  vi.useRealTimers();
});

it("keeps the running state readable without adding visible text to a read-only row", async () => {
  const screen = await render(<BackgroundTaskRow task={task} fontSizePx={13} />);
  const status = screen.getByText("running", { exact: true }).element();
  const style = getComputedStyle(status);

  // Visually hidden text remains in the accessibility tree; the decorative
  // spinner's aria-hidden container must not hide this label too.
  expect(status.closest('[aria-hidden="true"], [hidden], [inert]')).toBeNull();
  expect(style.display).not.toBe("none");
  expect(style.visibility).toBe("visible");
  expect(status.getBoundingClientRect().width).toBeLessThanOrEqual(1);
  await expect.element(screen.getByText("12s", { exact: true })).toBeVisible();
  expect(screen.container.querySelector("button")).toBeNull();
});

it.each([
  ["finished", null, "finished"],
  ["failed", 1, "failed · exit 1"],
  ["stopped", null, "stopped"],
] as const)(
  "keeps Stop reachable and shows the %s outcome in place",
  async (outcome, exitCode, label) => {
    const onStop = vi.fn();
    const row = (current: WorkLogBackgroundTask) => (
      <BackgroundTaskStopContext.Provider value={onStop}>
        <BackgroundTaskRow task={current} fontSizePx={13} />
      </BackgroundTaskStopContext.Provider>
    );
    const screen = await render(row(task));
    const stop = screen.getByRole("button", { name: "Stop background task bun run build" });
    await expect.element(stop).toBeVisible();
    await stop.click();
    expect(onStop).toHaveBeenCalledExactlyOnceWith(task.taskId);

    await screen.rerender(
      row({
        ...task,
        status: outcome,
        completedAt: "2026-10-10T00:00:20.000Z",
        exitCode,
      }),
    );
    const status = screen.getByText(label, { exact: true });
    await expect.element(status).toBeVisible();
    expect(status.element().getBoundingClientRect().width).toBeGreaterThan(1);
    expect(screen.container.textContent).not.toContain("running");
    expect(screen.container.querySelector("button")).toBeNull();
    await expect.element(screen.getByText("20s", { exact: true })).toBeVisible();
  },
);

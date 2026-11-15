import "../../index.css";

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import type { WorkLogBackgroundTask } from "../../workLog";
import { BackgroundTaskRow } from "./BackgroundTaskRow";

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

// Live time and Stop belong to the Environment panel and the right-dock list;
// the transcript row never ticks or offers controls.
it("shows a running task as a static row without a clock or Stop", async () => {
  const screen = await render(<BackgroundTaskRow task={task} fontSizePx={13} />);
  const status = screen.getByText("running", { exact: true });
  await expect.element(status).toBeVisible();
  expect(status.element().getBoundingClientRect().width).toBeGreaterThan(1);
  expect(screen.container.textContent).not.toContain("12s");
  expect(screen.container.querySelector("button")).toBeNull();
});

it.each([
  ["finished", null, "finished"],
  ["failed", 1, "failed · exit 1"],
  ["stopped", null, "stopped"],
] as const)(
  "settles the same row in place with the %s outcome",
  async (outcome, exitCode, label) => {
    const screen = await render(<BackgroundTaskRow task={task} fontSizePx={13} />);
    const row = screen.container.querySelector("[data-background-task='background-build']");

    await screen.rerender(
      <BackgroundTaskRow
        task={{ ...task, status: outcome, completedAt: "2026-10-10T00:00:20.000Z", exitCode }}
        fontSizePx={13}
      />,
    );
    expect(screen.container.querySelector("[data-background-task='background-build']")).toBe(row);
    await expect.element(screen.getByText(label, { exact: true })).toBeVisible();
    await expect.element(screen.getByText("20s", { exact: true })).toBeVisible();
    expect(screen.container.textContent).not.toContain("running");
    expect(screen.container.querySelector("button")).toBeNull();
  },
);

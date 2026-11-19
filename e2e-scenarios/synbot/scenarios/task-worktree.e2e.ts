import { ENGINE, expect, test } from "./synbot.ts";

test("A delegated bot starts a task in a worktree and SynBot reports when it ends", async ({
  synbot,
  screen,
  browser,
  app,
}) => {
  const builder = await synbot.bot({ name: `Builder ${Date.now() % 100000}` });
  synbot.script({
    rules: [
      { match: "SynBot report for work you delegated", steps: [{ say: "Recap: TASK-1 shipped." }] },
      // The worker thread the builder started.
      {
        match: "Synara Hub delegation.*TASK-1 worker brief",
        steps: [{ say: "Worker: TASK-1 implemented in the worktree." }],
      },
      // The builder's wake turns after its worker finishes.
      {
        match: `You are ${builder.name}, a SynBot bot.*Watch this hub`,
        steps: [{ say: "SILENT" }],
      },
      {
        match: `You are ${builder.name}, a SynBot bot.*SynBot delegation`,
        steps: [
          {
            tool: "synara_create_threads",
            args: {
              requestId: "task-1",
              threads: [
                {
                  prompt: "TASK-1 worker brief: add a line to README.",
                  target: ENGINE,
                  title: "TASK-1 README line",
                  projectId: synbot.projectId,
                },
              ],
            },
          },
          { say: "Builder started a task for TASK-1." },
        ],
      },
      {
        match: "You are SynBot, the main SynBot bot.*TASK-1",
        steps: [
          {
            tool: "synara_bot_delegate",
            args: { botId: builder.id, brief: "Ship TASK-1.", requestId: "task-1-deleg" },
          },
          { say: "Handed TASK-1 to Builder." },
        ],
      },
    ],
    fallback: [{ say: "SILENT" }],
  });

  await synbot.open();
  await synbot.send("TASK-1 please build it");

  const [created] = await synbot.waitForLog(
    (e) => e.event === "tool_result" && e.tool === "synara_create_threads",
    { timeoutMs: 60_000 },
  );
  expect(created!.failed, JSON.stringify(created!.result)).toBe(false);

  const [worker] = await synbot.waitForLog(
    (e) => e.event === "prompt" && (e.text ?? "").includes("TASK-1 worker brief"),
    { timeoutMs: 90_000 },
  );
  // The task ran in its own worktree, not in the demo checkout.
  expect(worker!.cwd).toContain("worktrees");

  await synbot.open(builder);
  const task = browser.locator("article.task-card").last();
  await expect(task).toBeVisible({ timeout: 60_000 });
  await app.screenshot("builder-task-card");

  // After the worker settles, the 60 s grace window ends and SynBot gets one report.
  await synbot.open();
  await expect(screen.getByText("Recap: TASK-1 shipped.").last()).toBeVisible({
    timeout: 180_000,
  });
  await expect(browser.locator("article.report").last()).toContainText("All done");
  await app.screenshot("task-report");
});

// A task's checklist updates live on its card: the worker reports its steps through the real
// `synara_hub_update_progress` gateway tool, and the bot's chat shows them as they change.
import { ENGINE, expect, test } from "./synbot.ts";

const progress = (revision: number, statuses: readonly string[], summary: string) => ({
  tool: "synara_hub_update_progress",
  args: {
    workItemId: "{{match.1}}",
    expectedRevision: revision,
    summary,
    steps: ["Read the code", "Write the change", "Run the tests"].map((text, index) => ({
      id: `step-${index + 1}`,
      text,
      status: statuses[index],
    })),
  },
});

test("A task's steps show live on its card while the worker reports them", async ({
  synbot,
  browser,
  app,
}) => {
  const builder = await synbot.bot({ name: `Stepper ${Date.now() % 100000}` });
  synbot.script({
    rules: [
      { match: "SynBot report for work you delegated", steps: [{ say: "Recap: STEPS-1 done." }] },
      {
        // The worker's prompt names its work item: "Work item: <id>."
        match: "Synara Hub delegation.*?Work item: ([^\\s]+?)\\..*STEPS-1 worker brief",
        steps: [
          progress(0, ["completed", "inProgress", "pending"], "Writing the change"),
          { sleepMs: 20_000 },
          progress(1, ["completed", "completed", "completed"], "All steps done"),
          { sleepMs: 6_000 },
          { say: "Worker: STEPS-1 done." },
        ],
      },
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
              requestId: "steps-1",
              threads: [
                {
                  prompt: "STEPS-1 worker brief: three steps.",
                  target: ENGINE,
                  title: "STEPS-1 task",
                  projectId: synbot.projectId,
                },
              ],
            },
          },
          { say: "Started STEPS-1." },
        ],
      },
      {
        match: "You are SynBot, the main SynBot bot.*STEPS-1",
        steps: [
          {
            tool: "synara_bot_delegate",
            args: { botId: builder.id, brief: "Ship STEPS-1.", requestId: "steps-1-deleg" },
          },
          { say: "Stepper is on STEPS-1." },
        ],
      },
    ],
    fallback: [{ say: "SILENT" }],
  });

  await synbot.open();
  await synbot.send("STEPS-1 please");
  const [first] = await synbot.waitForLog(
    (e) => e.event === "tool_result" && e.tool === "synara_hub_update_progress",
    { timeoutMs: 120_000 },
  );
  expect(first!.failed, JSON.stringify(first!.result)).toBe(false);

  await synbot.open(builder);
  const card = browser.locator("article.task-card").filter({ hasText: "STEPS-1 task" }).last();
  await expect(card).toBeVisible({ timeout: 30_000 });
  const steps = browser.locator("article.task-card ol.steps").last();
  await expect(steps).toHaveAttribute("aria-label", "1 of 3 steps", { timeout: 15_000 });
  await expect(browser.locator("article.task-card ol.steps li")).toHaveText([
    "Read the code",
    "Write the change",
    "Run the tests",
  ]);
  await expect(browser.locator("article.task-card ol.steps li.steps__item--done")).toHaveText([
    "Read the code",
  ]);
  await app.screenshot("task-steps-in-progress");

  // The second report reaches the open card without a reload.
  await expect(steps).toHaveAttribute("aria-label", "3 of 3 steps", { timeout: 30_000 });
  await expect(browser.locator("article.task-card ol.steps li.steps__item--done")).toHaveCount(3);
  await app.screenshot("task-steps-done");
  const results = synbot
    .log()
    .filter((e) => e.event === "tool_result" && e.tool === "synara_hub_update_progress");
  expect(results.map((e) => e.failed)).toEqual([false, false]);
});

import { ENGINE, expect, test } from "./synbot.ts";

interface ShellThread {
  readonly id: string;
  readonly projectId: string;
  readonly deletedAt?: string | null;
}

test("Removing a bot deletes its chat and keeps the project threads it worked in", async ({
  synbot,
  screen,
  app,
}) => {
  const doomed = await synbot.bot({ name: `Gone ${Date.now() % 100000}` });
  synbot.script({
    rules: [
      { match: "SynBot report for work you delegated", steps: [{ say: "Recap: DELETE-1 done." }] },
      {
        match: "Synara Hub delegation.*DELETE-1 worker brief",
        steps: [{ say: "Worker: DELETE-1 done in the project." }],
      },
      { match: `You are ${doomed.name}, a SynBot bot.*Watch this hub`, steps: [{ say: "SILENT" }] },
      {
        match: `You are ${doomed.name}, a SynBot bot.*SynBot delegation`,
        steps: [
          {
            tool: "synara_create_threads",
            args: {
              requestId: "delete-1",
              threads: [
                {
                  prompt: "DELETE-1 worker brief: one line.",
                  target: ENGINE,
                  title: "DELETE-1 project task",
                  projectId: synbot.projectId,
                },
              ],
            },
          },
          { say: "Started DELETE-1." },
        ],
      },
      {
        match: "You are SynBot, the main SynBot bot.*DELETE-1",
        steps: [
          {
            tool: "synara_bot_delegate",
            args: { botId: doomed.id, brief: "Do DELETE-1.", requestId: "delete-1-deleg" },
          },
          { say: "Handed DELETE-1." },
        ],
      },
    ],
    fallback: [{ say: "SILENT" }],
  });
  const threads = async () =>
    (await synbot.rpc<{ threads: ShellThread[] }>("orchestration.getShellSnapshot")).threads.filter(
      (thread) => !thread.deletedAt,
    );

  await synbot.open();
  await synbot.send("DELETE-1 please");
  await synbot.waitForLog(
    (e) =>
      e.event === "step" && (e as { say?: string }).say === "Worker: DELETE-1 done in the project.",
    { timeoutMs: 120_000 },
  );
  const tasks = (await synbot.bots()).tasks as Array<{
    botId: string;
    task: { title: string; workerThreadId: string | null };
  }>;
  const worker = tasks.find((entry) => entry.botId === doomed.id)?.task.workerThreadId;
  expect(worker).toBeTruthy();
  const beforeIds = (await threads()).map((thread) => thread.id);
  expect(beforeIds).toContain(doomed.threadId);
  expect(beforeIds).toContain(worker);

  await synbot.open(doomed);
  // The name pill in the chat header opens the bot sheet.
  await screen.getByRole("button", doomed.name).tap();
  const remove = screen.getByRole("button", "Remove bot");
  await expect(remove).toBeVisible();
  await remove.tap();
  const confirm = screen.getByRole("dialog", `Remove ${doomed.name}?`);
  await expect(confirm).toBeVisible();
  await app.screenshot("remove-confirm");
  await confirm.getByRole("button", "Remove bot").tap();

  await expect
    .poll(async () => (await synbot.bots()).bots.some((b) => b.id === doomed.id), {
      timeout: 30_000,
    })
    .toBe(false);
  await expect(screen.getByRole("navigation", "My bots").getByText(doomed.name)).toHaveCount(0);
  await app.screenshot("removed");

  const after = await threads();
  const afterIds = after.map((thread) => thread.id);
  // Its chat is gone; the project thread it started stays, in the project.
  expect(afterIds).not.toContain(doomed.threadId);
  expect(afterIds).toContain(worker);
  expect(after.find((thread) => thread.id === worker)?.projectId).toBe(synbot.projectId);
});

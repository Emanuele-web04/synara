import { expect, test } from "./synbot.ts";

test("SynBot hands a request to a bot, which answers directly, and recaps once", async ({
  synbot,
  screen,
  browser,
  app,
}) => {
  const frontend = await synbot.bot({ name: `Frontend ${Date.now() % 100000}` });
  synbot.script({
    rules: [
      {
        match: "SynBot report for work you delegated",
        steps: [{ say: "Recap: Frontend finished DELEG-1." }],
      },
      {
        match: `You are ${frontend.name}, a SynBot bot.*SynBot delegation`,
        steps: [{ say: "Frontend result: DELEG-1 is done." }],
      },
      {
        match: "You are SynBot, the main SynBot bot.*DELEG-1",
        steps: [
          { say: "Handing this to Frontend." },
          {
            tool: "synara_bot_delegate",
            args: { botId: frontend.id, brief: "Answer DELEG-1 briefly.", requestId: "deleg-1" },
            saveAs: "delegation",
          },
        ],
      },
    ],
    fallback: [{ say: "SILENT" }],
  });

  await synbot.open();
  await synbot.send("DELEG-1 please ask the frontend bot");

  const [delegated] = await synbot.waitForLog(
    (e) => e.event === "tool_result" && e.tool === "synara_bot_delegate",
    { timeoutMs: 60_000 },
  );
  expect(delegated!.failed).toBe(false);

  const baton = browser.locator("article.baton").filter({ hasText: frontend.name });
  await expect(baton).toBeVisible({ timeout: 30_000 });
  await expect(baton).toContainText(frontend.name);
  await app.screenshot("baton-working");

  // The target bot's turn ran on the delegation message.
  await synbot.waitForLog(
    (e) => e.event === "prompt" && (e.text ?? "").includes("SynBot delegation"),
    { timeoutMs: 60_000 },
  );

  // One report card and one recap in SynBot's chat.
  const report = browser.locator("article.report").filter({ hasText: frontend.name });
  await expect(report.first()).toBeVisible({ timeout: 90_000 });
  await expect(report.first()).toContainText("All done");
  await expect(screen.getByText("Recap: Frontend finished DELEG-1.").last()).toBeVisible({
    timeout: 60_000,
  });
  await app.screenshot("report-and-recap");
  await expect(report).toHaveCount(1);

  const reportPrompts = synbot
    .log()
    .filter(
      (e) =>
        e.event === "prompt" && (e.text ?? "").includes("SynBot report for work you delegated"),
    );
  expect(reportPrompts).toHaveLength(1);

  // The frontend bot's own chat shows its answer.
  await synbot.open(frontend);
  await expect(screen.getByText("Frontend result: DELEG-1 is done.").last()).toBeVisible();
  await app.screenshot("frontend-chat");
});

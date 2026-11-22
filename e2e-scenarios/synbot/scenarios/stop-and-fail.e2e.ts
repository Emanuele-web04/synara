import { expect, test } from "./synbot.ts";

test("Stop all stops a bot that is still working", async ({ synbot, screen, browser, app }) => {
  const slow = await synbot.bot({ name: `Slow ${Date.now() % 100000}` });
  synbot.script({
    rules: [
      { match: "SynBot report for work you delegated", steps: [{ say: "Recap after stop." }] },
      {
        match: `You are ${slow.name}, a SynBot bot.*SynBot delegation`,
        steps: [
          { say: "Slow bot started." },
          { sleepMs: 30_000 },
          { say: "Slow bot finished late." },
        ],
      },
      {
        match: "You are SynBot, the main SynBot bot.*STOP-ALL",
        steps: [
          {
            tool: "synara_bot_delegate",
            args: { botId: slow.id, brief: "STOP-ALL brief", requestId: "stop-all-1" },
          },
          { say: "Handed to Slow." },
        ],
      },
    ],
    fallback: [{ say: "SILENT" }],
  });

  await synbot.open();
  await synbot.send("STOP-ALL start slow work");
  await synbot.waitForLog(
    (e) => e.event === "prompt" && (e.text ?? "").includes(`You are ${slow.name}`),
    { timeoutMs: 60_000 },
  );
  const baton = browser.locator("article.baton").last();
  await expect(baton).toBeVisible();
  await app.screenshot("slow-working");

  await screen.getByRole("button", "Stop all").tap();
  // A bot's "finished" notice is a dialog too: pick the confirmation by its title.
  const dialog = screen.getByRole("dialog", "Stop every bot?");
  await expect(dialog).toBeVisible();
  await app.screenshot("stop-all-dialog");
  await dialog.getByRole("button", "Stop all").tap();

  await expect(baton).toContainText("Stopped", { timeout: 30_000 });
  await app.screenshot("stopped");
  // Stop must reach the engine: session/cancel or the process ends, and the turn never finishes.
  await new Promise((resolve) => setTimeout(resolve, 40_000));
  const log = synbot.log();
  const cancelled = log.some((e) => e.event === "cancel" || e.event === "process_signal");
  const kept = log.some(
    (e) => e.event === "step" && (e as { say?: string }).say === "Slow bot finished late.",
  );
  await synbot.open(slow);
  await app.screenshot("slow-bot-after-stop");
  expect({ cancelled, keptRunning: kept }).toEqual({ cancelled: true, keptRunning: false });
});

test("A bot whose engine fails shows the hand-off as failed", async ({
  synbot,
  browser,
  screen,
  app,
}) => {
  const broken = await synbot.bot({ name: `Broken ${Date.now() % 100000}` });
  synbot.script({
    rules: [
      { match: "SynBot report for work you delegated", steps: [{ say: "Recap: Broken failed." }] },
      {
        match: `You are ${broken.name}, a SynBot bot.*SynBot delegation`,
        steps: [{ say: "Starting..." }, { error: "scripted engine failure" }],
      },
      {
        match: "You are SynBot, the main SynBot bot.*FAIL-1",
        steps: [
          {
            tool: "synara_bot_delegate",
            args: { botId: broken.id, brief: "FAIL-1 brief", requestId: "fail-1" },
          },
          { say: "Handed to Broken." },
        ],
      },
    ],
    fallback: [{ say: "SILENT" }],
  });

  await synbot.open();
  await synbot.send("FAIL-1 please");
  const baton = browser.locator("article.baton").last();
  await expect(baton).toContainText("Failed", { timeout: 90_000 });
  const report = browser.locator("article.report").last();
  await expect(report).toContainText("failed", { timeout: 90_000 });
  await expect(screen.getByText("Recap: Broken failed.").last()).toBeVisible({ timeout: 60_000 });
  await app.screenshot("failed-handoff");

  await synbot.open(broken);
  await app.screenshot("broken-bot-chat");
});

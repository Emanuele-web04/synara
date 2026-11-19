import { expect, test } from "./synbot.ts";

test("SynBot survives a reload on its own URL", async ({ synbot, browser, app }) => {
  const bot = await synbot.bot({ name: `Reload ${Date.now() % 100000}` });
  await synbot.open(bot);
  const before = await browser.url();
  expect(before).toContain(`/synbot?bot=${bot.id}`);
  await browser.reload();
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  await app.screenshot("after-reload");
  expect(await browser.url()).toContain("/synbot");
});

test("SynBot at phone width has no horizontal scroll and keeps the composer usable", async ({
  synbot,
  browser,
  screen,
  app,
}) => {
  const bot = await synbot.bot({
    name: `Narrow bot with a fairly long name ${Date.now() % 100000}`,
  });
  await synbot.open();
  await browser.setViewport({ width: 390, height: 844 });
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await app.screenshot("phone-main");
  const overflow = await browser.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(screen.getByTestId("composer-editor")).toBeVisible();
  await synbot.open(bot);
  await app.screenshot("phone-bot");
  await browser.setViewport({ width: 1440, height: 900 });
});

test("SynBot in dark mode with the largest UI font", async ({ synbot, browser, app }) => {
  await browser.emulateMedia({ colorScheme: "dark" });
  await synbot.open();
  await browser.evaluate(() => {
    document.documentElement.style.setProperty("--app-font-size-ui", "18px");
  });
  await app.screenshot("dark-large-font");
  const overflow = await browser.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("Removing a bot with a hand-off in flight fails that hand-off", async ({
  synbot,
  browser,
  app,
}) => {
  const doomed = await synbot.bot({ name: `Doomed ${Date.now() % 100000}` });
  synbot.script({
    rules: [
      {
        match: "SynBot report for work you delegated",
        steps: [{ say: "Recap: Doomed was removed." }],
      },
      {
        match: `You are ${doomed.name}, a SynBot bot.*SynBot delegation`,
        steps: [{ say: "Doomed started." }, { sleepMs: 240_000 }],
      },
      {
        match: "You are SynBot, the main SynBot bot.*REMOVE-1",
        steps: [
          {
            tool: "synara_bot_delegate",
            args: { botId: doomed.id, brief: "REMOVE-1 brief", requestId: "remove-1" },
          },
          { say: "Handed to Doomed." },
        ],
      },
    ],
    fallback: [{ say: "SILENT" }],
  });
  await synbot.open();
  await synbot.send("REMOVE-1 please");
  await synbot.waitForLog(
    (e) => e.event === "prompt" && (e.text ?? "").includes(`You are ${doomed.name}`),
    { timeoutMs: 60_000 },
  );
  const latest = (await synbot.bots()).bots.find((b) => b.id === doomed.id)!;
  expect(latest.id).toBe(doomed.id);
  await synbot.rpc("bots.remove", { id: doomed.id });
  const baton = browser.locator("article.baton").last();
  await expect(baton).toContainText(/Failed|Stopped/, { timeout: 60_000 });
  await app.screenshot("removed-bot-handoff");
  expect((await synbot.bots()).bots.some((b) => b.id === doomed.id)).toBe(false);
});

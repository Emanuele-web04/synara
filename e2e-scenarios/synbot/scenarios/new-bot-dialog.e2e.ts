import { expect, test } from "./synbot.ts";

test("New bot: the dialog validates the name and creates a working bot", async ({
  synbot,
  screen,
  app,
}) => {
  await synbot.open();
  await screen.getByRole("button", "New bot").tap();
  const dialog = screen.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await app.screenshot("new-bot-step-1");

  const name = dialog.getByLabel("Name");
  const proceed = dialog.getByRole("button", "Continue");
  await name.fill("   ");
  await app.screenshot("new-bot-blank-name");
  await expect(proceed).toBeDisabled();

  const botName = `Dialog ${Date.now() % 100000}`;
  await name.fill(botName);
  await dialog.getByLabel("Role").fill("Checks the dialog flow");
  await expect(proceed).toBeEnabled();
  await proceed.tap();
  await app.screenshot("new-bot-step-2");

  const createButton = dialog.getByRole("button", `Create ${botName}`);
  await expect(createButton).toBeVisible();
  await createButton.tap();
  await app.screenshot("new-bot-after-create");

  await expect
    .poll(async () => (await synbot.bots()).bots.map((b) => b.name), { timeout: 30_000 })
    .toContain(botName);
  const created = (await synbot.bots()).bots.find((b) => b.name === botName)!;
  await app.screenshot("new-bot-created");
  // The dialog picks an engine the server can actually run.
  const full = (
    await synbot.rpc<{ bots: Array<{ id: string; modelSelection: { provider: string } }> }>(
      "bots.list",
    )
  ).bots.find((b) => b.id === created.id)!;
  expect(full.modelSelection.provider).toBe("grok");
});

test("New bot: a name at the 80-character limit keeps the sidebar and header readable", async ({
  synbot,
  browser,
  app,
}) => {
  const longName = `Very long bot name ${"x".repeat(200)}`.slice(0, 80);
  const bot = await synbot.bot({ name: longName });
  await synbot.open(bot);
  await app.screenshot("long-name");
  const overflow = await browser.evaluate(() => ({
    page: document.documentElement.scrollWidth - window.innerWidth,
    nav: (() => {
      const nav = document.querySelector('nav[aria-label="My bots"]');
      return nav ? nav.scrollWidth - nav.clientWidth : 0;
    })(),
  }));
  expect(overflow.page).toBeLessThanOrEqual(0);
  expect(overflow.nav).toBeLessThanOrEqual(0);
});

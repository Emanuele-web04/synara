import { expect, test } from "./synbot.ts";

// A card answered "Not now" stays answered; asking the same thing again must post a fresh card
// the user can answer, not silently reuse the dismissed one.

test("A bot proposal dismissed with Not now can be proposed again and answered", async ({
  synbot,
  screen,
  browser,
  app,
}) => {
  const name = `Again ${Date.now() % 100000}`;
  synbot.script({
    rules: [
      {
        match: "You are SynBot, the main SynBot bot.*REPROPOSE",
        steps: [
          {
            tool: "synara_bot_propose",
            args: { name, role: "Writes release notes", reason: "REPROPOSE reason" },
            saveAs: "card",
          },
          { say: "Proposed it." },
        ],
      },
    ],
    fallback: [{ say: "SILENT" }],
  });
  const proposals = () =>
    synbot.log().filter((e) => e.event === "tool_result" && e.tool === "synara_bot_propose");
  const card = browser.locator(".choice").filter({ hasText: `Save "${name}" as a bot?` });

  await synbot.open();
  await synbot.send("REPROPOSE first time");
  await expect(card.first()).toBeVisible({ timeout: 60_000 });
  await card.first().getByRole("button", "Not now").tap();
  await expect(card.first()).toHaveAttribute("class", /choice--done/, { timeout: 30_000 });
  await app.screenshot("proposal-dismissed");

  await synbot.send("REPROPOSE second time");
  await expect.poll(() => proposals().length, { timeout: 60_000 }).toBe(2);
  const [first, second] = proposals();
  expect(first!.failed).toBe(false);
  expect(second!.failed).toBe(false);
  const firstId = (first!.result as { cardId: string }).cardId;
  const secondId = (second!.result as { cardId: string }).cardId;
  expect(secondId).not.toBe(firstId);

  // The new card is open and creates the bot; the dismissed one stays dismissed.
  await expect(card).toHaveCount(2, { timeout: 30_000 });
  const fresh = card.last();
  await expect(fresh).not.toHaveAttribute("class", /choice--done/);
  await app.screenshot("proposal-again");
  await fresh.getByText("Create bot", { exact: true }).tap();
  await expect
    .poll(async () => (await synbot.bots()).bots.map((b) => b.name), { timeout: 30_000 })
    .toContain(name);
  await expect(card.first()).toHaveAttribute("class", /choice--done/);
  await expect(screen.getByRole("navigation", "My bots").getByText(name).first()).toBeVisible({
    timeout: 30_000,
  });
});

test("A project suggestion dismissed with Not now can be suggested again and answered", async ({
  synbot,
  browser,
  app,
}) => {
  synbot.script({
    rules: [
      {
        match: "You are SynBot, the main SynBot bot.*RESUGGEST",
        steps: [
          { tool: "synara_bot_suggest", args: { projectId: synbot.projectId }, saveAs: "card" },
          { say: "Suggested bots." },
        ],
      },
    ],
    fallback: [{ say: "SILENT" }],
  });
  const suggestions = () =>
    synbot.log().filter((e) => e.event === "tool_result" && e.tool === "synara_bot_suggest");
  const card = browser.locator(".choice").filter({ hasText: "demo-app" });

  await synbot.open();
  await synbot.send("RESUGGEST first time");
  await expect(card.first()).toBeVisible({ timeout: 60_000 });
  const before = await card.count();
  await card.last().getByRole("button", "Not now").tap();
  await expect(card.last()).toHaveAttribute("class", /choice--done/, { timeout: 30_000 });
  await app.screenshot("suggestion-dismissed");

  await synbot.send("RESUGGEST second time");
  await expect.poll(() => suggestions().length, { timeout: 60_000 }).toBe(2);
  const [first, second] = suggestions();
  expect(first!.failed, JSON.stringify(first!.result)).toBe(false);
  expect(second!.failed, JSON.stringify(second!.result)).toBe(false);
  const firstId = (first!.result as { cardId: string }).cardId;
  const secondId = (second!.result as { cardId: string }).cardId;
  expect(secondId).not.toBe(firstId);

  await expect(card).toHaveCount(before + 1, { timeout: 30_000 });
  const fresh = card.last();
  await expect(fresh).not.toHaveAttribute("class", /choice--done/);
  await app.screenshot("suggestion-again");
  // Answer it: Not now again resolves the fresh card, proving it is answerable.
  await fresh.getByRole("button", "Not now").tap();
  await expect(fresh).toHaveAttribute("class", /choice--done/, { timeout: 30_000 });
});

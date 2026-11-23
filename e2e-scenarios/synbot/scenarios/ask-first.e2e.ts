import { expect, test } from "./synbot.ts";

test("A bot that asks first waits for Start, and Not now wakes nobody", async ({
  synbot,
  screen,
  browser,
  app,
}) => {
  const careful = await synbot.bot({ name: `Careful ${Date.now() % 100000}`, autonomy: "ask" });
  const ranOn = (brief: string) =>
    synbot
      .log()
      .some(
        (e) =>
          e.event === "prompt" &&
          (e.text ?? "").includes(brief) &&
          (e.text ?? "").includes(`You are ${careful.name}`),
      );
  synbot.script({
    rules: [
      { match: "SynBot report for work you delegated", steps: [{ say: "Recap: ASK done." }] },
      {
        match: `You are ${careful.name}, a SynBot bot.*SynBot delegation`,
        steps: [{ say: "Careful bot ran ASK work." }],
      },
      {
        match: "You are SynBot, the main SynBot bot.*ASK-ONE",
        steps: [
          {
            tool: "synara_bot_delegate",
            args: { botId: careful.id, brief: "ASK-ONE brief", requestId: "ask-one" },
          },
          { say: "Asked Careful (one)." },
        ],
      },
      {
        match: "You are SynBot, the main SynBot bot.*ASK-TWO",
        steps: [
          {
            tool: "synara_bot_delegate",
            args: { botId: careful.id, brief: "ASK-TWO brief", requestId: "ask-two" },
          },
          { say: "Asked Careful (two)." },
        ],
      },
    ],
    fallback: [{ say: "SILENT" }],
  });

  await synbot.open();
  await synbot.send("ASK-ONE please");
  const sent = browser.locator("article.baton").filter({ hasText: "ASK-ONE brief" });
  await expect(sent).toContainText("Waiting for your Start", { timeout: 60_000 });
  await app.screenshot("synbot-side-waiting");

  // Start / Not now sit on the receiving bot's copy of the card.
  await synbot.open(careful);
  const received = browser.locator("article.baton").filter({ hasText: "ASK-ONE brief" });
  await expect(received).toBeVisible({ timeout: 30_000 });
  await app.screenshot("careful-side-waiting");
  await received.getByRole("button", "Not now").tap();
  await new Promise((resolve) => setTimeout(resolve, 15_000));
  expect(ranOn("ASK-ONE brief")).toBe(false);
  expect(
    synbot
      .log()
      .some(
        (e) =>
          e.event === "prompt" && (e.text ?? "").includes("SynBot report for work you delegated"),
      ),
  ).toBe(false);
  await app.screenshot("after-not-now");

  await synbot.open();
  await expect(sent).not.toContainText("Waiting for your Start", { timeout: 30_000 });
  await app.screenshot("synbot-side-after-not-now");

  // Start: the careful bot runs and SynBot recaps.
  await synbot.send("ASK-TWO please");
  await expect(browser.locator("article.baton").filter({ hasText: "ASK-TWO brief" })).toContainText(
    "Waiting for your Start",
    { timeout: 60_000 },
  );
  await synbot.open(careful);
  await browser
    .locator("article.baton")
    .filter({ hasText: "ASK-TWO brief" })
    .getByRole("button", "Start")
    .tap();
  await expect.poll(() => ranOn("ASK-TWO brief"), { timeout: 60_000 }).toBe(true);
  await synbot.open();
  await expect(screen.getByText("Recap: ASK done.").last()).toBeVisible({ timeout: 60_000 });
  await app.screenshot("after-start");
});

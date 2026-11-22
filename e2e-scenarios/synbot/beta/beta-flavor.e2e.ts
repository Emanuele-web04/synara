// Synara Beta out of the box: no account and no billing, and SynBot just works. The host runs as
// the Beta desktop flavor (`start-app.ts --beta`), so this is the build the Beta channel ships.
import { BETA } from "../paths.ts";
import { expect, makeSynbotTest } from "../scenarios/synbot.ts";

const test = makeSynbotTest(BETA);

test("Beta runs SynBot signed out: no Alto gate, a bot answers and a hand-off reports back", async ({
  synbot,
  browser,
  screen,
  app,
}) => {
  const account = (await synbot.rpc<{ state: string }>("account.status")).state;
  expect(account).toBe("signed-out");

  const helper = await synbot.bot({ name: `Helper ${Date.now() % 100000}` });
  synbot.script({
    rules: [
      { match: "SynBot report for work you delegated", steps: [{ say: "Recap: BETA-1 done." }] },
      {
        match: `You are ${helper.name}, a SynBot bot.*SynBot delegation`,
        steps: [{ say: "Helper: BETA-1 answered." }],
      },
      {
        match: "You are SynBot, the main SynBot bot.*BETA-1",
        steps: [
          { say: `${helper.name} is on it.` },
          {
            tool: "synara_bot_delegate",
            args: { botId: helper.id, brief: "Answer BETA-1.", requestId: "beta-1" },
          },
        ],
      },
    ],
    fallback: [{ say: "SILENT" }],
  });

  await synbot.open();
  await expect(screen.getByText("SynBot requires Synara Alto (Pro)")).toHaveCount(0);
  const rail = browser.locator(".synbot-sidebar");
  await expect(rail.getByText("Beta", { exact: true })).toBeVisible();
  await expect(screen.getByRole("button", "New bot")).toBeVisible();
  await synbot.send("BETA-1 please");
  await expect(screen.getByText("Recap: BETA-1 done.").last()).toBeVisible({ timeout: 120_000 });
  await expect(browser.locator("article.report").filter({ hasText: helper.name })).toHaveCount(1);
  await app.screenshot("beta-signed-out");

  // All of it ran with no account at all.
  expect((await synbot.rpc<{ state: string }>("account.status")).state).toBe("signed-out");
});

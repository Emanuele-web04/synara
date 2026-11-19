import { expect, test } from "./synbot.ts";

// Found by these scenarios: when one request hands two pieces of work to the same bot, the bot
// answers both, but the first hand-off stays "sent" forever and SynBot never gets its report.
test("Two hand-offs to the same bot in one request both settle and report once", async ({
  synbot,
  browser,
  screen,
  app,
}) => {
  const worker = await synbot.bot({ name: `Twice ${Date.now() % 100000}` });
  const delegate = (requestId: string) => ({
    tool: "synara_bot_delegate",
    args: { botId: worker.id, brief: `TWICE ${requestId}`, requestId },
  });
  synbot.script({
    rules: [
      { match: "SynBot report for work you delegated", steps: [{ say: "Recap: TWICE done." }] },
      { match: "SynBot delegation", steps: [{ say: "Done." }] },
      {
        match: "You are SynBot, the main SynBot bot.*TWICE-GO",
        steps: [delegate("part-1"), delegate("part-2"), { say: "Split it in two." }],
      },
    ],
    fallback: [{ say: "SILENT" }],
  });

  await synbot.open();
  await synbot.send("TWICE-GO split this in two");
  // The bot answers both hand-offs.
  await synbot.waitForLog(
    (e) => e.event === "prompt" && (e.text ?? "").includes("SynBot delegation"),
    { count: 2, timeoutMs: 60_000 },
  );

  // A finished baton folds and hides its brief, so match the target's name.
  const batons = browser.locator("article.baton").filter({ hasText: worker.name });
  await expect(batons).toHaveCount(2, { timeout: 30_000 });
  await new Promise((resolve) => setTimeout(resolve, 30_000));
  await app.screenshot("two-batons-after-30s");

  const { delegations } = await synbot.bots();
  const states = (delegations as Array<{ brief: string; state: string }>)
    .filter((d) => d.brief.startsWith("TWICE "))
    .map((d) => `${d.brief}: ${d.state}`)
    .toSorted();
  expect(states).toEqual(["TWICE part-1: completed", "TWICE part-2: completed"]);
  await expect(screen.getByText("Recap: TWICE done.").last()).toBeVisible({ timeout: 30_000 });
});

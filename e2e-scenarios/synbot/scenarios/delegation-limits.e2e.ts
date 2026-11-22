import { expect, test, type LogEntry } from "./synbot.ts";

const delegateResults = (log: LogEntry[]) =>
  log.filter((e) => e.event === "tool_result" && e.tool === "synara_bot_delegate");

const errorText = (entry: LogEntry | undefined) => JSON.stringify(entry?.result ?? null);

test("Delegation refuses self, a fifth hand-off in one turn, and a cycle", async ({
  synbot,
  browser,
  app,
}) => {
  const stamp = Date.now() % 100000;
  const [alpha, beta, gamma, delta] = await Promise.all(
    ["Alpha", "Beta", "Gamma", "Delta"].map((name) => synbot.bot({ name: `${name} ${stamp}` })),
  );
  const delegate = (botId: string, requestId: string) => ({
    tool: "synara_bot_delegate",
    args: { botId, brief: `LIMITS ${requestId}`, requestId },
  });

  synbot.script({
    rules: [
      { match: "SynBot report for work you delegated", steps: [{ say: "SILENT" }] },
      // Beta, delegated by Alpha, tries to hand the work back to Alpha: a cycle.
      {
        match: `You are ${beta!.name}, a SynBot bot.*SynBot delegation.*LIMITS cycle-1`,
        steps: [delegate(alpha!.id, "cycle-back"), { say: "Beta tried to hand it back." }],
      },
      {
        match: `You are ${alpha!.name}, a SynBot bot.*SynBot delegation.*LIMITS cycle-1`,
        steps: [delegate(beta!.id, "cycle-1-onward"), { say: "Alpha passed it on." }],
      },
      { match: "SynBot delegation", steps: [{ say: "Done." }] },
      {
        match: "You are SynBot, the main SynBot bot.*LIMITS-SELF",
        steps: [delegate(synbot.main.id, "self-1"), { say: "Tried myself." }],
      },
      {
        match: "You are SynBot, the main SynBot bot.*LIMITS-FIVE",
        steps: [
          delegate(alpha!.id, "five-1"),
          delegate(beta!.id, "five-2"),
          delegate(gamma!.id, "five-3"),
          delegate(delta!.id, "five-4"),
          delegate(alpha!.id, "five-5"),
          { say: "Sent five hand-offs." },
        ],
      },
      {
        match: "You are SynBot, the main SynBot bot.*LIMITS-CYCLE",
        steps: [delegate(alpha!.id, "cycle-1"), { say: "Started the chain." }],
      },
    ],
    fallback: [{ say: "SILENT" }],
  });

  await synbot.open();

  // 1. A bot cannot delegate to itself.
  await synbot.send("LIMITS-SELF delegate to yourself");
  const [self] = await synbot.waitForLog(
    (e) => e.event === "tool_result" && e.tool === "synara_bot_delegate",
    { timeoutMs: 60_000 },
  );
  expect(self!.failed, errorText(self)).toBe(true);
  await app.screenshot("self-refused");

  // 2. Four hand-offs per turn; the fifth is refused; one report lists the four.
  await synbot.send("LIMITS-FIVE send five hand-offs");
  await synbot.waitForLog((e) => e.event === "tool_result" && e.tool === "synara_bot_delegate", {
    count: 6,
    timeoutMs: 60_000,
  });
  const five = delegateResults(synbot.log()).slice(1, 6);
  expect(five.map((e) => e.failed)).toEqual([false, false, false, false, true]);
  // A finished baton folds and hides its brief, so count the batons by their target's name.
  await expect(
    browser
      .locator("article.baton")
      .filter({ hasText: new RegExp(`(Alpha|Beta|Gamma|Delta) ${stamp}`) }),
  ).toHaveCount(4, { timeout: 30_000 });
  const fiveReport = browser.locator("article.report").filter({ hasText: delta!.name }).last();
  await expect(fiveReport).toBeVisible({ timeout: 90_000 });
  await expect(fiveReport).toContainText("4 hand-offs");
  await app.screenshot("five-report");

  // 3. Alpha → Beta → Alpha is a cycle.
  await synbot.send("LIMITS-CYCLE start a chain");
  await synbot.waitForLog((e) => e.event === "tool_result" && e.tool === "synara_bot_delegate", {
    count: 9,
    timeoutMs: 90_000,
  });
  const chain = delegateResults(synbot.log()).slice(6, 9);
  expect(
    chain.map((e) => e.failed),
    JSON.stringify(chain),
  ).toEqual([false, false, true]);
  expect(errorText(chain[2])).toMatch(/already in this delegation chain/i);
  await app.screenshot("cycle-refused");
});

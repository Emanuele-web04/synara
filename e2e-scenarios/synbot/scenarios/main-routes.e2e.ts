// The main SynBot routes instead of working: its prompt tells it to hand fitting work to a bot
// and say who is on it in one line, and the report it gets back asks for one short recap. The
// chat then reads in order: the request, the one-line status, the hand-off, the report, the recap.
import { expect, test } from "./synbot.ts";

const REPORT = "SynBot report for work you delegated";

test("The main SynBot hands the work to a bot, posts a one-line status, then one recap", async ({
  synbot,
  browser,
  screen,
  app,
}) => {
  const frontend = await synbot.bot({
    name: `Pixel ${Date.now() % 100000}`,
    role: "Builds the web UI",
  });
  synbot.script({
    rules: [
      { match: REPORT, steps: [{ say: "Recap: ROUTE-1 button added, ready for review." }] },
      {
        match: `You are ${frontend.name}, a SynBot bot.*SynBot delegation`,
        steps: [{ say: "ROUTE-1 result: the button is in place." }],
      },
      {
        match: "You are SynBot, the main SynBot bot.*ROUTE-1",
        steps: [
          { say: `${frontend.name} is on it.` },
          {
            tool: "synara_bot_delegate",
            args: { botId: frontend.id, brief: "Add the ROUTE-1 button.", requestId: "route-1" },
          },
        ],
      },
    ],
    fallback: [{ say: "SILENT" }],
  });

  await synbot.open();
  await synbot.send("ROUTE-1 add a button to the web app");
  const recap = screen.getByText("Recap: ROUTE-1 button added, ready for review.").last();
  await expect(recap).toBeVisible({ timeout: 120_000 });
  await app.screenshot("main-routes");

  // What the main SynBot was told when the request came in.
  const request = synbot
    .log()
    .find(
      (e) =>
        e.event === "prompt" &&
        (e.text ?? "").includes("You are SynBot, the main SynBot bot") &&
        (e.text ?? "").includes("ROUTE-1 add a button"),
    );
  expect(request, "the main SynBot never saw the request").toBeTruthy();
  const contract = request!.text ?? "";
  expect(contract).toContain("hand it to that bot with synara_bot_delegate");
  expect(contract).toContain("do not start that work as your own task");
  expect(contract).toContain("Say who is on it in one line");
  expect(contract).toContain(`${frontend.id} · ${frontend.name} · Builds the web UI`);

  // Its own turn only routed: no task of its own, one hand-off.
  const mainTools = synbot
    .log()
    .filter((e) => e.event === "tool" && e.sessionId === request!.sessionId)
    .map((e) => e.tool);
  expect(mainTools).toEqual(["synara_bot_delegate"]);

  // One report, carrying the bot's result and asking for one short recap.
  const reports = synbot
    .log()
    .filter(
      (e) =>
        e.event === "prompt" &&
        (e.text ?? "").includes("You are SynBot, the main SynBot bot") &&
        (e.text ?? "").includes(REPORT),
    );
  expect(reports).toHaveLength(1);
  expect(reports[0]!.text).toContain(`${frontend.name} finished`);
  expect(reports[0]!.text).toContain("ROUTE-1 result: the button is in place.");
  expect(reports[0]!.text).toContain("one short recap of the outcome (at most 3 lines");

  // The chat reads top to bottom: status, hand-off, report, recap.
  const status = screen.getByText(`${frontend.name} is on it.`).last();
  const baton = browser.locator("article.baton").filter({ hasText: frontend.name }).last();
  const report = browser.locator("article.report").filter({ hasText: frontend.name });
  await expect(report).toHaveCount(1);
  // Document order of the first element matching each [selector, text]; a null selector means
  // the innermost element holding the text.
  const [statusAt, batonAt, reportAt, recapAt] = (await browser.evaluate(
    (targets: Array<[string | null, string]>) => {
      const all = [...document.querySelectorAll("body *")];
      return targets.map(([selector, text]) =>
        all.findIndex(
          (el) =>
            (selector ? el.matches(selector) : el.children.length === 0) &&
            (el.textContent ?? "").includes(text),
        ),
      );
    },
    [
      [null, `${frontend.name} is on it.`],
      ["article.baton", frontend.name],
      ["article.report", frontend.name],
      [null, "Recap: ROUTE-1 button added"],
    ] as never,
  )) as number[];
  const order = { status: statusAt!, baton: batonAt!, report: reportAt!, recap: recapAt! };
  await expect(status).toBeVisible();
  await expect(baton).toBeVisible();
  expect(order.status).toBeGreaterThanOrEqual(0);
  expect(order.status).toBeLessThan(order.baton);
  expect(order.baton).toBeLessThan(order.report);
  expect(order.report).toBeLessThan(order.recap);
  // The recap is the last thing SynBot said, and it said it once.
  await expect(screen.getByText("Recap: ROUTE-1 button added, ready for review.")).toHaveCount(1);
});

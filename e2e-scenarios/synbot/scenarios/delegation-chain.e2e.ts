import { expect, test, type Bot, type LogEntry, type Synbot } from "./synbot.ts";

// SynBot → Frontend → QA: work handed on belongs to the hand-off that handed it on, so SynBot
// hears the end of the chain (QA reported to Frontend and Frontend answered), once.

const REPORT = "SynBot report for work you delegated";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isPrompt = (bot: string, text: string) => (e: LogEntry) =>
  e.event === "prompt" &&
  (e.text ?? "").includes(`You are ${bot}`) &&
  (e.text ?? "").includes(text);
const mainReports = (synbot: Synbot) =>
  synbot.log().filter(isPrompt("SynBot, the main SynBot bot", REPORT));
const stepSaid = (synbot: Synbot, text: string) =>
  synbot.log().find((e) => e.event === "step" && (e as { say?: string }).say === text);

interface Delegation {
  readonly id: string;
  readonly brief: string;
  readonly state: string;
  readonly toBotId: string;
}
const delegationTo = async (synbot: Synbot, bot: Bot, brief: string) =>
  ((await synbot.bots()).delegations as Delegation[]).find(
    (d) => d.toBotId === bot.id && d.brief.includes(brief),
  );

async function chainBots(synbot: Synbot) {
  const stamp = Date.now() % 100000;
  const frontend = await synbot.bot({ name: `Front ${stamp}` });
  const qa = await synbot.bot({ name: `Qa ${stamp}` });
  return { frontend, qa };
}

const handOn = (to: Bot, brief: string, requestId: string) => ({
  tool: "synara_bot_delegate",
  args: { botId: to.id, brief, requestId },
});

test("SynBot recaps a SynBot → Frontend → QA chain once, after Frontend answered QA", async ({
  synbot,
  browser,
  screen,
  app,
}) => {
  const { frontend, qa } = await chainBots(synbot);
  synbot.script({
    rules: [
      {
        match: `You are ${frontend.name}, a SynBot bot.*${REPORT}`,
        // Slow enough that a recap sent on QA's report alone would come first.
        steps: [{ sleepMs: 4_000 }, { say: "FE-FINAL: QA passed, CHAIN-1 is done." }],
      },
      {
        match: `You are ${qa.name}, a SynBot bot.*SynBot delegation`,
        steps: [{ say: "QA-RESULT: CHAIN-1 passes." }],
      },
      {
        match: `You are ${frontend.name}, a SynBot bot.*SynBot delegation`,
        steps: [handOn(qa, "Test CHAIN-1.", "chain-1-qa"), { say: "Passed CHAIN-1 to QA." }],
      },
      { match: REPORT, steps: [{ say: "Recap: CHAIN-1 done end to end." }] },
      {
        match: "You are SynBot, the main SynBot bot.*CHAIN-1",
        steps: [handOn(frontend, "Build CHAIN-1.", "chain-1-fe"), { say: "Handed to Frontend." }],
      },
    ],
    fallback: [{ say: "SILENT" }],
  });

  await synbot.open();
  await synbot.send("CHAIN-1 build and test it");
  await expect(screen.getByText("Recap: CHAIN-1 done end to end.").last()).toBeVisible({
    timeout: 120_000,
  });
  await app.screenshot("chain-recap");

  const qaSaid = stepSaid(synbot, "QA-RESULT: CHAIN-1 passes.");
  const feWake = synbot.log().find(isPrompt(frontend.name, REPORT));
  const feSaid = stepSaid(synbot, "FE-FINAL: QA passed, CHAIN-1 is done.");
  const [mainWake] = mainReports(synbot);
  expect({ qa: !!qaSaid, feWake: !!feWake, fe: !!feSaid, main: !!mainWake }).toEqual({
    qa: true,
    feWake: true,
    fe: true,
    main: true,
  });
  // QA reported to Frontend, Frontend answered, and only then SynBot was woken.
  expect(Date.parse(feWake!.t)).toBeGreaterThanOrEqual(Date.parse(qaSaid!.t));
  expect(Date.parse(mainWake!.t)).toBeGreaterThan(Date.parse(feSaid!.t));
  expect(mainWake!.text).toContain("FE-FINAL");

  // Exactly one recap: no second wake and one report card for the request.
  await sleep(15_000);
  expect(mainReports(synbot)).toHaveLength(1);
  await expect(browser.locator("article.report").filter({ hasText: frontend.name })).toHaveCount(1);
  expect((await delegationTo(synbot, frontend, "Build CHAIN-1."))?.state).toBe("completed");
  expect((await delegationTo(synbot, qa, "Test CHAIN-1."))?.state).toBe("completed");
});

test("Stopping Frontend's hand-off also stops the QA hand-off it made, and QA never wakes Frontend", async ({
  synbot,
  browser,
  app,
}) => {
  const { frontend, qa } = await chainBots(synbot);
  synbot.script({
    rules: [
      {
        match: `You are ${frontend.name}, a SynBot bot.*${REPORT}`,
        steps: [{ say: "FE woke after stop (must not happen)." }],
      },
      {
        match: `You are ${qa.name}, a SynBot bot.*SynBot delegation`,
        steps: [{ say: "QA started CASCADE-1." }, { sleepMs: 60_000 }, { say: "QA late." }],
      },
      {
        match: `You are ${frontend.name}, a SynBot bot.*SynBot delegation`,
        steps: [handOn(qa, "Test CASCADE-1.", "cascade-qa"), { say: "Passed CASCADE-1 to QA." }],
      },
      { match: REPORT, steps: [{ say: "Recap after cascade (must not happen)." }] },
      {
        match: "You are SynBot, the main SynBot bot.*CASCADE-1",
        steps: [handOn(frontend, "Build CASCADE-1.", "cascade-fe"), { say: "Handed to Frontend." }],
      },
    ],
    fallback: [{ say: "SILENT" }],
  });

  await synbot.open();
  await synbot.send("CASCADE-1 build and test it");
  const [qaPrompt] = await synbot.waitForLog(isPrompt(qa.name, "SynBot delegation"), {
    timeoutMs: 90_000,
  });
  // Frontend's own turn is over; its hand-off stays open on QA's work.
  await synbot.waitForLog(
    (e) => e.event === "step" && (e as { say?: string }).say === "Passed CASCADE-1 to QA.",
    { timeoutMs: 30_000 },
  );
  await sleep(2_000);

  const baton = browser.locator("article.baton").filter({ hasText: frontend.name }).last();
  await expect(baton).toBeVisible({ timeout: 30_000 });
  await app.screenshot("cascade-working");
  await baton.getByRole("button", "Stop").tap();
  await expect(baton).toContainText("Stopped", { timeout: 30_000 });

  await expect
    .poll(async () => (await delegationTo(synbot, qa, "Test CASCADE-1."))?.state, {
      timeout: 30_000,
    })
    .toBe("cancelled");
  expect((await delegationTo(synbot, frontend, "Build CASCADE-1."))?.state).toBe("cancelled");
  // The stop reaches QA's engine.
  await synbot.waitForLog(
    (e) =>
      (e.event === "cancel" && e.sessionId === qaPrompt!.sessionId) || e.event === "process_signal",
    { timeoutMs: 30_000 },
  );

  // Past the sweep: QA's stopped turn wakes nobody.
  await sleep(20_000);
  await app.screenshot("cascade-stopped");
  expect(synbot.log().filter(isPrompt(frontend.name, REPORT))).toHaveLength(0);
  expect(mainReports(synbot)).toHaveLength(0);
  expect(stepSaid(synbot, "QA late.")).toBeUndefined();
});

test("A Frontend wake turn that fails after QA reported fails Frontend's hand-off", async ({
  synbot,
  browser,
  screen,
  app,
}) => {
  const { frontend, qa } = await chainBots(synbot);
  synbot.script({
    rules: [
      {
        match: `You are ${frontend.name}, a SynBot bot.*${REPORT}`,
        steps: [{ say: "FE rolling up WAKEFAIL-1." }, { error: "scripted wake failure" }],
      },
      {
        match: `You are ${qa.name}, a SynBot bot.*SynBot delegation`,
        steps: [{ say: "QA-RESULT: WAKEFAIL-1 passes." }],
      },
      {
        match: `You are ${frontend.name}, a SynBot bot.*SynBot delegation`,
        steps: [handOn(qa, "Test WAKEFAIL-1.", "wakefail-qa"), { say: "Passed WAKEFAIL-1 to QA." }],
      },
      { match: REPORT, steps: [{ say: "Recap: WAKEFAIL-1 reported." }] },
      {
        match: "You are SynBot, the main SynBot bot.*WAKEFAIL-1",
        steps: [
          handOn(frontend, "Build WAKEFAIL-1.", "wakefail-fe"),
          { say: "Handed to Frontend." },
        ],
      },
    ],
    fallback: [{ say: "SILENT" }],
  });

  await synbot.open();
  await synbot.send("WAKEFAIL-1 build and test it");
  await synbot.waitForLog((e) => e.event === "scripted_error", { timeoutMs: 120_000 });
  await expect
    .poll(async () => (await delegationTo(synbot, frontend, "Build WAKEFAIL-1."))?.state, {
      timeout: 60_000,
    })
    .toBe("failed");
  expect((await delegationTo(synbot, qa, "Test WAKEFAIL-1."))?.state).toBe("completed");

  const baton = browser.locator("article.baton").filter({ hasText: frontend.name }).last();
  await expect(baton).toContainText("Failed", { timeout: 30_000 });
  await expect(screen.getByText("Recap: WAKEFAIL-1 reported.").last()).toBeVisible({
    timeout: 60_000,
  });
  await app.screenshot("wake-failed");
  expect(mainReports(synbot)).toHaveLength(1);
});

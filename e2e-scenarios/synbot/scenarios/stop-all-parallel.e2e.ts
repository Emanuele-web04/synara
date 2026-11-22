import { expect, test } from "./synbot.ts";

// One request, three hand-offs: one finishes first (settled, its recap held for the others), two
// are still working when the user presses Stop all. Both stop, and the held recap never wakes
// SynBot afterwards, not even on a later settle sweep (every 10 s).

const REPORT = "SynBot report for work you delegated";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const handOff = (botId: string, requestId: string) => ({
  tool: "synara_bot_delegate",
  args: { botId, brief: `PARALLEL ${requestId}`, requestId },
});

test("Stop all with two hand-offs in flight stops both and wakes nobody afterwards", async ({
  synbot,
  screen,
  browser,
  app,
}) => {
  const stamp = Date.now() % 100000;
  const [quick, slowA, slowB] = await Promise.all(
    ["Quick", "SlowA", "SlowB"].map((name) => synbot.bot({ name: `${name} ${stamp}` })),
  );
  synbot.script({
    rules: [
      { match: REPORT, steps: [{ say: "Recap after Stop all (must not happen)." }] },
      {
        match: `You are ${quick!.name}, a SynBot bot.*SynBot delegation`,
        steps: [{ say: "Quick done." }],
      },
      {
        match: "SynBot delegation.*PARALLEL slow-",
        steps: [{ say: "Slow started." }, { sleepMs: 90_000 }, { say: "Slow finished late." }],
      },
      {
        match: "You are SynBot, the main SynBot bot.*PARALLEL-GO",
        steps: [
          handOff(quick!.id, "quick"),
          handOff(slowA!.id, "slow-a"),
          handOff(slowB!.id, "slow-b"),
          { say: "Split it three ways." },
        ],
      },
    ],
    fallback: [{ say: "SILENT" }],
  });
  const states = async () =>
    Object.fromEntries(
      ((await synbot.bots()).delegations as Array<{ brief: string; state: string }>)
        .filter((d) => d.brief.startsWith("PARALLEL "))
        .map((d) => [d.brief.slice("PARALLEL ".length), d.state]),
    );

  await synbot.open();
  await synbot.send("PARALLEL-GO split this");
  await synbot.waitForLog(
    (e) => e.event === "step" && (e as { say?: string }).say === "Slow started.",
    { count: 2, timeoutMs: 90_000 },
  );
  // The quick hand-off settles; its recap waits for the two slow ones.
  await expect.poll(states, { timeout: 60_000 }).toEqual({
    quick: "completed",
    "slow-a": "working",
    "slow-b": "working",
  });
  await app.screenshot("parallel-working");

  await screen.getByRole("button", "Stop all").tap();
  // A "finished" notice is a dialog too: pick the confirmation by its title.
  const dialog = screen.getByRole("dialog", "Stop every bot?");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", "Stop all").tap();
  const stoppedAt = Date.now();

  await expect.poll(states, { timeout: 30_000 }).toEqual({
    quick: "completed",
    "slow-a": "cancelled",
    "slow-b": "cancelled",
  });
  for (const bot of [slowA!, slowB!]) {
    await expect(
      browser.locator("article.baton").filter({ hasText: bot.name }).last(),
    ).toContainText("Stopped", { timeout: 30_000 });
  }

  // Wait out more than one settle sweep.
  await sleep(20_000);
  await app.screenshot("parallel-after-stop");
  const log = synbot.log();
  const lateWakes = log.filter(
    (e) =>
      e.event === "prompt" &&
      Date.parse(e.t) >= stoppedAt &&
      (e.text ?? "").includes("You are SynBot, the main SynBot bot"),
  );
  expect(lateWakes.map((e) => (e.text ?? "").slice(-200))).toEqual([]);
  expect(log.some((e) => e.event === "prompt" && (e.text ?? "").includes(REPORT))).toBe(false);
  expect(
    log.some((e) => e.event === "step" && (e as { say?: string }).say === "Slow finished late."),
  ).toBe(false);
});

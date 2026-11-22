import { ENGINE, expect, test, type Bot, type Synbot } from "./synbot.ts";

interface Task {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly workerThreadId: string | null;
}
interface Settings {
  readonly maxParallelTasks: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const tasksOf = async (synbot: Synbot, bot: Bot) =>
  ((await synbot.bots()).tasks as Array<{ botId: string; task: Task }>)
    .filter((entry) => entry.botId === bot.id)
    .map((entry) => entry.task);

const thread = (synbot: Synbot, title: string, brief: string) => ({
  prompt: brief,
  target: ENGINE,
  title,
  projectId: synbot.projectId,
});

test("With one parallel task, the queued task stops on its own and the running one keeps going", async ({
  synbot,
  browser,
  app,
}) => {
  const builder = await synbot.bot({ name: `Queue ${Date.now() % 100000}` });
  const before = ((await synbot.bots()).settings as Settings).maxParallelTasks;
  await synbot.rpc("bots.updateSettings", { maxParallelTasks: 1 });
  try {
    synbot.script({
      rules: [
        { match: "SynBot report for work you delegated", steps: [{ say: "SILENT" }] },
        {
          match: "Synara Hub delegation.*QSTOP-A worker brief",
          steps: [{ say: "Worker A started." }, { sleepMs: 120_000 }, { say: "Worker A late." }],
        },
        {
          match: "Synara Hub delegation.*QSTOP-B worker brief",
          steps: [{ say: "Worker B ran (must not happen)." }],
        },
        {
          match: `You are ${builder.name}, a SynBot bot.*Watch this hub`,
          steps: [{ say: "SILENT" }],
        },
        {
          match: `You are ${builder.name}, a SynBot bot.*SynBot delegation`,
          steps: [
            {
              tool: "synara_create_threads",
              args: {
                requestId: "qstop",
                threads: [
                  thread(synbot, "QSTOP-A running task", "QSTOP-A worker brief: wait."),
                  thread(synbot, "QSTOP-B queued task", "QSTOP-B worker brief: never start."),
                ],
              },
            },
            { say: "Started two tasks." },
          ],
        },
        {
          match: "You are SynBot, the main SynBot bot.*QSTOP-GO",
          steps: [
            {
              tool: "synara_bot_delegate",
              args: { botId: builder.id, brief: "Run QSTOP.", requestId: "qstop-deleg" },
            },
            { say: "Handed QSTOP to the builder." },
          ],
        },
      ],
      fallback: [{ say: "SILENT" }],
    });

    await synbot.open();
    await synbot.send("QSTOP-GO run two tasks");
    const [created] = await synbot.waitForLog(
      (e) => e.event === "tool_result" && e.tool === "synara_create_threads",
      { timeoutMs: 60_000 },
    );
    expect(created!.failed, JSON.stringify(created!.result)).toBe(false);
    const [workerA] = await synbot.waitForLog(
      (e) => e.event === "prompt" && (e.text ?? "").includes("QSTOP-A worker brief"),
      { timeoutMs: 90_000 },
    );
    await expect
      .poll(
        async () =>
          (await tasksOf(synbot, builder)).map((t) => `${t.title}: ${t.state}`).toSorted(),
        {
          timeout: 30_000,
        },
      )
      .toEqual(["QSTOP-A running task: working", "QSTOP-B queued task: queued"]);

    await synbot.open(builder);
    const queued = browser.locator("article.task-card").filter({ hasText: "QSTOP-B queued task" });
    await expect(queued.last()).toBeVisible({ timeout: 30_000 });
    await app.screenshot("queued-task");
    await queued.last().getByRole("button", "Stop").tap();

    await expect
      .poll(
        async () =>
          (await tasksOf(synbot, builder)).map((t) => `${t.title}: ${t.state}`).toSorted(),
        {
          timeout: 30_000,
        },
      )
      .toEqual(["QSTOP-A running task: working", "QSTOP-B queued task: cancelled"]);
    await sleep(5_000);
    await app.screenshot("queued-task-stopped");
    const log = synbot.log();
    expect(log.some((e) => e.event === "cancel" && e.sessionId === workerA!.sessionId)).toBe(false);
    expect(
      log.some((e) => e.event === "prompt" && (e.text ?? "").includes("QSTOP-B worker brief")),
    ).toBe(false);
    expect(
      (await tasksOf(synbot, builder)).find((t) => t.title === "QSTOP-A running task")?.state,
    ).toBe("working");
  } finally {
    await synbot.rpc("bots.stopAll", {}).catch(() => undefined);
    await synbot.rpc("bots.updateSettings", { maxParallelTasks: before });
  }
});

test("Once the Hub's roll-up turn ends after the task, the hand-off reports well before the 60 s grace", async ({
  synbot,
  screen,
  app,
}) => {
  const builder = await synbot.bot({ name: `Rollup ${Date.now() % 100000}` });
  synbot.script({
    rules: [
      {
        match: "SynBot report for work you delegated",
        steps: [{ say: "Recap: ROLLUP-1 shipped." }],
      },
      {
        match: "Synara Hub delegation.*ROLLUP-1 worker brief",
        steps: [{ say: "Worker: ROLLUP-1 done." }],
      },
      {
        match: `You are ${builder.name}, a SynBot bot.*Watch this hub`,
        steps: [{ say: "Rolled up: ROLLUP-1 task finished." }],
      },
      {
        match: `You are ${builder.name}, a SynBot bot.*SynBot delegation`,
        steps: [
          {
            tool: "synara_create_threads",
            args: {
              requestId: "rollup-1",
              threads: [thread(synbot, "ROLLUP-1 task", "ROLLUP-1 worker brief: one line.")],
            },
          },
          { say: "Started ROLLUP-1." },
        ],
      },
      {
        match: "You are SynBot, the main SynBot bot.*ROLLUP-1",
        steps: [
          {
            tool: "synara_bot_delegate",
            args: { botId: builder.id, brief: "Ship ROLLUP-1.", requestId: "rollup-1-deleg" },
          },
          { say: "Handed ROLLUP-1 to the builder." },
        ],
      },
    ],
    fallback: [{ say: "SILENT" }],
  });

  await synbot.open();
  await synbot.send("ROLLUP-1 please");
  await synbot.waitForLog(
    (e) => e.event === "step" && (e as { say?: string }).say === "Worker: ROLLUP-1 done.",
    { timeoutMs: 120_000 },
  );
  const [rollup] = await synbot.waitForLog(
    (e) =>
      e.event === "step" && (e as { say?: string }).say === "Rolled up: ROLLUP-1 task finished.",
    { timeoutMs: 120_000 },
  );
  const [report] = await synbot.waitForLog(
    (e) =>
      e.event === "prompt" &&
      (e.text ?? "").includes("You are SynBot, the main SynBot bot") &&
      (e.text ?? "").includes("SynBot report for work you delegated"),
    { timeoutMs: 120_000 },
  );
  const afterRollupMs = Date.parse(report!.t) - Date.parse(rollup!.t);
  await expect(screen.getByText("Recap: ROLLUP-1 shipped.").last()).toBeVisible({
    timeout: 30_000,
  });
  await app.screenshot("rollup-report");
  // The sweep runs every 10 s; the old rule waited 60 s after the roll-up.
  expect(afterRollupMs).toBeLessThan(25_000);
});

// Stable without Synara Alto: every way in is refused with SUBSCRIPTION_REQUIRED and no bot ever
// runs. Signed out, signed in on Free, after losing Alto, and during an Account API outage.
import * as nodeCrypto from "node:crypto";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";

import { test, type Browser } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";

import type { Script } from "../fake-agent/fakeAcpAgent.ts";
import { STABLE } from "../paths.ts";
import { ENGINE } from "../scenarios/synbot.ts";

type Outcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: string | null; readonly message: string };

const LOG_PATH = nodePath.join(STABLE.STATE_DIR, "log.ndjson");
const SCRIPT_PATH = nodePath.join(STABLE.STATE_DIR, "script.json");
const FAKE_BOT_ID = "00000000-0000-4000-8000-00000000b075";

const call = (browser: Browser, method: string, input?: unknown) =>
  browser.evaluate(
    async (request: { method: string; input: unknown }) => {
      const api = (await import("/src/nativeApi.ts")).readNativeApi();
      if (!api) throw new Error("native API is not ready");
      const [namespace, name] = request.method.split(".");
      try {
        const value = await api[namespace][name](request.input ?? undefined);
        return { ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) };
      } catch (cause) {
        const error = cause as { code?: unknown; message?: unknown; _tag?: unknown };
        return {
          ok: false,
          code: typeof error?.code === "string" ? error.code : null,
          message: typeof error?.message === "string" ? error.message : String(cause),
        };
      }
    },
    { method, input: input ?? null } as never,
  ) as Promise<Outcome>;

/**
 * Opens a fresh `bots.subscribe` stream from the page; what it delivers collects under `key`.
 * The transport shares one server stream per channel, so every other listener (earlier probes and
 * the SynBot page's own live sync) is dropped first: the server sees a new subscribe.
 */
const subscribe = (browser: Browser, key: string) =>
  browser.evaluate(async (name: string) => {
    const api = (await import("/src/nativeApi.ts")).readNativeApi();
    const store = await import("/src/synbot/synbotStore.ts");
    const probes = window as unknown as Record<string, unknown> & {
      __botProbeStops?: Array<() => void>;
    };
    for (const stop of probes.__botProbeStops ?? []) stop();
    store.restartSynbotLiveSync()();
    const seen: string[] = [];
    probes[name] = seen;
    const stop = api?.bots.onEvent((event: { type: string }) => seen.push(event.type));
    probes.__botProbeStops = stop ? [stop] : [];
    return true;
  }, key as never);
const received = (browser: Browser, key: string) =>
  browser.evaluate(
    (name: string) => (window as unknown as Record<string, string[]>)[name] ?? [],
    key as never,
  ) as Promise<string[]>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const openApp = async (app: TestFixtures["app"], browser: Browser) => {
  await app.open("/");
  await expect
    .poll(
      () =>
        browser.evaluate(async () => Boolean((await import("/src/nativeApi.ts")).readNativeApi())),
      { timeout: 60_000 },
    )
    .toBe(true);
};

const readLog = () => {
  try {
    return nodeFs
      .readFileSync(LOG_PATH, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
};

const account = () =>
  (
    JSON.parse(nodeFs.readFileSync(nodePath.join(STABLE.STATE_DIR, "account.json"), "utf8")) as {
      url: string;
    }
  ).url;

const setBilling = async (mode: "free" | "alto" | "error") => {
  const response = await fetch(`${account()}/__scenario/billing`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  expect(response.status).toBe(200);
};

/** Every SynBot entry point a client can reach, with inputs that would act if allowed. */
const botCalls = (botId: string, threadId: string) =>
  [
    ["bots.list", {}],
    ["bots.ensureMain", {}],
    [
      "bots.create",
      {
        requestId: `tamper-${nodeCrypto.randomUUID()}`,
        name: "Tamper",
        role: "Should never exist",
        mascot: { shape: "circle", color: "#1a80fa" },
        scope: { projects: "all", paths: [] },
        modelSelection: ENGINE,
        autonomy: "auto",
      },
    ],
    ["bots.update", { id: botId, name: "Tampered" }],
    ["bots.remove", { id: botId }],
    ["bots.updateSettings", { maxParallelTasks: 8 }],
    ["bots.cardAction", { threadId, cardId: "synbot:card:x", optionId: "create:0" }],
    ["bots.suggest", { projectId: botId }],
    ["bots.cancelDelegation", { delegationId: "dtamper" }],
    ["bots.mergeProof", { threadId }],
    ["bots.merge", { threadId, headSha: "0000000" }],
    ["bots.updateBranch", { threadId }],
    ["bots.stopAll", {}],
  ] as const;

async function expectAllRefused(browser: Browser, botId: string, threadId: string) {
  const outcomes: Record<string, string> = {};
  for (const [method, input] of botCalls(botId, threadId)) {
    const outcome = await call(browser, method, input);
    outcomes[method] = outcome.ok ? "ALLOWED" : (outcome.code ?? outcome.message);
  }
  expect(outcomes).toEqual(
    Object.fromEntries(
      botCalls(botId, threadId).map(([method]) => [method, "SUBSCRIPTION_REQUIRED"]),
    ),
  );
}

async function expectGateOnRoutes(browser: Browser, screen: TestFixtures["screen"], botId: string) {
  for (const path of [`/synbot?bot=${botId}`, "/synbot?new=bot", "/synbot"]) {
    await browser.evaluate(async (target: string) => {
      (await import("/src/appNavigation.ts")).appHistory.push(target);
    }, path as never);
    await expect(screen.getByText("SynBot requires Synara Alto (Pro)").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(screen.getByTestId("composer-editor")).toHaveCount(0);
    await expect(screen.getByRole("button", "New bot")).toHaveCount(0);
  }
}

test("Stable without Alto refuses every SynBot entry point and never runs a bot", async ({
  app,
  browser,
  screen,
}) => {
  await browser.addInitScript((worktrees: string) => {
    const seen = JSON.stringify([worktrees]);
    localStorage.setItem("synara:app-tour:v1", seen);
    localStorage.setItem("synara:project-import-announcement:v1", seen);
    localStorage.setItem("synara:activity-onboarding:v1", "seen");
    localStorage.setItem("synara:tasks-onboarding:v1", "seen");
  }, STABLE.WORKTREES_DIR as never);
  nodeFs.mkdirSync(STABLE.STATE_DIR, { recursive: true });
  nodeFs.rmSync(LOG_PATH, { force: true });
  nodeFs.writeFileSync(SCRIPT_PATH, JSON.stringify({ rules: [], fallback: [{ say: "SILENT" }] }));
  await openApp(app, browser);
  const fakeThread = nodeCrypto.randomUUID();

  // 1. Signed out.
  await subscribe(browser, "signedOutStream");
  await expectAllRefused(browser, FAKE_BOT_ID, fakeThread);
  await expectGateOnRoutes(browser, screen, FAKE_BOT_ID);
  await app.screenshot("signed-out-gate");

  // 2. Signed in on Free.
  expect((await call(browser, "account.sendOtp", { email: "scenario@example.invalid" })).ok).toBe(
    true,
  );
  const signIn = await call(browser, "account.authenticateOtp", {
    email: "scenario@example.invalid",
    code: "123456",
  });
  expect(signIn.ok, JSON.stringify(signIn)).toBe(true);
  expect((await call(browser, "account.billingStatus")).ok).toBe(true);
  await expectAllRefused(browser, FAKE_BOT_ID, fakeThread);
  await expectGateOnRoutes(browser, screen, FAKE_BOT_ID);
  await app.screenshot("free-gate");
  await subscribe(browser, "freeStream");
  expect(readLog().filter((e) => e.event === "process_start")).toEqual([]);

  // A refused bots.subscribe delivers nothing, not even a snapshot.
  await sleep(3_000);
  expect(await received(browser, "signedOutStream")).toEqual([]);
  expect(await received(browser, "freeStream")).toEqual([]);

  // 3. With Alto the same host works: a bot exists and its thread is real.
  await setBilling("alto");
  expect((await call(browser, "account.billingStatus")).ok).toBe(true);
  // The same subscription opened now does deliver, so the empty ones above were refusals.
  await subscribe(browser, "altoStream");
  await expect
    .poll(() => received(browser, "altoStream"), { timeout: 20_000 })
    .toContain("snapshot");
  const main = await call(browser, "bots.ensureMain", {});
  expect(main.ok, JSON.stringify(main)).toBe(true);
  const created = await call(browser, "bots.create", {
    requestId: `stable-${nodeCrypto.randomUUID()}`,
    name: "Paid bot",
    role: "Made while Alto was active",
    mascot: { shape: "circle", color: "#1a80fa" },
    scope: { projects: "all", paths: [] },
    modelSelection: ENGINE,
    autonomy: "auto",
  });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  const paid = (created as { value: { id: string; threadId: string } }).value;
  const mainBot = (main as { value: { id: string; threadId: string } }).value;

  // 4. Alto lapses: the bots that exist stay locked, by RPC, by URL and through the gateway.
  await setBilling("free");
  expect((await call(browser, "account.billingStatus")).ok).toBe(true);
  await expectAllRefused(browser, paid.id, paid.threadId);
  // An open window keeps the SynBot it already loaded (the server refuses everything, as above);
  // the gate comes back on the next load. See the scenario report.
  await openApp(app, browser);
  await expectGateOnRoutes(browser, screen, paid.id);
  await app.screenshot("lapsed-gate");
  await subscribe(browser, "lapsedStream");

  const script: Script = {
    rules: [
      {
        match: "TAMPER-1",
        steps: [
          { tool: "synara_bots_list", force: true },
          {
            tool: "synara_bot_delegate",
            force: true,
            args: { botId: mainBot.id, brief: "TAMPER-1 brief", requestId: "tamper-1" },
          },
          { say: "Tamper attempt done." },
        ],
      },
    ],
    fallback: [{ say: "SILENT" }],
  };
  nodeFs.writeFileSync(SCRIPT_PATH, JSON.stringify(script));
  // A turn in the bot's own thread, started without the bots API.
  const turn = await call(browser, "orchestration.dispatchCommand", {
    type: "thread.turn.start",
    commandId: nodeCrypto.randomUUID(),
    threadId: paid.threadId,
    message: {
      messageId: nodeCrypto.randomUUID(),
      role: "user",
      text: "TAMPER-1 delegate to SynBot",
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  });
  expect(turn.ok, JSON.stringify(turn)).toBe(true);
  await expect
    .poll(() => readLog().some((e) => e.event === "step" && e.say === "Tamper attempt done."), {
      timeout: 90_000,
    })
    .toBe(true);
  const log = readLog();
  const prompt = log.find((e) => e.event === "prompt");
  // No SynBot context for a locked bot.
  expect(String(prompt?.text ?? "")).not.toContain("a SynBot bot");
  // Neither bot tool is offered, and calling them anyway is refused.
  const results = log.filter((e) => e.event === "tool_result");
  expect(results.map((e) => [e.tool, e.failed])).toEqual([
    ["synara_bots_list", true],
    ["synara_bot_delegate", true],
  ]);
  expect(log.filter((e) => e.event === "tool" && e.forced !== true)).toEqual([]);
  // SynBot itself never ran.
  expect(log.filter((e) => e.event === "prompt")).toHaveLength(1);

  expect(await received(browser, "lapsedStream")).toEqual([]);

  // 5. An Account API outage fails closed too.
  await setBilling("error");
  await call(browser, "account.billingStatus");
  await expectAllRefused(browser, paid.id, paid.threadId);

  // With Alto back, nothing was handed off while locked.
  await setBilling("alto");
  expect((await call(browser, "account.billingStatus")).ok).toBe(true);
  const after = await call(browser, "bots.list", {});
  expect(after.ok, JSON.stringify(after)).toBe(true);
  const snapshot = (
    after as { value: { bots: Array<{ id: string; name: string }>; delegations: unknown[] } }
  ).value;
  expect(snapshot.delegations).toEqual([]);
  expect(snapshot.bots.map((b) => b.name).toSorted()).toEqual(["Paid bot", "SynBot"]);
});

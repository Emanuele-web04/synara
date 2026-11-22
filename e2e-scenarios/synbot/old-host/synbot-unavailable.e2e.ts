// A cross-version remote host without SynBot: a host built before SynBot has never heard of the
// `bots.*` methods. old-host-proxy.ts makes the current server answer them that way, so the web
// app meets the reply such a host really sends. SynBot must say it is not available, the socket
// must stay up (no reconnect loop), and plain chats must keep working.
import * as nodeCrypto from "node:crypto";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";

import { test, type Browser } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";

import type { Script } from "../fake-agent/fakeAcpAgent.ts";
import { OLD_HOST } from "../paths.ts";
import { ENGINE } from "../scenarios/synbot.ts";

interface ProxyState {
  readonly connections: number;
  readonly botRequests: number;
  readonly botTags: readonly string[];
}

const UNAVAILABLE = "SynBot isn't available on this computer.";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SCRIPT_PATH = nodePath.join(OLD_HOST.STATE_DIR, "script.json");

const proxyState = async (): Promise<ProxyState> => {
  const { url } = JSON.parse(
    nodeFs.readFileSync(nodePath.join(OLD_HOST.STATE_DIR, "proxy.json"), "utf8"),
  ) as { url: string };
  return (await (await fetch(`${url}/__scenario/state`)).json()) as ProxyState;
};

const rpc = (browser: Browser, method: string, input: unknown) =>
  browser.evaluate(
    async (call: { method: string; input: unknown }) => {
      const api = (await import("/src/nativeApi.ts")).readNativeApi();
      if (!api) throw new Error("native API is not ready");
      const [namespace, name] = call.method.split(".");
      const result = await api[namespace][name](call.input);
      return result === undefined ? null : JSON.parse(JSON.stringify(result));
    },
    { method, input } as never,
  );

const navigate = (browser: Browser, path: string) =>
  browser.evaluate(async (target: string) => {
    (await import("/src/appNavigation.ts")).appHistory.push(target);
  }, path as never);

/** Sockets the page opened and SynBot statuses it went through (see openApp). */
const pageProbe = (browser: Browser) =>
  browser.evaluate(() => {
    const probe = window as unknown as { __sockets?: string[]; __synbotStatuses?: string[] };
    return { sockets: probe.__sockets?.length ?? 0, statuses: [...(probe.__synbotStatuses ?? [])] };
  }) as Promise<{ sockets: number; statuses: string[] }>;

async function openApp(app: TestFixtures["app"], browser: Browser) {
  await browser.addInitScript((worktrees: string) => {
    const seen = JSON.stringify([worktrees]);
    localStorage.setItem("synara:app-tour:v1", seen);
    localStorage.setItem("synara:project-import-announcement:v1", seen);
    localStorage.setItem("synara:activity-onboarding:v1", "seen");
    localStorage.setItem("synara:tasks-onboarding:v1", "seen");
    // Every socket the page opens, so a reconnect loop shows even if the proxy missed one.
    const Native = window.WebSocket;
    const opened: string[] = [];
    (window as unknown as { __sockets: string[] }).__sockets = opened;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        opened.push(String(url).split("?")[0] ?? "");
      }
    } as typeof WebSocket;
  }, OLD_HOST.WORKTREES_DIR as never);
  await app.open("/");
  await expect
    .poll(
      () =>
        browser.evaluate(async () => Boolean((await import("/src/nativeApi.ts")).readNativeApi())),
      { timeout: 60_000 },
    )
    .toBe(true);
  // Every SynBot status the page goes through from here on.
  await browser.evaluate(async () => {
    const { useSynbotStore } = await import("/src/synbot/synbotStore.ts");
    const seen = [useSynbotStore.getState().status];
    (window as unknown as { __synbotStatuses: string[] }).__synbotStatuses = seen;
    useSynbotStore.subscribe((state: { status: string }) => {
      if (seen.at(-1) !== state.status) seen.push(state.status);
    });
  });
}

// A host built before SynBot answers `bots.*` with a connection-wide RPC Defect ("Unknown request
// tag"), and it does not advertise the SynBot capability. The web app checks the capability and
// refuses `bots.*` locally with FEATURE_UNAVAILABLE (apps/web/src/wsTransport.ts,
// synbotRefusalForHost), so no Defect ever comes back: the page says SynBot is not available, once,
// with no reconnect and no bots.* request on the wire.
test("A host without SynBot says SynBot is not available, once, and keeps its socket", async ({
  app,
  browser,
  screen,
}) => {
  await openApp(app, browser);
  const start = await proxyState();
  const startPage = await pageProbe(browser);
  await navigate(browser, "/synbot");
  // Long enough for the page to settle and for a reconnect loop's first backoff steps.
  await sleep(15_000);
  const end = await proxyState();
  const endPage = await pageProbe(browser);
  await app.screenshot("synbot-on-old-host");

  const observed = {
    message: (await screen.getByText(UNAVAILABLE).count()) > 0,
    status: endPage.statuses.at(-1),
    newSockets: endPage.sockets - startPage.sockets,
    newProxyConnections: end.connections - start.connections,
    // Asked once is fine (that is how the page learns); asked again and again is a loop.
    botRequestsAfterSettling: 0,
  };
  // The bots.* requests sent in the second half of the window, when nothing should be asking.
  const mid = await proxyState();
  await sleep(8_000);
  observed.botRequestsAfterSettling = (await proxyState()).botRequests - mid.botRequests;
  expect(start.connections).toBeGreaterThan(0);
  expect(
    observed,
    `statuses ${JSON.stringify(endPage.statuses)}; bots.* requests ${JSON.stringify(end.botTags)}`,
  ).toEqual({
    message: true,
    status: "unavailable",
    newSockets: 0,
    newProxyConnections: 0,
    botRequestsAfterSettling: 0,
  });
  await expect(screen.getByTestId("composer-editor")).toHaveCount(0);
});

const PROJECT_PATH = nodePath.join(OLD_HOST.STATE_DIR, "project.json");

const setRenameBots = async (renameBots: boolean) => {
  const { url } = JSON.parse(
    nodeFs.readFileSync(nodePath.join(OLD_HOST.STATE_DIR, "proxy.json"), "utf8"),
  ) as { url: string };
  const response = await fetch(`${url}/__scenario/mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ renameBots }),
  });
  expect(response.status).toBe(200);
};

/**
 * Opens a plain chat in the demo project, sends `tag`, and reports what happened within a minute:
 * whether the scripted answer arrived, and what the page said about its connection.
 */
async function plainChat(
  app: TestFixtures["app"],
  browser: Browser,
  screen: TestFixtures["screen"],
  tag: string,
) {
  nodeFs.mkdirSync(OLD_HOST.STATE_DIR, { recursive: true });
  const answer = `PONG ${tag} from a chat on this host.`;
  const script: Script = {
    rules: [{ match: tag, steps: [{ say: answer }] }],
    fallback: [{ say: "SILENT" }],
  };
  nodeFs.writeFileSync(SCRIPT_PATH, JSON.stringify(script));
  await openApp(app, browser);
  const start = await proxyState();
  const startPage = await pageProbe(browser);

  let projectId: string;
  try {
    projectId = (JSON.parse(nodeFs.readFileSync(PROJECT_PATH, "utf8")) as { projectId: string })
      .projectId;
  } catch {
    projectId = nodeCrypto.randomUUID();
    await rpc(browser, "orchestration.dispatchCommand", {
      type: "project.create",
      commandId: nodeCrypto.randomUUID(),
      projectId,
      kind: "project",
      title: "demo-app",
      workspaceRoot: OLD_HOST.DEMO_REPO,
      createdAt: new Date().toISOString(),
    });
    nodeFs.writeFileSync(PROJECT_PATH, JSON.stringify({ projectId }));
  }
  const threadId = nodeCrypto.randomUUID();
  await rpc(browser, "orchestration.dispatchCommand", {
    type: "thread.create",
    commandId: nodeCrypto.randomUUID(),
    threadId,
    projectId,
    title: `Chat ${tag}`,
    modelSelection: ENGINE,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: new Date().toISOString(),
  });
  await navigate(browser, `/${threadId}`);
  const composer = screen.getByTestId("composer-editor");
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.tap();
  await composer.pressSequentially(`${tag} are you there`);
  await browser.keyboard.press("Enter");
  const reply = screen.getByText(answer).last();
  const answered = await expect(reply)
    .toBeVisible({ timeout: 60_000 })
    .then(() => true)
    .catch(() => false);
  await app.screenshot(`chat-${tag.toLowerCase()}`);
  const end = await proxyState();
  const endPage = await pageProbe(browser);
  // Whether the page can still reach the server at all, and if not, what it says.
  const unary = (await browser.evaluate(async () => {
    const api = (await import("/src/nativeApi.ts")).readNativeApi();
    try {
      await Promise.race([
        api?.orchestration.getShellSnapshot(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("no answer in 10 s")), 10_000),
        ),
      ]);
      return "ok";
    } catch (cause) {
      return String((cause as Error)?.message ?? cause).slice(0, 120);
    }
  })) as string;
  return {
    answered,
    unary,
    reconnecting: (await screen.getByText("Reconnecting to Synara…").count()) > 0,
    recoveryStopped: (await screen.getByText(/Connection recovery stopped/).count()) > 0,
    newSockets: endPage.sockets - startPage.sockets,
    newProxyConnections: end.connections - start.connections,
    statuses: endPage.statuses,
  };
}

test("Control: through the same proxy with bots.* passed on, SynBot loads and a chat answers", async ({
  app,
  browser,
  screen,
}) => {
  await setRenameBots(false);
  try {
    const chat = await plainChat(app, browser, screen, "CONTROL-PING");
    expect(chat).toMatchObject({
      answered: true,
      unary: "ok",
      reconnecting: false,
      recoveryStopped: false,
      newSockets: 0,
      newProxyConnections: 0,
    });
    await navigate(browser, "/synbot");
    await expect(screen.getByTestId("composer-editor")).toBeVisible({ timeout: 30_000 });
  } finally {
    await setRenameBots(true);
  }
});

// Before the capability check, the Defect for `bots.subscribe` counted as a broken socket twice
// (startup, then the resubscribe after the reconnect) and tripped the transport's defect circuit
// breaker, so every RPC failed and chats on that host stopped working.
test("On a host without SynBot a plain chat still sends and gets its answer", async ({
  app,
  browser,
  screen,
}) => {
  await setRenameBots(true);
  const chat = await plainChat(app, browser, screen, "OLDHOST-PING");
  expect(chat, JSON.stringify(chat)).toMatchObject({
    answered: true,
    unary: "ok",
    reconnecting: false,
    recoveryStopped: false,
    newSockets: 0,
    newProxyConnections: 0,
  });
});

import { strict as assert } from "node:assert";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { BetterWright, NetworkPolicy } from "betterwright";
import { configureElectronNetwork } from "betterwright/electron";
import { WebSocketServer } from "ws";
import { synaraHostTarget } from "../src/browserAutomation/betterwrightHostTarget";
import { BrowserVaultCapture } from "../src/browserAutomation/browserVaultCapture";
import type { BrowserVault } from "../src/browserAutomation/browserVault";
import type { BrowserAutomationVisibleRuntime } from "../src/browserManager";

// Synthetic, loopback-only fixtures. No personal profiles, credentials, or
// external sites are used. This runs in Electron, not a mocked Session.
configureElectronNetwork();
const home = await mkdtemp(join(tmpdir(), "synara-browser-lifecycle-"));
app.setPath("userData", join(home, "electron"));
const deadline = setTimeout(() => {
  console.error("Browser lifecycle smoke timed out.");
  app.exit(1);
}, 90_000);

async function smoke() {
  await app.whenReady();
  let blockedRequests = 0;
  const blocked = createServer((_request, response) => {
    blockedRequests += 1;
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.end("blocked fixture");
  });
  blocked.on("upgrade", (_request, socket) => {
    blockedRequests += 1;
    socket.destroy();
  });
  blocked.listen(0, "127.0.0.1");
  await once(blocked, "listening");
  const blockedPort = (blocked.address() as { port: number }).port;
  const blockedUrl = `http://127.0.0.1:${blockedPort}`;
  const allowed = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    if (request.url === "/redirect") {
      response.writeHead(302, { location: `${blockedUrl}/redirected` }).end();
    } else if (request.url === "/sw.js") {
      response.setHeader("Content-Type", "application/javascript");
      response.end(`self.addEventListener('install', e => e.waitUntil(self.skipWaiting()));
        self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
        self.addEventListener('message', e => e.waitUntil(fetch(e.data, {cache:'no-store'})
          .then(r => r.text()).then(value => e.ports[0].postMessage(value), () => e.ports[0].postMessage('denied'))));`);
    } else if (request.url === "/data") {
      response.end("allowed fixture");
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end(`<!doctype html><title>Lifecycle fixture</title>
        <form action="/accepted"><input name="username" autocomplete="username"><input name="password" type="password" autocomplete="current-password"><button>Sign in</button></form>`);
    }
  });
  const sockets = new WebSocketServer({ server: allowed });
  sockets.on("connection", (socket) => socket.send("allowed socket"));
  allowed.listen(0, "127.0.0.1");
  await once(allowed, "listening");
  const allowedPort = (allowed.address() as { port: number }).port;
  const allowedUrl = `http://127.0.0.1:${allowedPort}`;
  const window = new BrowserWindow({
    show: false,
    webPreferences: { partition: "lifecycle-smoke", sandbox: true, contextIsolation: true },
  });
  const sibling = new BrowserWindow({
    show: false,
    webPreferences: { partition: "lifecycle-smoke", sandbox: true, contextIsolation: true },
  });
  const contents = window.webContents;
  const session = contents.session;
  session.on("will-download", (event) => event.preventDefault());
  const baselineProxy = await session.resolveProxy(allowedUrl);
  // Seed a direct connection before leasing; acquisition must drain it.
  assert.equal(await (await session.fetch(`${blockedUrl}/warmup`)).text(), "blocked fixture");
  blockedRequests = 0;
  await contents.loadURL(allowedUrl);
  await sibling.loadURL(allowedUrl);
  const target = synaraHostTarget(contents);
  const proxyUrls: string[] = [];
  const leases: Awaited<ReturnType<typeof target.connect>>[] = [];
  const browser = new BetterWright({
    home: join(home, "worker"),
    hostTarget: {
      ...target,
      connect: async (options) => {
        const lease = await target.connect(options);
        proxyUrls.push(options.proxyUrl);
        leases.push(lease);
        return lease;
      },
    },
    vault: false,
    credentialCapture: false,
    downloadPolicy: "deny",
    adBlock: false,
    headless: false,
    parkBackgroundPages: false,
    policy: new NetworkPolicy({ allowLoopback: true, blockHosts: [`127.0.0.1:${blockedPort}`] }),
  });
  try {
    const first = await browser.run("return await page.title()", { automaticUI: false });
    assert.ok(first.ok, JSON.stringify(first));
    assert.equal(first.result, "Lifecycle fixture");
    assert.match(
      await session.resolveProxy(allowedUrl),
      new RegExp(`:${new URL(proxyUrls[0]!).port}$`),
    );
    assert.equal(await (await session.fetch(`${allowedUrl}/data`)).text(), "allowed fixture");
    await assert.rejects(session.fetch(`${blockedUrl}/session-owned`, { cache: "no-store" }));
    await assert.rejects(session.fetch(`${allowedUrl}/redirect`, { cache: "no-store" }));
    assert.equal(
      await sibling.webContents.executeJavaScript(
        `fetch(${JSON.stringify(`${blockedUrl}/sibling`)}, {cache:'no-store'}).then(() => 'allowed', () => 'denied')`,
      ),
      "denied",
    );
    const socketResult = (url: string) =>
      contents.executeJavaScript(`new Promise(resolve => {
      const socket = new WebSocket(${JSON.stringify(url)});
      socket.onmessage = e => { resolve(e.data); socket.close(); };
      socket.onerror = () => resolve('denied');
    })`);
    assert.equal(await socketResult(`ws://127.0.0.1:${allowedPort}`), "allowed socket");
    assert.equal(await socketResult(`ws://127.0.0.1:${blockedPort}`), "denied");
    await contents.executeJavaScript(
      "navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready)",
    );
    const workerFetch = (url: string) =>
      contents.executeJavaScript(`navigator.serviceWorker.ready.then(registration => new Promise(resolve => {
      const channel = new MessageChannel();
      channel.port1.onmessage = e => { channel.port1.close(); resolve(e.data); };
      registration.active.postMessage(${JSON.stringify(url)}, [channel.port2]);
    }))`);
    assert.equal(await workerFetch(`${allowedUrl}/data`), "allowed fixture");
    assert.equal(await workerFetch(`${blockedUrl}/service-worker`), "denied");
    assert.equal(blockedRequests, 0, "Guarded traffic reached the denied server");

    // A closed transport causes the actual client to replace its worker. The
    // new worker supplies a new SOCKS proxy; the same host target must adopt it.
    await leases[0]!.close();
    const rotated = await browser.run(
      `await page.goto(${JSON.stringify(allowedUrl)}); return await page.title()`,
      { automaticUI: false },
    );
    assert.ok(rotated.ok, JSON.stringify(rotated));
    assert.equal(rotated.result, "Lifecycle fixture");
    assert.equal(proxyUrls.length, 2);
    assert.notEqual(proxyUrls[0], proxyUrls[1]);
    assert.match(
      await session.resolveProxy(allowedUrl),
      new RegExp(`:${new URL(proxyUrls[1]!).port}$`),
    );
    await assert.rejects(session.fetch(`${blockedUrl}/after-rotation`, { cache: "no-store" }));
    assert.equal(blockedRequests, 0);
    await target.revokeAll(false);
    await browser.close();
    assert.equal(await session.resolveProxy(allowedUrl), baselineProxy);
    assert.equal(
      await (await session.fetch(`${blockedUrl}/restored`, { cache: "no-store" })).text(),
      "blocked fixture",
    );

    // Install the real upstream capture sensor into a live Electron isolated
    // world, then verify its script, scoped binding, and disposal.
    const ready = Promise.withResolvers<void>();
    const errors: unknown[] = [];
    const capture = new BrowserVaultCapture({
      onChanged: () => () => {},
      snapshot: async () => ({
        settings: { offerSave: true },
        protection: { locked: false },
        logins: [],
      }),
      reportCaptureReady: () => ready.resolve(),
      reportCaptureFailure: () => {
        errors.push("capture failed");
        ready.reject(new Error("Capture setup failed"));
      },
      trackSecret: () => {},
      shouldOfferSave: () => true,
      askSave: async () => "dismiss",
    } as unknown as BrowserVault);
    const listeners = contents.debugger.listenerCount("message");
    capture.register({ webContents: contents } as unknown as BrowserAutomationVisibleRuntime);
    try {
      await ready.promise;
      assert.ok(contents.debugger.listenerCount("message") > listeners);
      assert.equal(errors.length, 0);
    } finally {
      await capture.dispose();
    }
    assert.equal(contents.debugger.listenerCount("message"), listeners);
    console.log(
      "PASS: real worker setup, session requests, redirects, WebSockets, service workers, shared tabs, connection draining, worker rotation, proxy restoration, and capture sensor.",
    );
  } finally {
    await target.revokeAll(true);
    await browser.close();
    window.destroy();
    sibling.destroy();
    await session.clearStorageData();
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    allowed.closeAllConnections();
    blocked.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => allowed.close(() => resolve())),
      new Promise<void>((resolve) => blocked.close(() => resolve())),
    ]);
  }
}

void smoke().then(
  async () => {
    clearTimeout(deadline);
    await rm(home, { recursive: true, force: true });
    app.exit(0);
  },
  (error) => {
    console.error(error);
    app.exit(1);
  },
);

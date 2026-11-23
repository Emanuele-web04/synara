import { strict as assert } from "node:assert";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, type WebContents } from "electron";
import { BetterWright } from "betterwright";
import { configureElectronNetwork } from "betterwright/electron";
import { WebSocketServer } from "ws";
import { getBetterwrightNetworkGuard } from "../src/browserAutomation/betterwrightNetworkGuard";
import { runBetterwright } from "../src/browserAutomation/betterwrightRuntime";
import { captureBrowserScreenshot } from "../src/browserAutomation/screenshotCapture";
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

async function checkCookieImportMetadata(contents: WebContents) {
  const hostTarget = synaraHostTarget(contents, { cookieImport: true });
  const browser = new BetterWright({
    home: join(home, "cookie-worker"),
    hostTarget,
    vault: false,
    credentialCapture: false,
    downloadPolicy: "deny",
    adBlock: false,
    headless: false,
    parkBackgroundPages: false,
    policy: getBetterwrightNetworkGuard(contents.session).policy,
  });
  let includeCookie = true;
  // Stub only local-profile extraction. The installed client must derive
  // hostOwnedTarget, dispatch to its real worker, write through CDP, verify
  // Electron's cookie store, and return metadata through the patched result.
  Object.defineProperty(browser, "_extractCookieSync", {
    value: async () => ({
      cookies: includeCookie
        ? [
            {
              name: "synara_synthetic_import",
              value: "synthetic-only",
              domain: "127.0.0.1",
              path: "/",
              expires: Math.floor(Date.now() / 1000) + 3600,
              secure: false,
              httpOnly: true,
              sameSite: "Lax",
            },
          ]
        : [],
      selected: includeCookie ? 1 : 0,
      skipped: 0,
      source: { browser: "chrome" },
      warnings: [],
    }),
  });
  try {
    const result = await browser.syncCookies({ source: { browser: "chrome" } });
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.synced, 1);
    assert.equal(result.target, "host");
    assert.deepEqual(result.cookieImportDomains, ["127.0.0.1"]);
    const stored = await contents.session.cookies.get({ name: "synara_synthetic_import" });
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.value, "synthetic-only");
    includeCookie = false;
    const empty = await browser.syncCookies({ source: { browser: "chrome" } });
    assert.ok(empty.ok, JSON.stringify(empty));
    assert.equal(empty.synced, 0);
    assert.deepEqual(empty.cookieImportDomains, []);
  } finally {
    await hostTarget.revokeAll(false);
    await browser.close();
  }
}

// Exercise Synara's actual call boundary, which tears down each CDP worker.
async function checkRunRequestLifetime(contents: WebContents, url: string) {
  const run = (code: string, signal = new AbortController().signal, timeoutMs = 10_000) =>
    runBetterwright({ home: join(home, "request-worker"), contents, code, signal, timeoutMs });
  const started = Date.now();
  await contents.executeJavaScript("startXHR()");
  for (let i = 0; i < 6; i++) {
    assert.equal(
      await run("await page.getByRole('button', { name: 'Request' }).click(); return 'clicked'"),
      "clicked",
    );
  }
  await assert.rejects(
    run(
      "await page.getByRole('button', { name: 'Request' }).click(); throw new Error('fixture failure')",
    ),
  );
  const requests = (await contents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => requests.every(item => item.status !== null) ? resolve(requests)
      : Date.now() > deadline ? reject(new Error('XHR did not settle')) : setTimeout(poll, 20);
    poll();
  })`)) as Array<{ status: number; bytes: number }>;
  assert.equal(requests.length, 8);
  for (const request of requests) assert.deepEqual(request, { status: 200, bytes: 4_900_011 });
  console.log(
    `XHR: ${requests.length} responses, each 4,900,011 bytes, ${Date.now() - started} ms total`,
  );

  const navigation = once(contents, "did-finish-load");
  await run(
    "await page.evaluate(() => { location.href = '/slow-document'; }); return 'navigating'",
  );
  await navigation;
  assert.equal(contents.getTitle(), "Navigation survived");
  await contents.loadURL(url);

  // An unacknowledged renderer operation still requires forced cancellation.
  const controller = new AbortController();
  const cancelling = run(
    "await page.evaluate(() => new Promise(resolve => { window.releaseCancelled = resolve; })); await page.evaluate(() => { window.lateMutation = true; });",
    controller.signal,
  );
  const rejected = assert.rejects(cancelling, /fixture cancellation/);
  await contents.executeJavaScript(`new Promise(resolve => {
    const poll = () => typeof releaseCancelled === 'function' ? resolve() : setTimeout(poll, 20);
    poll();
  })`);
  controller.abort(new Error("fixture cancellation"));
  await rejected;
  await contents.executeJavaScript("window.releaseCancelled?.(); void 0");
  assert.equal(await run("return await page.title()"), "Lifecycle fixture");
  assert.equal(await contents.executeJavaScript("window.lateMutation === true"), false);
  await assert.rejects(
    run(
      "await page.evaluate(() => new Promise(resolve => { window.releaseTimedOut = resolve; })); await page.evaluate(() => { window.lateMutation = true; });",
      undefined,
      1_000,
    ),
  );
  await contents.executeJavaScript("window.releaseTimedOut?.(); void 0");
  assert.equal(await run("return await page.title()"), "Lifecycle fixture");
  assert.equal(await contents.executeJavaScript("window.lateMutation === true"), false);

  const screenshot = await captureBrowserScreenshot(
    { webContents: contents, tabId: "request-fixture" } as BrowserAutomationVisibleRuntime,
    { fullPage: false },
  );
  const bytes = Buffer.from(screenshot.image.data, "base64");
  assert.equal(bytes.toString("base64"), screenshot.image.data);
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(bytes.length, screenshot.structuredContent.image.byteLength);
}

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
    if (request.url?.startsWith("/slow")) {
      setTimeout(() => {
        response.setHeader(
          "Content-Type",
          request.url === "/slow-document" ? "text/html" : "application/json",
        );
        response.end(
          request.url === "/slow-document"
            ? "<!doctype html><title>Navigation survived</title>"
            : JSON.stringify({ data: "a".repeat(4_900_000) }),
        );
      }, 1_000);
    } else if (request.url === "/redirect") {
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
        <button onclick="startXHR()">Request</button>
        <script>window.requests = []; function startXHR() {
          const item = { status: null, bytes: 0 }; requests.push(item);
          const xhr = new XMLHttpRequest(); xhr.open('GET', '/slow'); xhr.timeout = 30000;
          xhr.onloadend = () => { item.status = xhr.status; item.bytes = xhr.responseText.length; };
          xhr.send();
        }</script><form action="/accepted"><input name="username" autocomplete="username"><input name="password" type="password" autocomplete="current-password"><button>Sign in</button></form>`);
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
  const networkGuard = getBetterwrightNetworkGuard(session);
  networkGuard.policy.blockHosts.push(`127.0.0.1:${blockedPort}`);
  // Seed a direct connection before leasing; acquisition must drain it.
  assert.equal(await (await session.fetch(`${blockedUrl}/warmup`)).text(), "blocked fixture");
  blockedRequests = 0;
  await networkGuard.initialize();
  const guardedProxy = await session.resolveProxy(allowedUrl);
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
    policy: networkGuard.policy,
  });
  const siblingTarget = synaraHostTarget(sibling.webContents);
  const siblingQueued = Promise.withResolvers<void>();
  let siblingConnected = false;
  const siblingBrowser = new BetterWright({
    home: join(home, "sibling-worker"),
    hostTarget: {
      ...siblingTarget,
      connect: async (options) => {
        siblingQueued.resolve();
        const lease = await siblingTarget.connect(options);
        siblingConnected = true;
        return lease;
      },
    },
    vault: false,
    credentialCapture: false,
    downloadPolicy: "deny",
    adBlock: false,
    headless: false,
    parkBackgroundPages: false,
    policy: networkGuard.policy,
  });
  try {
    const first = await browser.run("return await page.title()", { automaticUI: false });
    assert.ok(first.ok, JSON.stringify(first));
    assert.equal(first.result, "Lifecycle fixture");
    assert.equal(await session.resolveProxy(allowedUrl), guardedProxy);
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

    const siblingRun = siblingBrowser.run("return await page.title()", { automaticUI: false });
    await siblingQueued.promise;
    assert.equal(siblingConnected, false, "Concurrent tab bypassed the session queue");
    // A closed transport causes the actual client to replace its worker. The
    // new worker supplies a new SOCKS proxy; the session keeps its own guard.
    await leases[0]!.close();
    const rotated = await browser.run(
      `await page.goto(${JSON.stringify(allowedUrl)}); return await page.title()`,
      { automaticUI: false },
    );
    assert.ok(rotated.ok, JSON.stringify(rotated));
    assert.equal(rotated.result, "Lifecycle fixture");
    assert.equal(proxyUrls.length, 2);
    assert.notEqual(proxyUrls[0], proxyUrls[1]);
    assert.equal(await session.resolveProxy(allowedUrl), guardedProxy);
    await assert.rejects(session.fetch(`${blockedUrl}/after-rotation`, { cache: "no-store" }));
    assert.equal(blockedRequests, 0);
    assert.equal(siblingConnected, false, "Rotation surrendered the current run's session turn");
    await target.revokeAll(false);
    await browser.close();
    const siblingResult = await siblingRun;
    assert.ok(siblingResult.ok, JSON.stringify(siblingResult));
    assert.equal(siblingResult.result, "Lifecycle fixture");
    assert.equal(siblingConnected, true);
    await assert.rejects(session.fetch(`${blockedUrl}/queued-run`, { cache: "no-store" }));
    assert.equal(blockedRequests, 0);
    await siblingTarget.revokeAll(false);
    await siblingBrowser.close();
    assert.equal(await session.resolveProxy(allowedUrl), guardedProxy);
    await assert.rejects(session.fetch(`${blockedUrl}/between-runs`, { cache: "no-store" }));
    await checkCookieImportMetadata(contents);
    assert.equal(await session.resolveProxy(allowedUrl), guardedProxy);
    await checkRunRequestLifetime(contents, allowedUrl);

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
    await networkGuard.dispose();
    await assert.rejects(session.fetch(`${allowedUrl}/after-shutdown`, { cache: "no-store" }));
    assert.equal(blockedRequests, 0);
    console.log(
      "PASS: 4.9 MB XHRs across six ephemeral workers, pending XHR across completed failure, navigation after run end, abort/timeout recovery, PNG base64, session shutdown, real worker setup, session requests, redirects, WebSockets, service workers, shared tabs, queued concurrent runs, connection draining, worker rotation, persistent guard, cookie import metadata, and capture sensor.",
    );
  } finally {
    await siblingTarget.revokeAll(true);
    await siblingBrowser.close();
    await target.revokeAll(true);
    await browser.close();
    await networkGuard.dispose();
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

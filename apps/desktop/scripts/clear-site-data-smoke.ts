import { strict as assert } from "node:assert";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, session as electronSession } from "electron";
import { resolveClearableSiteOrigins } from "../src/browserManager";
import { BROWSER_SESSION_PARTITION } from "../src/browserSessionPolicy";

// Real Electron session, synthetic loopback sites only.
const home = await mkdtemp(join(tmpdir(), "synara-clear-site-data-"));
app.setPath("userData", join(home, "electron"));
const outDir = process.env.SMOKE_OUT ?? home;
const deadline = setTimeout(() => {
  console.error("clear-site-data smoke timed out");
  app.exit(1);
}, 60_000);

const page = `<!doctype html><meta charset="utf-8"><style>body{font:22px -apple-system;padding:32px}b{color:#0a7}</style>
<h2 id="h"></h2><p>cookie: <b id="c"></b></p><p>localStorage: <b id="l"></b></p>
<script>document.getElementById('h').textContent=location.host;document.getElementById('c').textContent=document.cookie||'(empty)';document.getElementById('l').textContent=localStorage.getItem('demo')||'(empty)';</script>`;

async function listen(host: string): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(page);
  });
  server.listen(0, host);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    server,
    url: `http://${host === "127.0.0.1" ? "127.0.0.1" : "localhost"}:${address.port}/`,
  };
}

async function readState(win: BrowserWindow) {
  return win.webContents.executeJavaScript(
    "({ cookie: document.cookie, storage: localStorage.getItem('demo') })",
  ) as Promise<{ cookie: string; storage: string | null }>;
}

async function snap(win: BrowserWindow, name: string) {
  const image = await win.webContents.capturePage();
  await writeFile(join(outDir, `${name}.png`), image.toPNG());
}

async function smoke() {
  await app.whenReady();
  const browserSession = electronSession.fromPartition(BROWSER_SESSION_PARTITION);
  const a = await listen("127.0.0.1");
  const b = await listen("localhost");
  const open = async (url: string) => {
    const win = new BrowserWindow({
      show: false,
      width: 560,
      height: 260,
      webPreferences: { partition: BROWSER_SESSION_PARTITION },
    });
    await win.loadURL(url);
    await win.webContents.executeJavaScript(
      "document.cookie='demo=1; max-age=86400'; localStorage.setItem('demo','stored'); true",
    );
    await win.webContents.reload();
    await once(win.webContents, "did-finish-load");
    return win;
  };
  const winA = await open(a.url);
  const winB = await open(b.url);

  const before = { a: await readState(winA), b: await readState(winB) };
  console.log("before", JSON.stringify(before));
  assert.equal(before.a.cookie, "demo=1");
  assert.equal(before.a.storage, "stored");
  assert.equal(before.b.cookie, "demo=1");
  await snap(winA, "1-before-127");
  await snap(winB, "1-before-localhost");

  // Same path as DesktopBrowserManager.clearSiteData.
  assert.deepEqual(resolveClearableSiteOrigins("about:blank"), []);
  assert.deepEqual(resolveClearableSiteOrigins("synara-local-preview://x/"), []);
  const origins = resolveClearableSiteOrigins(a.url);
  assert.deepEqual(origins, [new URL(a.url).origin]);
  await browserSession.clearData({ origins });
  winA.webContents.reload();
  await once(winA.webContents, "did-finish-load");
  winB.webContents.reload();
  await once(winB.webContents, "did-finish-load");
  const afterSite = { a: await readState(winA), b: await readState(winB) };
  console.log("after site clear", JSON.stringify(afterSite));
  assert.equal(afterSite.a.cookie, "");
  assert.equal(afterSite.a.storage, null);
  assert.equal(afterSite.b.cookie, "demo=1", "other site cookie must survive");
  assert.equal(afterSite.b.storage, "stored", "other site storage must survive");
  await snap(winA, "2-after-site-127");
  await snap(winB, "2-after-site-localhost");

  // Same path as DesktopBrowserManager.clearAllData.
  await browserSession.clearData();
  winB.webContents.reload();
  await once(winB.webContents, "did-finish-load");
  const afterAll = await readState(winB);
  console.log("after clear all", JSON.stringify(afterAll));
  assert.equal(afterAll.cookie, "");
  assert.equal(afterAll.storage, null);
  assert.equal((await browserSession.cookies.get({})).length, 0);
  await snap(winB, "3-after-all-localhost");

  console.log(
    `clear-site-data smoke passed (Electron ${process.versions.electron}); screenshots in ${outDir}`,
  );
  clearTimeout(deadline);
  a.server.close();
  b.server.close();
  app.exit(0);
}

smoke().then(
  () => undefined,
  (error) => {
    console.error(error);
    app.exit(1);
  },
);

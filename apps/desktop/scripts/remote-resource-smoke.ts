import { app, protocol, BrowserWindow } from "electron";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { registerRemoteResourceBroker, REMOTE_RESOURCE_SCHEME } from "../src/remoteResourceBroker";

// Real Electron, isolated profile and loopback fixtures; no personal account.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "synara-resource-broker-"));
const preload = path.join(directory, "preload.cjs");
fs.writeFileSync(
  preload,
  `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fixtureResource', { url: (hostId, ref) => ipcRenderer.sendSync('desktop:remote-resource-url', hostId, ref) });`,
);
app.setPath("userData", path.join(directory, "electron"));
protocol.registerSchemesAsPrivileged([
  {
    scheme: "synara-fixture-app",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
  {
    scheme: REMOTE_RESOURCE_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);
app
  .whenReady()
  .then(async () => {
    const seen = [];
    const server = http.createServer((req, res) => {
      if (req.url === "/api/auth/bootstrap/bearer") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            role: "owner",
            sessionToken: "fixture-owner-bearer",
            expiresAt: new Date(Date.now() + 60000 * 60).toISOString(),
          }),
        );
        return;
      }
      seen.push({ url: req.url, headers: req.headers, method: req.method });
      assert.equal(req.headers.authorization, "Bearer fixture-owner-bearer");
      if (req.method === "POST") {
        let bytes = 0;
        req.on("data", (b) => {
          bytes += b.length;
        });
        req.on("end", () => res.end(String(bytes)));
        return;
      }
      if (req.headers.range) {
        res.writeHead(206, {
          "content-range": "bytes 2-5/10",
          "content-type": "application/octet-stream",
        });
        res.end("2345");
        return;
      }
      res.setHeader("content-type", "text/plain");
      res.end("remote-resource-bytes");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    protocol.handle(
      "synara-fixture-app",
      () => new Response("<title>Remote resource boundary fixture</title>"),
    );
    let trusted;
    const dispose = registerRemoteResourceBroker({
      trustedRenderer: () => trusted?.webContents ?? null,
      trustedOrigin: () => "synara-fixture-app://app/",
      backendWsUrl: () => `ws://127.0.0.1:${server.address().port}/ws?token=fixture-local-secret`,
    });
    const options = {
      show: false,
      webPreferences: { preload, contextIsolation: true, sandbox: true },
    };
    trusted = new BrowserWindow(options);
    const untrusted = new BrowserWindow(options);
    for (const window of [trusted, untrusted]) await window.loadURL("synara-fixture-app://app/");
    const ref = {
      environmentId: "fixture-environment",
      resource: { kind: "attachment", attachmentId: "att_v2_fixture" },
    };
    const issue = `window.fixtureResource.url('fixture-host',${JSON.stringify(ref)})`;
    const handle = await trusted.webContents.executeJavaScript(issue);
    assert.match(handle, /^synara-resource:\/\/broker\/[a-f0-9-]+$/);
    assert.equal(await untrusted.webContents.executeJavaScript(issue), null);
    const get = `fetch(${JSON.stringify(handle)}).then(r=>r.text(),e=>'refused')`;
    assert.equal(await trusted.webContents.executeJavaScript(get), "remote-resource-bytes");
    assert.equal(await untrusted.webContents.executeJavaScript(get), "refused");
    const range = await trusted.webContents.executeJavaScript(
      `fetch(${JSON.stringify(handle)},{headers:{Range:'bytes=2-5'}}).then(async r=>({status:r.status,body:await r.text()}))`,
    );
    assert.deepEqual(range, { status: 206, body: "2345" });
    const uploadRef = {
      environmentId: "fixture-environment",
      resource: {
        kind: "attachment-upload",
        threadId: "thread1",
        type: "file",
        name: "fixture.bin",
        mimeType: "application/octet-stream",
      },
    };
    const uploaded = await trusted.webContents.executeJavaScript(
      `fetch(window.fixtureResource.url('fixture-host',${JSON.stringify(uploadRef)}),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:new Uint8Array(524288)}).then(r=>r.text())`,
    );
    assert.equal(uploaded, "524288");
    // Same-origin subframes cannot use a handle bound to the application's main frame.
    const iframeResult = await trusted.webContents.executeJavaScript(
      `new Promise(resolve=>{ const f=document.createElement('iframe'); f.src='synara-fixture-app://app/frame'; f.onload=async()=>{resolve(await f.contentWindow.fetch(${JSON.stringify(handle)}).then(r=>r.text(),e=>'refused')); f.remove();};document.body.appendChild(f);})`,
    );
    assert.equal(iframeResult, "refused");
    const reload = new Promise((resolve) => trusted.webContents.once("did-finish-load", resolve));
    trusted.reload();
    await reload;
    assert.equal(await trusted.webContents.executeJavaScript(get), "refused");
    assert.equal(
      seen.some(
        (entry) => entry.url.includes("token=") || entry.url.includes("fixture-local-secret"),
      ),
      false,
    );
    console.log(
      JSON.stringify({
        passed: true,
        checks: [
          "caller identity",
          "foreign-window denial",
          "iframe denial",
          "reload invalidation",
          "range",
          "512KiB upload",
          "no credentials in URLs",
        ],
        requests: seen.length,
      }),
    );
    dispose();
    trusted.destroy();
    untrusted.destroy();
    server.closeAllConnections();
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
setTimeout(() => {
  console.error("fixture timeout");
  app.exit(2);
}, 30000).unref();

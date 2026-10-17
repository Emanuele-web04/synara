import { strict as assert } from "node:assert";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { BrowserPasskeys, registerBrowserPasskeyIpc } from "../src/browserPasskeys";
import type { BrowserAutomationVisibleRuntime, DesktopBrowserManager } from "../src/browserManager";

const home = await mkdtemp(join(tmpdir(), "synara-passkey-smoke-"));
app.setPath("userData", home);
const deadline = setTimeout(() => {
  console.error("Phone-passkey smoke timed out.");
  app.exit(1);
}, 30_000);

async function smoke() {
  await app.whenReady();
  const confirmed = Promise.withResolvers<void>();
  const pairing = Promise.withResolvers<void>();
  const host = new BrowserPasskeys(process.argv.at(-1)!, () => {
    const prompt = host.snapshot();
    if (prompt?.phase === "confirm") confirmed.resolve();
    if (prompt?.phase === "qr") {
      assert.ok(prompt.svg?.includes("<svg"));
      pairing.resolve();
      void host.cancel(prompt.id);
    }
  });
  assert.equal(host.available(), true);
  registerBrowserPasskeyIpc(
    ipcMain,
    { isTrustedRenderer: () => false } as unknown as DesktopBrowserManager,
    host,
  );
  const server = createServer((_request, response) =>
    response.end("<!doctype html><title>Passkey fixture</title>"),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: resolve(import.meta.dirname, "passkey-preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      partition: "passkey-smoke",
    },
  });
  const release = host.register({
    webContents: window.webContents,
  } as unknown as BrowserAutomationVisibleRuntime);
  try {
    await window.loadURL(`http://localhost:${port}`);
    assert.equal(
      await window.webContents.executeJavaScript(
        "PublicKeyCredential.getClientCapabilities().then(value => value.hybridTransport)",
      ),
      true,
    );
    const result = window.webContents.executeJavaScript(
      "navigator.credentials.get({publicKey:{challenge:new Uint8Array([1,2,3,4,5,6,7,8]),rpId:'localhost',timeout:10000,userVerification:'required'}}).then(()=>'unexpected-success', error=>error.name)",
    );
    await confirmed.promise;
    const prompt = host.snapshot()!;
    assert.equal(prompt.origin, `http://localhost:${port}`);
    assert.equal(prompt.rpId, "localhost");
    host.start(prompt.id);
    await pairing.promise;
    assert.equal(await result, "AbortError");
    assert.equal(host.snapshot(), null);
    console.log(
      "PASS: sandboxed page WebAuthn request, origin prompt, native phone QR generation, and helper cancellation drained before settlement.",
    );
  } finally {
    await host.dispose();
    release();
    window.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
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

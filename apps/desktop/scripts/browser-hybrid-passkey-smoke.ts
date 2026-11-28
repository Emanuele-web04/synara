import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow, session, WebContentsView, type WebContents } from "electron";
import { ThreadId } from "@synara/contracts";
import { getBetterwrightNetworkGuard } from "../src/browserAutomation/betterwrightNetworkGuard";
import { registerBrowserHybridPasskeys } from "../src/browserHybridPasskeys";
import { BROWSER_SESSION_PARTITION, DesktopBrowserManager } from "../src/browserManager";
import { registerBrowserPasskeyAccounts } from "../src/browserPasskeys";
import { startPasskeyTestSite } from "./browser-hybrid-passkey-smoke-site";

const home = app.commandLine.getSwitchValue("smoke-home");
assert.ok(home);
app.setPath("userData", join(home, "profile"));
const phone = process.argv.includes("--phone");
const simulateFocus = process.argv.includes("--simulate-focus");
let phase = "initialization";
function finish(result: string, error = false) {
  writeFileSync(join(home, "result"), result, { mode: 0o600 });
  app.exit(error ? 1 : 0);
}

async function waitFor<T>(
  read: () => T | undefined | false | Promise<T | undefined | false>,
  timeout = 10000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  do {
    const result = await read();
    if (result) return result;
    await delay(40);
  } while (Date.now() < deadline);
  throw new Error("Timed out");
}

async function requestFrom(contents: WebContents) {
  await contents.executeJavaScript(
    `window.smokeResult = null;
    navigator.credentials.get({publicKey:{rpId:location.hostname, challenge:crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials:[{type:"public-key",id:crypto.getRandomValues(new Uint8Array(32)),transports:["hybrid"]}],hints:["hybrid"],timeout:60000}})
      .then(()=>window.smokeResult="resolved",error=>window.smokeResult=error.name); true`,
    true,
  );
}

async function smoke() {
  await app.whenReady();
  const site = await startPasskeyTestSite();
  const owner = new BrowserWindow({
    width: 850,
    height: 640,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const manager = new DesktopBrowserManager();
  manager.setWindow(owner);
  const threadId = ThreadId.makeUnsafe("phone-smoke");
  const tabId = manager.open({ threadId }).activeTabId!;
  manager.setPanelBounds({
    threadId,
    visible: true,
    bounds: { x: 0, y: 0, width: 800, height: 560 },
  });
  const { webContents: contents } = manager.getVisibleAutomationRuntime({ threadId, tabId });
  const partition = session.fromPartition(BROWSER_SESSION_PARTITION);
  phase = "patched browser session API";
  const capability = partition as typeof partition & { isWebAuthnHybridEnabled?: () => boolean };
  assert.equal(capability.isWebAuthnHybridEnabled?.(), false);
  const human = (page: WebContents) => manager.isVisibleBrowserContents(page);
  const removeAccounts = registerBrowserPasskeyAccounts(partition, human);
  const removeHybrid = registerBrowserHybridPasskeys(partition, human);
  assert.equal(capability.isWebAuthnHybridEnabled?.(), true);
  const guard = getBetterwrightNetworkGuard(partition);
  const nativeFocusedWindow = BrowserWindow.getFocusedWindow;
  const nativeGuestFocused = contents.isFocused;
  try {
    phase = "initialize the managed browser network guard";
    await guard.initialize();
    await contents.loadURL(site.origin);
    owner.show();
    app.focus({ steal: true });
    owner.focus();
    contents.focus();
    if (phone) {
      phase = "physical registration and signed assertion; use Register and Verify in the window";
      let phoneAssertionConnected = false;
      const events: NodeJS.EventEmitter = partition;
      events.on("webauthn-hybrid-status", (_event, details) => {
        if (
          site.registered() &&
          details.frame === contents.mainFrame &&
          details.origin === site.origin &&
          details.status === "ready"
        ) {
          phoneAssertionConnected = true;
        }
      });
      await waitFor(site.signedIn, 480000);
      assert.ok(phoneAssertionConnected);
      await waitFor(() => contents.getURL() === site.origin + "/account");
      await waitFor(() => contents.executeJavaScript("!!document.getElementById('signed-in')"));
      await delay(2000);
      return "PASS verified the physical phone's signature, challenge, origin and user verification; the same tab signed in with its HttpOnly session cookie";
    }
    if (simulateFocus) {
      BrowserWindow.getFocusedWindow = () =>
        BrowserWindow.getAllWindows().find(
          (window) => window.getParentWindow() === owner && window.isVisible(),
        ) ?? owner;
      contents.isFocused = () => BrowserWindow.getFocusedWindow() === owner;
    }
    phase = `foreground (ownerVisible=${owner.isVisible()}, ownerFocused=${owner.isFocused()}, focusedWindowMatches=${BrowserWindow.getFocusedWindow() === owner}, guestFocused=${contents.isFocused()}, managed=${human(contents)})`;
    await waitFor(() => contents.isFocused() && BrowserWindow.getFocusedWindow() === owner);
    assert.ok(human(contents));
    const events: NodeJS.EventEmitter = partition;
    let firstPayloadDigest = "";
    events.on(
      "webauthn-hybrid-qr",
      (_event: unknown, details: { frame: Electron.WebFrameMain; qr: string }) => {
        if (details.frame === contents.mainFrame && /^FIDO:\/[0-9]+$/u.test(details.qr))
          firstPayloadDigest = createHash("sha256").update(details.qr).digest("hex");
      },
    );
    const windowForQr = () =>
      BrowserWindow.getAllWindows().find(
        (w) =>
          w.getParentWindow() === owner && w.isVisible() && w.getTitle() === "Use a phone passkey",
      );
    phase = "native QR in the Synara managed tab";
    await requestFrom(contents);
    const modal = await waitFor(windowForQr);
    assert.ok(modal.isModal() && !human(modal.webContents));
    assert.ok(firstPayloadDigest);
    phase = "decode Synara dialog pixels and check the requesting site";
    const label = await modal.webContents.executeJavaScript(
      "document.getElementById('origin').textContent",
    );
    assert.equal(label, new URL(site.origin).host);
    const png: string = await modal.webContents.executeJavaScript(
      "document.getElementById('qr').toDataURL('image/png').split(',')[1]",
    );
    const digest = execFileSync(join(home, "decode"), {
      input: Buffer.from(png, "base64"),
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    assert.ok(digest === firstPayloadDigest, "QR pixels did not match the native event");
    phase = "concurrent guest cannot replace or cancel the active QR";
    const unrelated = new WebContentsView({
      webPreferences: {
        session: partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    try {
      await unrelated.webContents.loadURL(site.origin);
      await requestFrom(unrelated.webContents);
      assert.equal(
        await waitFor(() => unrelated.webContents.executeJavaScript("window.smokeResult")),
        "NotAllowedError",
      );
      assert.ok(
        windowForQr() === modal && (await contents.executeJavaScript("window.smokeResult===null")),
      );
    } finally {
      unrelated.webContents.close();
    }
    phase = "same-document navigation dismisses the original native request";
    await contents.executeJavaScript("location.hash='navigation'; true");
    await waitFor(() => modal.isDestroyed());
    assert.equal(
      await waitFor(() => contents.executeJavaScript("window.smokeResult")),
      "NotAllowedError",
    );
    phase = "next request has a fresh QR and the Cancel control rejects it";
    owner.focus();
    contents.focus();
    await waitFor(() => contents.isFocused() && BrowserWindow.getFocusedWindow() === owner);
    const previous = firstPayloadDigest;
    await requestFrom(contents);
    const next = await waitFor(windowForQr);
    assert.ok(firstPayloadDigest !== previous);
    await next.webContents
      .executeJavaScript("document.getElementById('cancel').click(); true")
      .catch(() => undefined);
    await waitFor(() => next.isDestroyed());
    assert.equal(
      await waitFor(() => contents.executeJavaScript("window.smokeResult")),
      "NotAllowedError",
    );
    return (
      "PASS native Chromium phone QR, exact canvas decode, managed tab, concurrency, navigation, fresh request and cancel; " +
      (simulateFocus ? "foreground checks simulated" : "foreground checks native")
    );
  } finally {
    BrowserWindow.getFocusedWindow = nativeFocusedWindow;
    contents.isFocused = nativeGuestFocused;
    removeHybrid();
    removeAccounts();
    manager.dispose();
    owner.destroy();
    site.close();
    await guard.dispose();
  }
}
setTimeout(() => finish("FAIL timeout during " + phase, true), phone ? 500000 : 90000).unref();
smoke().then(
  (result) => finish(result),
  () => finish("FAIL during " + phase, true),
);

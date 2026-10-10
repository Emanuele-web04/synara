// Exercises real Chromium viewport recovery after browser_resize emulation.
// Uses an isolated Electron profile and a synthetic page through DesktopBrowserManager.
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, nativeImage } from "electron";
import { ThreadId } from "@synara/contracts";
import { DesktopBrowserManager } from "../src/browserManager";

const home = mkdtempSync(join(tmpdir(), "synara-browser-viewport-"));
app.setPath("userData", home);
const deadline = setTimeout(() => app.exit(1), 30_000);

async function smoke(): Promise<void> {
  await app.whenReady();
  const window = new BrowserWindow({ width: 1000, height: 760, show: true });
  const manager = new DesktopBrowserManager();
  manager.setWindow(window);
  const threadId = ThreadId.makeUnsafe("viewport-smoke");
  const bounds = { x: 0, y: 0, width: 900, height: 650 };
  const setBounds = (next: typeof bounds) =>
    manager.setPanelBounds({ threadId, surface: "native", bounds: next });
  try {
    const state = manager.open({ threadId });
    setBounds(bounds);
    const { webContents } = manager.getVisibleAutomationRuntime({
      threadId,
      tabId: state.activeTabId!,
    });
    await webContents.loadURL(
      `data:text/html,${encodeURIComponent("<style>html,body{margin:0;width:100%;height:100%;background:#222;color:white}main{box-sizing:border-box;width:100%;height:100%;border:12px solid lime;display:grid;place-items:center;font:30px system-ui}</style><main>PAGE EDGE</main>")}`,
    );
    await webContents.executeJavaScript('document.body.dataset.sentinel = "kept"');
    webContents.debugger.attach("1.3");
    const viewport = () => webContents.executeJavaScript("({width:innerWidth,height:innerHeight})");
    const waitForViewport = async (expected: { width: number; height: number }) => {
      // View resizing crosses Chromium processes; poll the resulting layout, not a mock.
      for (let attempt = 0; attempt < 100; attempt++) {
        const actual = await viewport();
        if (actual.width === expected.width && actual.height === expected.height) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.deepEqual(await viewport(), expected);
    };
    for (const width of [400, 1400]) {
      await webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
        width,
        height: 600,
        deviceScaleFactor: 0,
        mobile: false,
        screenWidth: width,
        screenHeight: 600,
      });
      await waitForViewport({ width, height: 600 });
      setBounds({ ...bounds, x: 1 });
      assert.deepEqual(await viewport(), { width, height: 600 });
      setBounds({ ...bounds, width: 700, height: 500 });
      await waitForViewport({ width: 700, height: 500 });
      assert.equal(await webContents.executeJavaScript("document.body.dataset.sentinel"), "kept");
      assert.equal(
        manager.getVisibleAutomationRuntime({ threadId, tabId: state.activeTabId! }).webContents,
        webContents,
      );
      setBounds(bounds);
      await waitForViewport(bounds);
      console.log(`Viewport ${width}x600 recovered to 700x500 and 900x650 without reloading.`);
    }
    await manager.getAutomationRuntime({ threadId, tabId: state.activeTabId! }, { restore: false });
    const browserView = window.contentView.children.find(
      (view) => "webContents" in view && view.webContents === webContents,
    );
    assert.ok(browserView);
    const liveImage = await webContents.capturePage();
    manager.setPanelBounds({ threadId, surface: "native", bounds: null, occluded: true });
    assert.deepEqual(browserView.getBounds(), { ...bounds, x: 0, y: 0 });
    assert.deepEqual(await viewport(), { width: bounds.width, height: bounds.height });
    const preview = await manager.capturePreview({ threadId, tabId: state.activeTabId! });
    assert.ok(preview, "An obscured native page must supply a visible replacement frame.");
    const previewImage = nativeImage.createFromDataURL(preview);
    assert.deepEqual(previewImage.getSize(), liveImage.getSize());
    const [blue, green, red] = previewImage.toBitmap();
    assert.ok(
      green! > 180 && green! > red! + 100 && green! > blue! + 100,
      "The frame must contain the page's lime border.",
    );
    setBounds(bounds);
    assert.equal(await webContents.executeJavaScript("document.body.dataset.sentinel"), "kept");
    assert.equal(
      manager.getVisibleAutomationRuntime({ threadId, tabId: state.activeTabId! }).webContents,
      webContents,
    );
    assert.equal(await manager.capturePreview({ threadId, tabId: state.activeTabId! }), null);
    console.log(
      "Native overlay preview retained full-size page pixels and restored the same live document.",
    );
    // The real window's closed handler calls setWindow(null) after Electron has
    // destroyed its native contentView. Automation pages must still be released.
    await manager.getAutomationRuntime({ threadId, tabId: state.activeTabId! }, { restore: false });
    window.destroy();
    assert.doesNotThrow(() => manager.setWindow(null));
    assert.equal(webContents.isDestroyed(), true);
    console.log("Closed-window automation teardown released its page without touching dead views.");
  } finally {
    manager.dispose();
    if (!window.isDestroyed()) window.destroy();
  }
}

void smoke()
  .then(() => {
    clearTimeout(deadline);
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

import { strict as assert } from "node:assert";
import { once } from "node:events";
import { join } from "node:path";
import { app, BrowserWindow, type WebContents } from "electron";
import { ThreadId } from "@synara/contracts";
import { BrowserSessionRestore } from "../src/browserAutomation/browserSessionRestore";
import { createCookieSessionBackend } from "../src/browserAutomation/electronCookieSession";
import { BROWSER_SESSION_PARTITION, DesktopBrowserManager } from "../src/browserManager";
import { BROWSER_IPC_CHANNELS } from "../src/ipcChannels";

const [phase, origin, home] = process.argv.slice(-3);
assert.ok(home && origin && phase);
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
app.setPath("userData", home);

// Exercise the sandboxed preload and trusted Chromium input in a real OAuth
// popup. The hidden window emulates focus and supplies a deterministic menu choice.
async function checkEmailFields(contents: WebContents) {
  // The window is intentionally hidden. Chromium needs an active-document
  // focus state to route the ArrowDown gesture and fill the focused field.
  contents.debugger.attach();
  await contents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
  const submitted: string[] = [];
  contents.ipc.on(BROWSER_IPC_CHANNELS.email.remember, (_event, email: string) =>
    submitted.push(email),
  );
  contents.ipc.handle(BROWSER_IPC_CHANNELS.email.choose, () => submitted[0] ?? null);
  await contents.executeJavaScript(`
    document.body.innerHTML = '<form><input id="newsletter" type="email"></form><form><input id="login" autocomplete="username"></form>';
    document.addEventListener('submit', e => e.preventDefault());
    document.querySelector('#newsletter').focus();
  `);
  await contents.insertText("unrelated@example.test");
  await contents.executeJavaScript(`
    document.querySelector('#newsletter').form.requestSubmit();
    document.querySelector('#login').focus();
  `);
  await contents.insertText("fixture@example.test");
  const saved = once(contents.ipc, BROWSER_IPC_CHANNELS.email.remember, {
    signal: AbortSignal.timeout(5_000),
  });
  await contents.executeJavaScript(`
    const login = document.querySelector('#login');
    login.form.requestSubmit();
    login.value = '';
    window.filled = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('The focused login field was not filled')), 5000);
      login.addEventListener('change', () => {
        clearTimeout(timeout);
        resolve([login.value, document.querySelector('#newsletter').value]);
      }, {once:true});
    });
    true;
  `);
  await saved;
  assert.deepEqual(submitted, ["fixture@example.test"]);
  contents.sendInputEvent({ type: "keyDown", keyCode: "Down" });
  contents.sendInputEvent({ type: "keyUp", keyCode: "Down" });
  assert.deepEqual(await contents.executeJavaScript("window.filled"), [
    "fixture@example.test",
    "unrelated@example.test",
  ]);
}

async function smoke(phase: string, origin: string, home: string) {
  await app.whenReady();
  const window = new BrowserWindow({ show: false });
  const manager = new DesktopBrowserManager({
    annotationPreloadPath: join(import.meta.dirname, "login-email-guest.cjs"),
  });
  manager.setWindow(window);
  const restore = new BrowserSessionRestore(
    join(home, "session-restore"),
    createCookieSessionBackend(BROWSER_SESSION_PARTITION),
    // Only the OS key-wrapping service is substituted. The synthetic profile is
    // discarded after the run and never needs access to the user's keychain.
    {
      available: async () => true,
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => value.toString(),
    },
  );
  const openChat = (name: string) => {
    const threadId = ThreadId.makeUnsafe(name);
    const tabId = manager.open({ threadId }).activeTabId!;
    manager.setPanelBounds({
      threadId,
      surface: "native",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    });
    return {
      threadId,
      contents: manager.getVisibleAutomationRuntime({ threadId, tabId }).webContents,
    };
  };
  const checkAccount = async (contents: WebContents, signedIn: boolean) => {
    await contents.loadURL(`${origin}/account`);
    assert.equal(
      await contents.executeJavaScript("document.querySelector('h1').textContent"),
      signedIn ? "Signed in" : "Fixture sign-in",
    );
  };
  try {
    await restore.initialize();
    if (phase === "sign-in") {
      const first = openChat("first-chat");
      await checkAccount(first.contents, false);
      await first.contents.executeJavaScript(
        'window.open("/account", "auth", "width=480,height=640"); true;',
        true,
      );
      const popup = manager
        .getState({ threadId: first.threadId })
        .tabs.find((tab) => tab.openerTabId);
      assert.ok(popup);
      const child = manager.getVisibleAutomationRuntime({
        threadId: first.threadId,
        tabId: popup.id,
      }).webContents;
      if (child.getURL() !== `${origin}/account` || child.isLoading()) {
        await once(child, "did-finish-load", { signal: AbortSignal.timeout(5_000) });
      }
      await checkEmailFields(child);
      manager.closeTab({ threadId: first.threadId, tabId: popup.id });
      const signedIn = once(first.contents, "did-finish-load");
      await first.contents.executeJavaScript(`
        localStorage.setItem('profile-smoke', 'synthetic');
        document.querySelector('[name=username]').value = 'fixture-user';
        document.querySelector('[name=password]').value = 'SynaraFixtureOnly42!';
        document.querySelector('form').requestSubmit();
      `);
      await signedIn;
      assert.equal(first.contents.getURL(), `${origin}/account`);
      const closed = once(first.contents, "destroyed");
      manager.close({ threadId: first.threadId });
      await closed;
    }
    const { contents } = openChat("another-chat");
    await checkAccount(contents, phase !== "after-sign-out");
    assert.equal(
      await contents.executeJavaScript("localStorage.getItem('profile-smoke')"),
      "synthetic",
    );
    await checkAccount(window.webContents, false);
    assert.equal(
      await window.webContents.executeJavaScript("localStorage.getItem('profile-smoke')"),
      null,
    );
    if (phase === "restart") {
      await contents.executeJavaScript("fetch('/signout', {method: 'POST'}).then(r => r.text())");
      await checkAccount(contents, false);
    }
  } finally {
    manager.dispose();
    try {
      await restore.shutdown();
    } finally {
      window.destroy();
    }
  }
  console.log(`Browser profile smoke passed (${phase}).`);
}

void smoke(phase, origin, home).then(
  () => app.quit(),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);

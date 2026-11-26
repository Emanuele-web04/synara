import { strict as assert } from "node:assert";
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { join } from "node:path";
import { app, BrowserWindow, Menu, type WebContents } from "electron";
import { ThreadId } from "@synara/contracts";
import { BrowserVault } from "../src/browserAutomation/browserVault";
import { BrowserEmailHistory } from "../src/browserAutomation/browserEmailHistory";
import { registerLoginEmailMenu } from "../src/browserAutomation/loginEmailMenu";
import { BrowserSessionRestore } from "../src/browserAutomation/browserSessionRestore";
import { createCookieSessionBackend } from "../src/browserAutomation/electronCookieSession";
import { BROWSER_SESSION_PARTITION, DesktopBrowserManager } from "../src/browserManager";
import { BROWSER_IPC_CHANNELS } from "../src/ipcChannels";
import type {
  LoginFieldChoice,
  LoginFieldChoiceRequest,
} from "../src/browserAutomation/loginEmail";

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
  const chosen = new EventEmitter();
  const account = { username: "fixture@example.test", password: "synthetic-smoke-only" };
  const submitted: string[] = [];
  contents.ipc.on(BROWSER_IPC_CHANNELS.email.remember, (_event, email: string) =>
    submitted.push(email),
  );
  contents.ipc.handle(
    BROWSER_IPC_CHANNELS.email.choose,
    (_event, request: LoginFieldChoiceRequest) =>
      new Promise<LoginFieldChoice | null>((resolve) => chosen.emit("menu", request, resolve)),
  );
  const evaluate = (js: string) => contents.executeJavaScript(js);
  const markup = (html: string) =>
    evaluate(`document.body.innerHTML = ${JSON.stringify(html)}; true;`);
  const focus = (id: string) => evaluate(`document.getElementById(${JSON.stringify(id)}).focus()`);
  const press = (keyCode: string) => {
    const key =
      keyCode === "Shift+Tab" ? { keyCode: "Tab", modifiers: ["shift" as const] } : { keyCode };
    contents.sendInputEvent({ type: "keyDown", ...key });
    contents.sendInputEvent({ type: "keyUp", ...key });
  };
  const choose = async (key: string, value: LoginFieldChoice | null, beforeReply?: string) => {
    const open = once(chosen, "menu", { signal: AbortSignal.timeout(5000) });
    press(key);
    const [request, reply] = await open.catch((cause) => {
      throw new Error(`The login picker did not open after ${key}`, { cause });
    });
    if (beforeReply) await evaluate(beforeReply);
    reply(value);
    // Wait through a renderer task after delivering Electron's IPC reply.
    await evaluate("new Promise(resolve => setTimeout(resolve, 20))");
    return request as LoginFieldChoiceRequest;
  };

  await markup(
    '<form aria-label="Newsletter"><input id="newsletter" type="email"></form><main aria-label="Sign in"><button id="previous">Back</button><input id="email" name="email" type="email"><button type="button" id="next">Continue</button></main>',
  );
  await evaluate("document.addEventListener('submit', e => e.preventDefault());");
  await focus("newsletter");
  await contents.insertText("unrelated@example.test");
  await evaluate("document.querySelector('#newsletter').form.requestSubmit()");
  await focus("email");
  await contents.insertText(account.username);
  const saved = once(contents.ipc, BROWSER_IPC_CHANNELS.email.remember, {
    signal: AbortSignal.timeout(5000),
  });
  const point = await evaluate(
    "const r=document.querySelector('#next').getBoundingClientRect(); ({x:r.x+r.width/2,y:r.y+r.height/2})",
  );
  for (const type of ["mousePressed", "mouseReleased"]) {
    await contents.debugger.sendCommand("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "left",
      clickCount: 1,
    });
  }
  await saved.catch((cause) => {
    throw new Error("The SPA login button did not remember the email", { cause });
  });
  assert.deepEqual(submitted, [account.username], "Only the continued login step is learned");
  await evaluate("document.querySelector('#email').value = ''");
  await focus("previous");
  assert.deepEqual(await choose("Tab", null), {
    field: "email",
    prefix: "",
    acceptsPassword: false,
  });
  assert.equal(
    await evaluate("document.activeElement.id"),
    "email",
    "Cancelling keeps the Tab destination focused",
  );
  press("Tab");
  // A cancelled menu does not reopen by itself or trap subsequent Tab navigation.
  assert.equal(await evaluate("document.activeElement.id"), "next");
  await choose("Shift+Tab", { username: account.username });
  assert.deepEqual(await evaluate("[email.value, newsletter.value]"), [
    account.username,
    "unrelated@example.test",
  ]);

  await markup(
    '<form aria-label="Sign in"><input id="user" name="username"><input id="pw" type="password"><button>Sign in</button></form>',
  );
  await focus("user");
  assert.deepEqual(await choose("Down", account), {
    field: "username",
    prefix: "",
    acceptsPassword: true,
  });
  assert.equal(
    await evaluate("user.value === 'fixture@example.test' && pw.value === 'synthetic-smoke-only'"),
    true,
  );

  await markup(
    '<form><input name="username" type="hidden" value="fixture@example.test"><input id="pw" type="password" autocomplete="current-password"></form>',
  );
  await focus("pw");
  assert.deepEqual(await choose("Down", account), {
    field: "password",
    prefix: "",
    formUsername: account.username,
    acceptsPassword: true,
  });
  assert.equal(await evaluate("pw.value === 'synthetic-smoke-only'"), true);

  await markup(
    '<form action="/login"><input id="user" autocomplete="username"><input id="pw" type="password" autocomplete="current-password"></form>',
  );
  await focus("user");
  await choose("Down", account, "pw.type = 'text'");
  assert.equal(await evaluate("pw.value"), "", "A mutated field must not receive a secret");
  await evaluate(
    "pw.type='password'; user.addEventListener('input', () => pw.type='text', {once:true})",
  );
  await choose("Down", account);
  assert.equal(
    await evaluate("pw.value"),
    "",
    "Username listeners can synchronously change the password target",
  );

  await markup(
    '<form action="/register"><input id="pw" type="password" autocomplete="new-password"></form><form action="/login"><input id="user" autocomplete="username"></form>',
  );
  await focus("pw");
  let unexpected = false;
  chosen.once("menu", (_request, reply) => {
    unexpected = true;
    reply(null);
  });
  press("Down");
  await evaluate("new Promise(resolve => setTimeout(resolve, 20))");
  assert.equal(unexpected, false, "Signup never offers saved passwords");
  chosen.removeAllListeners("menu");
  await markup('<form><input id="pw" type="password" autocomplete="current-password"></form>');
  await focus("pw");
  await choose("Down", account);
  await evaluate(`
    const oldPassword = document.querySelector('#pw');
    if (!oldPassword.value) throw new Error('The password step was not filled');
    oldPassword.remove();
    window.addEventListener('pagehide', () => sessionStorage.setItem('cleared-password', String(oldPassword.value === '')), {once:true});
  `);
  await contents.debugger.sendCommand("HeapProfiler.collectGarbage");
  await contents.loadURL(new URL("/account", contents.getURL()).href);
  assert.equal(
    await evaluate("sessionStorage.getItem('cleared-password')"),
    "true",
    "Leaving a page clears a filled password even when its SPA removed the field",
  );
}

// Exercise Chromium's real WebAuthn API and verify its assertion outside the page.
// The authenticator is virtual. OS selection, Bluetooth and phone approval require hardware.
async function checkPasskeyAssertion(contents: WebContents, origin: string) {
  const site = new URL(origin);
  site.hostname = "localhost";
  await contents.loadURL(site.href);
  if (!contents.debugger.isAttached()) contents.debugger.attach();
  const cdp = contents.debugger;
  await cdp.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
  await cdp.sendCommand("WebAuthn.enable");
  const { authenticatorId } = await cdp.sendCommand("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "usb",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  try {
    const key = await contents.executeJavaScript(
      `
      (async () => {
        const credential = await navigator.credentials.create({publicKey:{
          rp:{name:'Synara local fixture', id:'localhost'},
          user:{id:crypto.getRandomValues(new Uint8Array(16)), name:'fixture', displayName:'Fixture'},
          challenge:crypto.getRandomValues(new Uint8Array(32)), pubKeyCredParams:[{type:'public-key',alg:-7}],
          authenticatorSelection:{residentKey:'required', userVerification:'required'},timeout:5000,
        }});
        return {id:Array.from(new Uint8Array(credential.rawId)), publicKey:Array.from(new Uint8Array(credential.response.getPublicKey()))};
      })()
    `,
      true,
    );
    const challenge = randomBytes(32);
    const response = await contents.executeJavaScript(
      `
      (async () => {
        const {response} = await navigator.credentials.get({publicKey:{
          challenge:new Uint8Array(${JSON.stringify([...challenge])}), rpId:'localhost', timeout:5000,
          allowCredentials:[{type:'public-key', id:new Uint8Array(${JSON.stringify(key.id)})}], userVerification:'required',
        }});
        return [response.clientDataJSON, response.authenticatorData, response.signature].map(bytes => Array.from(new Uint8Array(bytes)));
      })()
    `,
      true,
    );
    const client = Buffer.from(response[0]);
    const auth = Buffer.from(response[1]);
    const parsed = JSON.parse(client.toString());
    assert.equal(parsed.origin, site.origin);
    assert.equal(parsed.type, "webauthn.get");
    assert.equal(parsed.challenge, challenge.toString("base64url"));
    assert.deepEqual(auth.subarray(0, 32), createHash("sha256").update(site.hostname).digest());
    assert.equal(auth[32]! & 5, 5, "User presence and verification flags");
    assert.ok(
      verify(
        "sha256",
        Buffer.concat([auth, createHash("sha256").update(client).digest()]),
        createPublicKey({ key: Buffer.from(key.publicKey), format: "der", type: "spki" }),
        Buffer.from(response[2]),
      ),
    );
  } finally {
    await cdp.sendCommand("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
    await cdp.sendCommand("WebAuthn.disable");
  }
}

// Keep the guest, scoped menu handler, encrypted vault, and site's form submission real.
// Only window focus and the user's click on the native menu are substituted in this hidden app.
async function signInFromVault(
  contents: WebContents,
  window: BrowserWindow,
  origin: string,
  home: string,
) {
  const keys = {
    available: async () => true,
    encrypt: (value: string) => Buffer.from(value),
    decrypt: (value: Buffer) => value.toString(),
  };
  const vault = new BrowserVault(join(home, "vault-smoke"), keys);
  const username = "fixture-user";
  const history = new BrowserEmailHistory(join(home, "emails"), keys);
  const dispose = registerLoginEmailMenu(
    contents,
    history,
    vault,
    () => true,
    () => ({
      release: () => {},
      ready: Promise.resolve(),
    }),
  );
  const popup = Menu.prototype.popup;
  const getFocusedWindow = BrowserWindow.getFocusedWindow;
  const isFocused = contents.isFocused;
  try {
    await vault.configure({ agentUse: false, offerSave: true, autosave: false });
    await vault.saveCaptured(origin, { username, password: "SynaraFixtureOnly42!" }, "user");
    BrowserWindow.getFocusedWindow = () => window;
    contents.isFocused = () => true;
    Menu.prototype.popup = function (options) {
      const item = this.items.find((item) => item.label === username);
      assert.ok(item && item.enabled);
      item.click(undefined, window, { triggeredByAccelerator: false });
      options?.callback?.();
    };
    if (!contents.debugger.isAttached()) contents.debugger.attach();
    await contents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    await contents.executeJavaScript(`
      localStorage.setItem('profile-smoke', 'synthetic');
      document.querySelector('[name=username]').focus();
      document.querySelector('[name=password]').addEventListener('change', () => {
        document.querySelector('form').requestSubmit();
      }, {once:true});
    `);
    const signedIn = once(contents, "did-finish-load", { signal: AbortSignal.timeout(5000) });
    contents.sendInputEvent({ type: "keyDown", keyCode: "Down" });
    contents.sendInputEvent({ type: "keyUp", keyCode: "Down" });
    await signedIn;
    assert.equal(
      await contents.executeJavaScript("document.querySelector('h1').textContent"),
      "Signed in",
    );
  } finally {
    dispose();
    Menu.prototype.popup = popup;
    BrowserWindow.getFocusedWindow = getFocusedWindow;
    contents.isFocused = isFocused;
    vault.dispose();
  }
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
      await checkPasskeyAssertion(child, origin);
      manager.closeTab({ threadId: first.threadId, tabId: popup.id });
      await signInFromVault(first.contents, window, origin, home);
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

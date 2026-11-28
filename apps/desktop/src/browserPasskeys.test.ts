import { EventEmitter } from "node:events";
import type { MenuItemConstructorOptions, Session, WebContents } from "electron";
import { expect, it, vi } from "vitest";
import { configureBrowserTouchId, registerBrowserPasskeyAccounts } from "./browserPasskeys";

const ui = vi.hoisted(() => ({
  configure: vi.fn(),
  window: vi.fn(),
  fromFrame: vi.fn(),
  build: vi.fn<(template: MenuItemConstructorOptions[]) => unknown>(),
}));
vi.mock("electron", () => ({
  app: { isPackaged: true, configureWebAuthn: ui.configure },
  BrowserWindow: { getFocusedWindow: ui.window },
  webContents: { fromFrame: ui.fromFrame },
  Menu: { buildFromTemplate: ui.build },
}));

it.skipIf(process.platform !== "darwin")(
  "enables exactly the advertised channel's passkey group",
  () => {
    const group = "FIXTURE123.example.browser.webauthn";
    configureBrowserTouchId("example.browser.beta", group);
    configureBrowserTouchId("example.browser", undefined);
    expect(ui.configure).not.toHaveBeenCalled();
    configureBrowserTouchId("example.browser", group);
    expect(ui.configure.mock.calls).toEqual([[{ touchID: { keychainAccessGroup: group } }]]);
  },
);

it("lets the visible page's user choose a passkey and cancels stale or background requests once", () => {
  const session = new EventEmitter();
  const frame = { detached: false };
  const owner = new EventEmitter();
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: frame,
    session,
    isDestroyed: () => false,
    isFocused: () => true,
  });
  ui.window.mockReturnValue(owner);
  ui.fromFrame.mockReturnValue(contents);
  const menu = { popup: vi.fn(), closePopup: vi.fn() };
  ui.build.mockReturnValue(menu);
  const accounts = ["first", "second"].map((name) => ({ name, credentialId: `${name}-id` }));
  let human = true;
  const dispose = registerBrowserPasskeyAccounts(
    session as Session,
    (value: WebContents) => value === (contents as unknown as WebContents) && human,
  );
  const request = () => {
    const reply = vi.fn();
    session.emit(
      "select-webauthn-account",
      {},
      { accounts, frame, relyingPartyId: "example.test" },
      reply,
    );
    return reply;
  };
  const choose = () => {
    const item = ui.build.mock.lastCall?.[0].find((entry) => entry.label === "second");
    expect(item?.click).toBeTypeOf("function");
    (item!.click as () => void)();
  };
  const success = request();
  choose();
  expect(success.mock.calls).toEqual([["second-id"]]);
  const duringNavigation = request();
  contents.emit("did-start-navigation", { isMainFrame: true });
  choose();
  expect(duringNavigation.mock.calls).toEqual([[null]]);
  const takenOver = request();
  human = false;
  choose();
  expect(takenOver.mock.calls).toEqual([[null]]);
  expect(request().mock.calls).toEqual([[null]]);
  dispose();
});

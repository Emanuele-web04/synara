import { EventEmitter } from "node:events";
import type { IpcMainInvokeEvent, MenuItemConstructorOptions, WebContents } from "electron";
import { expect, it, vi } from "vitest";
import { BROWSER_IPC_CHANNELS } from "../ipcChannels";
import type { LoginFieldChoice, LoginFieldChoiceRequest } from "./loginEmail";
import { registerLoginEmailMenu } from "./loginEmailMenu";

const menu = vi.hoisted(() => ({
  owner: {},
  popup: vi.fn(),
  closePopup: vi.fn(),
  build: vi.fn<(template: MenuItemConstructorOptions[]) => unknown>(),
}));
vi.mock("electron", () => ({
  BrowserWindow: { getFocusedWindow: () => menu.owner },
  Menu: { buildFromTemplate: menu.build },
}));

const username = "synthetic@example.test";
const login = { username, password: "fixture-secret" };
const request: LoginFieldChoiceRequest = { field: "username", prefix: "", acceptsPassword: true };
function setup() {
  vi.clearAllMocks();
  menu.build.mockReturnValue(menu);
  const ipc = Object.assign(new EventEmitter(), { handle: vi.fn(), removeHandler: vi.fn() });
  const frame = {
    origin: "https://accounts.example",
    url: "https://accounts.example/login",
    detached: false,
  };
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: frame,
    ipc,
    isFocused: () => true,
    isDestroyed: () => false,
  });
  const human = vi.fn(() => true);
  const history = {
    matching: vi.fn(async () => [username, "other@example.test"]),
    remember: vi.fn(),
  };
  const vault = {
    savedLoginsForOrigin: vi.fn(async () => [{ id: "ID", username }]),
    fillSelectedLogin: vi.fn(async () => login),
  };
  const release = vi.fn();
  const protect = vi.fn(() => ({ release, ready: Promise.resolve() }));
  const dispose = registerLoginEmailMenu(
    contents as unknown as WebContents,
    history,
    vault,
    human,
    protect,
  );
  const handler = ipc.handle.mock.calls[0]![1] as (
    event: Pick<IpcMainInvokeEvent, "senderFrame">,
    input: LoginFieldChoiceRequest,
  ) => Promise<LoginFieldChoice | null>;
  const choose = (input = request, sender = frame) =>
    handler({ senderFrame: sender } as Pick<IpcMainInvokeEvent, "senderFrame">, input);
  const click = (name: string) =>
    (menu.build.mock.lastCall![0].find((item) => item.label === name)!.click as () => void)();
  const dismiss = () => menu.popup.mock.lastCall![0].callback();
  return {
    contents,
    ipc,
    frame,
    human,
    history,
    vault,
    release,
    protect,
    dispose,
    choose,
    click,
    dismiss,
  };
}

it("rejects subframes, agent input and selections from a previous document", async () => {
  const f = setup();
  expect(await f.choose(request, { ...f.frame })).toBeNull();
  f.human.mockReturnValue(false);
  expect(await f.choose()).toBeNull();
  f.ipc.emit(BROWSER_IPC_CHANNELS.email.remember, { senderFrame: f.frame }, username);
  expect(f.history.matching).not.toHaveBeenCalled();
  expect(f.history.remember).not.toHaveBeenCalled();
  f.human.mockReturnValue(true);
  const selected = f.choose();
  await vi.waitFor(() => expect(menu.popup).toHaveBeenCalledOnce());
  f.contents.emit("did-start-navigation", { isMainFrame: false });
  expect(menu.closePopup).not.toHaveBeenCalled();
  f.contents.emit("did-start-navigation", { isMainFrame: true });
  f.click(username);
  expect(await selected).toBeNull();
  expect(f.vault.fillSelectedLogin).not.toHaveBeenCalled();
  f.dispose();
});

it("lists an account once and only reads its password on a password-capable step after explicit choice", async () => {
  const f = setup();
  f.vault.savedLoginsForOrigin.mockResolvedValueOnce([
    { id: "ID", username },
    { id: "other-id", username: "non-email-account" },
  ]);
  const first = f.choose({ ...request, field: "email", acceptsPassword: false });
  await vi.waitFor(() => expect(menu.popup).toHaveBeenCalledOnce());
  expect(menu.build.mock.lastCall![0].filter((item) => item.label === username)).toHaveLength(1);
  expect(menu.build.mock.lastCall![0].some((item) => item.label === "non-email-account")).toBe(
    false,
  );
  f.click(username);
  f.dismiss();
  expect(await first).toEqual({ username });
  expect(f.protect).not.toHaveBeenCalled();
  expect(f.vault.fillSelectedLogin).not.toHaveBeenCalled();
  const last = f.choose({ ...request, field: "password", formUsername: username });
  await vi.waitFor(() => expect(menu.popup).toHaveBeenCalledTimes(2));
  expect(f.history.matching).toHaveBeenCalledTimes(1);
  expect(f.vault.fillSelectedLogin).not.toHaveBeenCalled();
  f.click(username);
  f.dismiss();
  expect(await last).toEqual(login);
  expect(f.vault.fillSelectedLogin).toHaveBeenCalledWith(f.frame.origin, "ID", username);
  f.contents.emit("did-start-navigation", { isMainFrame: true });
  expect(f.release).not.toHaveBeenCalled();
  f.contents.emit("did-navigate");
  expect(f.release).toHaveBeenCalledOnce();
  f.dispose();
});

it("rechecks the document after draining agents and decrypting, and releases the chat on failure", async () => {
  const f = setup();
  f.vault.fillSelectedLogin.mockImplementationOnce(async () => {
    f.contents.emit("did-start-navigation", { isMainFrame: true });
    return login;
  });
  const pending = f.choose();
  await vi.waitFor(() => expect(menu.popup).toHaveBeenCalledOnce());
  f.click(username);
  expect(await pending).toBeNull();
  expect(f.release).toHaveBeenCalledOnce();
  f.dispose();
});

it("keeps history available when the vault is unavailable and cancels an unmatched password-only account", async () => {
  const f = setup();
  expect(await f.choose({ ...request, field: "password", formUsername: "different" })).toBeNull();
  f.vault.savedLoginsForOrigin.mockRejectedValueOnce(new Error("locked"));
  const pending = f.choose();
  await vi.waitFor(() => expect(menu.popup).toHaveBeenCalledOnce());
  f.click(username);
  expect(await pending).toEqual({ username });
  expect(f.protect).not.toHaveBeenCalled();
  f.dispose();
});

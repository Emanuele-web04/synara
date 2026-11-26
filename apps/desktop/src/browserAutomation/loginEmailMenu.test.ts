import { EventEmitter } from "node:events";
import type { IpcMainInvokeEvent, MenuItemConstructorOptions, WebContents } from "electron";
import { expect, it, vi } from "vitest";
import { BROWSER_IPC_CHANNELS } from "../ipcChannels";
import type { BrowserEmailHistory } from "./browserEmailHistory";
import { registerLoginEmailMenu } from "./loginEmailMenu";

const menu = vi.hoisted(() => ({
  popup: vi.fn(),
  closePopup: vi.fn(),
  build: vi.fn<(template: MenuItemConstructorOptions[]) => unknown>(),
}));
vi.mock("electron", () => ({
  BrowserWindow: { getFocusedWindow: () => ({}) },
  Menu: { buildFromTemplate: menu.build },
}));

it("keeps suggestions out of agent and subframe calls and drops a prior document's selection during navigation", async () => {
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
  let human = true;
  const history = { matching: vi.fn(async () => ["synthetic@example.test"]), remember: vi.fn() };
  const dispose = registerLoginEmailMenu(
    contents as unknown as WebContents,
    history as unknown as BrowserEmailHistory,
    () => human,
  );
  const choose = ipc.handle.mock.calls.find(
    ([channel]) => channel === BROWSER_IPC_CHANNELS.email.choose,
  )![1] as (
    event: Pick<IpcMainInvokeEvent, "senderFrame">,
    prefix: string,
  ) => Promise<string | null>;
  const event = { senderFrame: frame } as Pick<IpcMainInvokeEvent, "senderFrame">;
  const subframe = { senderFrame: { ...frame } } as Pick<IpcMainInvokeEvent, "senderFrame">;
  expect(await choose(subframe, "")).toBeNull();
  ipc.emit(BROWSER_IPC_CHANNELS.email.remember, subframe, "iframe@example.test");
  human = false;
  expect(await choose(event, "")).toBeNull();
  ipc.emit(BROWSER_IPC_CHANNELS.email.remember, event, "agent@example.test");
  expect(history.matching).not.toHaveBeenCalled();
  expect(history.remember).not.toHaveBeenCalled();
  human = true;
  const selected = choose(event, "");
  await vi.waitFor(() => expect(menu.popup).toHaveBeenCalledOnce());
  contents.emit("did-start-navigation", { isMainFrame: false });
  expect(menu.closePopup).not.toHaveBeenCalled();
  contents.emit("did-start-navigation", { isMainFrame: true });
  expect(menu.closePopup).toHaveBeenCalledOnce();
  // A queued click may still arrive before the native close callback.
  (menu.build.mock.calls[0]![0][0]!.click as () => void)();
  expect(await selected).toBeNull();
  dispose();
});

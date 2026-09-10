import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from "electron";
import type { DesktopPermissionSetup } from "./desktopPermissionSetup";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

export function registerDesktopPermissionIpc(
  ipc: IpcMain,
  options: {
    setup: () => DesktopPermissionSetup;
    mainWebContents: () => WebContents | undefined;
    revealApp: () => void;
    startDrag: (sender: WebContents) => void;
  },
): void {
  const channels = DESKTOP_IPC_CHANNELS.permissions;
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    event.sender === options.mainWebContents() && event.senderFrame === event.sender.mainFrame;
  const handle = (channel: string, action: (input: unknown) => unknown) => {
    ipc.removeHandler(channel);
    ipc.handle(channel, (event, input: unknown) => {
      if (!trusted(event)) throw new Error("Permission setup requires the main Synara window.");
      return action(input);
    });
  };
  handle(channels.getState, () => options.setup().getState());
  handle(channels.start, (feature) => {
    if (feature !== "computer" && feature !== "appsnap")
      throw new Error("Unknown permission setup.");
    return options.setup().start(feature);
  });
  handle(channels.stop, () => options.setup().stop());
  handle(channels.retry, () => options.setup().retry());
  handle(channels.revealApp, () => options.revealApp());
  ipc.removeAllListeners(channels.startDrag);
  ipc.on(channels.startDrag, (event) => {
    if (trusted(event)) options.startDrag(event.sender);
  });
}

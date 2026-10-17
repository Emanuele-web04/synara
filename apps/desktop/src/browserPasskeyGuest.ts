import { contextBridge, ipcRenderer } from "electron";
import { BROWSER_IPC_CHANNELS } from "./ipcChannels";
import { installPhonePasskeys } from "./browserPasskeyPage";

try {
  if (
    process.isMainFrame &&
    ipcRenderer.sendSync(BROWSER_IPC_CHANNELS.passkeys.available) === true
  ) {
    contextBridge.exposeInMainWorld("__synaraPhonePasskeys", {
      request: (input: unknown) => ipcRenderer.invoke(BROWSER_IPC_CHANNELS.passkeys.request, input),
      abort: (id: string) => ipcRenderer.invoke(BROWSER_IPC_CHANNELS.passkeys.abort, id),
    });
    contextBridge.executeInMainWorld({ func: installPhonePasskeys, args: [] });
  }
} catch {}

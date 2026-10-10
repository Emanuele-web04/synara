import { WebContentsView } from "electron";
import type { CookieSessionBackend } from "./browserSessionRestore";

export function createCookieSessionBackend(partition: string): CookieSessionBackend {
  const view = new WebContentsView({
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const contents = view.webContents;
  contents.debugger.attach("1.3");
  const ready = contents.loadURL("about:blank");
  const changedListeners = new Set<() => void>();
  return {
    async read() {
      await ready;
      const result = await view.webContents.debugger.sendCommand("Network.getAllCookies");
      return result.cookies;
    },
    async restore(cookies) {
      await ready;
      if (cookies.length)
        await view.webContents.debugger.sendCommand("Network.setCookies", { cookies });
    },
    onChange(listener) {
      contents.session.cookies.on("changed", listener);
      changedListeners.add(listener);
    },
    dispose() {
      for (const listener of changedListeners)
        contents.session.cookies.removeListener("changed", listener);
      changedListeners.clear();
      if (!view.webContents.isDestroyed()) view.webContents.close();
    },
  };
}

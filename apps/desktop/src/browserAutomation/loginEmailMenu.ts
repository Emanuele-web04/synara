import {
  BrowserWindow,
  Menu,
  type IpcMainEvent,
  type WebContents,
  type WebFrameMain,
} from "electron";
import { BROWSER_IPC_CHANNELS } from "../ipcChannels";
import type { BrowserEmailHistory } from "./browserEmailHistory";

export function registerLoginEmailMenu(
  contents: WebContents,
  history: BrowserEmailHistory,
  isHumanControlled: () => boolean,
): () => void {
  let menu: Menu | undefined;
  let navigation = 0;
  let disposed = false;
  const ipc = contents.ipc;
  const currentOrigin = (frame: WebFrameMain | null) => {
    if (
      disposed ||
      contents.isDestroyed() ||
      !frame ||
      frame.detached ||
      frame !== contents.mainFrame ||
      !isHumanControlled()
    )
      return null;
    const url = URL.parse(frame.url);
    if (!url || frame.origin !== url.origin) return null;
    if (
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
      return url.origin;
    return null;
  };
  const remember = (event: IpcMainEvent, value: unknown) => {
    const origin = currentOrigin(event.senderFrame);
    if (origin && contents.isFocused()) void history.remember(origin, value).catch(() => {});
  };
  ipc.on(BROWSER_IPC_CHANNELS.email.remember, remember);
  ipc.handle(BROWSER_IPC_CHANNELS.email.choose, async (event, prefix: unknown) => {
    const frame = event.senderFrame;
    const origin = currentOrigin(frame);
    const startedAt = navigation;
    if (!origin || typeof prefix !== "string" || prefix.length > 254 || !contents.isFocused())
      return null;
    const addresses = await history.matching(origin, prefix);
    const owner = BrowserWindow.getFocusedWindow();
    if (
      !owner ||
      navigation !== startedAt ||
      currentOrigin(frame) !== origin ||
      !contents.isFocused() ||
      menu ||
      addresses.length === 0
    )
      return null;
    return new Promise<string | null>((resolve) => {
      menu = Menu.buildFromTemplate(
        addresses.map((email) => ({
          label: process.platform === "darwin" ? email : email.replaceAll("&", "&&"),
          click: () =>
            resolve(navigation === startedAt && currentOrigin(frame) === origin ? email : null),
        })),
      );
      menu.popup({
        window: owner,
        callback: () => {
          menu = undefined;
          resolve(null);
        },
      });
    });
  });
  const onNavigation = (
    details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
  ) => {
    if (!details.isMainFrame) return;
    navigation++;
    menu?.closePopup();
  };
  contents.on("did-start-navigation", onNavigation);
  return () => {
    disposed = true;
    menu?.closePopup();
    contents.removeListener("did-start-navigation", onNavigation);
    ipc.removeListener(BROWSER_IPC_CHANNELS.email.remember, remember);
    ipc.removeHandler(BROWSER_IPC_CHANNELS.email.choose);
  };
}

import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from "electron";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";
import type { ProductAnalytics } from "./productAnalytics";

export function attachProductAnalyticsIpc(
  analytics: ProductAnalytics,
  trustedContents: () => WebContents | null,
): () => void {
  const channels = DESKTOP_IPC_CHANNELS.productAnalytics;
  const ownsMainFrame = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => {
    const contents = trustedContents();
    return Boolean(
      contents &&
      !contents.isDestroyed() &&
      event.sender === contents &&
      event.senderFrame === contents.mainFrame,
    );
  };
  const onTrack = (event: IpcMainEvent, input: unknown): void => {
    if (ownsMainFrame(event)) analytics.track(input);
  };
  ipcMain.removeHandler(channels.getState);
  ipcMain.removeHandler(channels.setEnabled);
  ipcMain.removeAllListeners(channels.track);
  ipcMain.handle(channels.getState, (event) =>
    ownsMainFrame(event) ? analytics.getState() : { enabled: false },
  );
  ipcMain.handle(channels.setEnabled, (event, enabled: unknown) =>
    ownsMainFrame(event) ? analytics.setEnabled(enabled) : { enabled: false },
  );
  ipcMain.on(channels.track, onTrack);
  return () => {
    ipcMain.removeHandler(channels.getState);
    ipcMain.removeHandler(channels.setEnabled);
    ipcMain.removeListener(channels.track, onTrack);
  };
}

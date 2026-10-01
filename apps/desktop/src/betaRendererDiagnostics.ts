import {
  DESKTOP_RENDERER_ERROR_MESSAGE_MAX_LENGTH,
  DESKTOP_RENDERER_ERROR_STACK_MAX_LENGTH,
} from "@synara/contracts";
import { ipcMain, type IpcMainEvent, type WebContents } from "electron";

import type { BetaDiagnostics } from "./betaDiagnostics";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

/** Only the Beta main-window frame can report bounded exception fields. */
export function attachBetaRendererDiagnostics(
  webContents: WebContents,
  diagnostics: BetaDiagnostics,
): void {
  const channels = DESKTOP_IPC_CHANNELS.betaDiagnostics;
  let capturesUnhandledErrors = false;
  const ownsEvent = (event: IpcMainEvent): boolean =>
    event.sender === webContents && event.senderFrame === webContents.mainFrame;
  const onReady = (event: IpcMainEvent): void => {
    if (ownsEvent(event)) capturesUnhandledErrors = true;
  };
  const onError = (event: IpcMainEvent, payload: unknown): void => {
    if (!ownsEvent(event) || payload === null || typeof payload !== "object") return;
    const { message, stack } = payload as { message?: unknown; stack?: unknown };
    if (
      typeof message !== "string" ||
      message.length === 0 ||
      message.length > DESKTOP_RENDERER_ERROR_MESSAGE_MAX_LENGTH ||
      (stack !== undefined &&
        (typeof stack !== "string" || stack.length > DESKTOP_RENDERER_ERROR_STACK_MAX_LENGTH))
    )
      return;
    diagnostics.trackError("renderer", {
      message,
      ...(typeof stack === "string" ? { stack } : {}),
    });
  };
  ipcMain.on(channels.rendererReady, onReady);
  ipcMain.on(channels.reportError, onError);
  webContents.on("destroyed", () => {
    ipcMain.removeListener(channels.rendererReady, onReady);
    ipcMain.removeListener(channels.reportError, onError);
  });
  webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) capturesUnhandledErrors = false;
  });
  webContents.on("console-message", (details) => {
    if (details.level !== "error" || typeof details.message !== "string") return;
    // Global exceptions/rejections are reported with their original stacks.
    // Keep the console fallback during startup and for browser-only errors
    // such as CORS failures, which do not dispatch a window error event.
    if (capturesUnhandledErrors && /^Uncaught\b/.test(details.message)) return;
    diagnostics.trackError("renderer", details.message);
  });
}

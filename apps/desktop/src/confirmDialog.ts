import { type BrowserWindow, dialog } from "electron";

const CONFIRM_BUTTON_INDEX = 1;

export async function showDesktopConfirmDialog(
  message: string,
  ownerWindow: BrowserWindow | null,
): Promise<boolean> {
  const normalizedMessage = message.trim();
  if (normalizedMessage.length === 0) {
    return false;
  }

  const options = {
    type: "question" as const,
    buttons: ["No", "Yes"],
    defaultId: CONFIRM_BUTTON_INDEX,
    cancelId: 0,
    noLink: true,
    message: normalizedMessage,
  };
  const result = ownerWindow
    ? await dialog.showMessageBox(ownerWindow, options)
    : await dialog.showMessageBox(options);
  return result.response === CONFIRM_BUTTON_INDEX;
}

/** Keep ordinary closes behind one confirmation, without changing app quit policy. */
export function guardDesktopWindowClose(
  window: BrowserWindow,
  message: string,
  shouldConfirm: () => boolean,
): void {
  let confirmed = false;
  let pending = false;
  window.on("close", (event) => {
    if (confirmed) {
      confirmed = false;
      return;
    }
    if (!shouldConfirm()) return;
    event.preventDefault();
    if (pending) return;
    pending = true;
    void showDesktopConfirmDialog(message, window)
      .then((allowed) => {
        if (allowed && !window.isDestroyed()) {
          confirmed = true;
          window.close();
        }
      })
      .catch((error) => {
        console.warn("[desktop] Failed to confirm window close", error);
      })
      .finally(() => {
        pending = false;
      });
  });
}

import { type BrowserWindow, dialog } from "electron";
import { t } from "./i18n";

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
    buttons: [t("desktop:common_no"), t("desktop:common_yes")],
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

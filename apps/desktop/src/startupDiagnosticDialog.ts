import { dialog, clipboard, type MessageBoxOptions, type MessageBoxReturnValue } from "electron";
import type { BetaDiagnostics } from "./betaDiagnostics";

/** Preserve every recovery choice while letting Beta users copy the queued report ID. */
export async function showDiagnosticStartupDialog(
  options: MessageBoxOptions,
  id: string | null,
  diagnostics: Pick<BetaDiagnostics, "getReportStatus"> | null,
): Promise<MessageBoxReturnValue> {
  if (!id || !options.buttons) return dialog.showMessageBox(options);
  while (true) {
    const status = diagnostics?.getReportStatus(id);
    const result = await dialog.showMessageBox({
      ...options,
      detail: `${options.detail ?? ""}\n\nDiagnostic ID: ${id} (${status === "sent" ? "report sent" : status === "queued" ? "queued locally" : "upload not confirmed"})`,
      buttons: [...options.buttons, "Copy diagnostic ID"],
      cancelId: options.cancelId ?? options.buttons.length - 1,
    });
    if (result.response !== options.buttons.length) return result;
    try {
      clipboard.writeText(id);
    } catch {
      /* Copy failure must not prevent recovery choices. */
    }
  }
}

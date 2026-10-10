// FILE: fileManagerErrorToast.ts
// Purpose: Thin UI adapter for file-manager failure toasts. All user-facing
//          copy remains owned by the pure fileManagerNaming module.
// Layer: Web UI helper
// Exports: showFileManagerErrorToast

import { toastManager } from "~/components/ui/toast";
import {
  type FileManagerTargetKind,
  resolveFileManagerErrorDescription,
  resolveFileManagerErrorTitle,
} from "~/lib/fileManagerNaming";

export function showFileManagerErrorToast(input: {
  kind: FileManagerTargetKind;
  error: unknown;
  platform?: string;
}): void {
  toastManager.add({
    type: "error",
    title: resolveFileManagerErrorTitle(input.kind, input.platform),
    description: resolveFileManagerErrorDescription(input.error, input.kind),
  });
}

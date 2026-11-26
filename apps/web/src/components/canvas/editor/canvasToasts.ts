// FILE: canvasToasts.ts
// Purpose: The app's toast for canvas actions that change nothing visible on the canvas
//          (styles copied, opacity set by a digit, layers unlocked, comments hidden). A new
//          one replaces the last, so quick repeats (two opacity digits) show one toast.
// Layer: Canvas editor UI
// Exports: showCanvasToast

import { toastManager } from "../../ui/toast";

let last: string | null = null;

export function showCanvasToast(title: string) {
  if (last !== null) toastManager.close(last);
  last = toastManager.add({ type: "success", title, timeout: 2000 });
}

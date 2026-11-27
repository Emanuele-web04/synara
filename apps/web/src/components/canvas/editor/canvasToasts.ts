// FILE: canvasToasts.ts
// Purpose: The app's toast for canvas actions that change nothing visible on the canvas
//          (styles copied, opacity set by a digit, layers unlocked, comments hidden), or a hint
//          for a click that did nothing (a comment beside every frame). A new one replaces the
//          last, so quick repeats (two opacity digits) show one toast. Also the progress toast of
//          the canvas's long jobs (exports, image imports).
// Layer: Canvas editor UI
// Exports: showCanvasToast, showHiddenCanvasComments, runCanvasJob, CANVAS_JOB_TOAST_DELAY_MS

import type { t as translate } from "~/i18n";
import { useCanvasEditorStore } from "../canvasStores";
import { DEFAULT_TOAST_TIMEOUT_MS } from "../../ui/toast.logic";
import { toastManager } from "../../ui/toast";

let last: string | null = null;

/** A confirmation, or with `info` a hint about a click that did nothing. */
export function showCanvasToast(title: string, type: "success" | "info" = "success") {
  if (last !== null) toastManager.close(last);
  last = toastManager.add({ type, title, timeout: 2000 });
}

/**
 * Comments hidden with ⇧C come back when the user goes to one (the Comment tool, a thread opened
 * from the Comments panel), with the same toast ⇧C shows.
 */
export function showHiddenCanvasComments(t: typeof translate) {
  const store = useCanvasEditorStore.getState();
  if (!store.commentsHidden) return;
  store.toggleComments();
  showCanvasToast(t("workspace:canvasToastCommentsShown"));
}

/** A job that ends sooner than this shows only its outcome, so quick ones never flash. */
export const CANVAS_JOB_TOAST_DELAY_MS = 300;

type JobToast = { type: "success" | "error"; title: string; description?: string | undefined };

/**
 * A long canvas job (an export, an image import): the app's loading toast once it has run a
 * moment, turned into its success or error toast when it settles, or closed when it ends with
 * nothing to say. Resolves with the job's result, or null when it failed (already reported).
 */
export async function runCanvasJob<A>(
  pendingTitle: string,
  job: () => Promise<A>,
  outcome: {
    /** The success toast's title; null for none (the result shows on the canvas). */
    success?: ((result: A) => string | null) | undefined;
    failure: (cause: unknown) => { title: string; description?: string | undefined };
  },
): Promise<A | null> {
  let id: string | null = null;
  const timer = setTimeout(() => {
    id = toastManager.add({ type: "loading", title: pendingTitle, timeout: 0 });
  }, CANVAS_JOB_TOAST_DELAY_MS);
  const settle = (toast: JobToast | null) => {
    clearTimeout(timer);
    if (id === null) {
      if (toast) toastManager.add(toast);
      return;
    }
    if (toast) toastManager.update(id, { ...toast, timeout: DEFAULT_TOAST_TIMEOUT_MS });
    else toastManager.close(id);
  };
  try {
    const result = await job();
    const title = outcome.success?.(result) ?? null;
    settle(title ? { type: "success", title } : null);
    return result;
  } catch (cause) {
    settle({ type: "error", ...outcome.failure(cause) });
    return null;
  }
}

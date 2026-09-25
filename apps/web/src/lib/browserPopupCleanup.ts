// FILE: browserPopupCleanup.ts
// Purpose: Let animated popup exits finish before browser tests wipe document.body.
// Layer: Browser test helper
// Why: Base UI popups stay mounted for ~100ms while their `data-ending-style`
//      transition runs. Tests that call `document.body.innerHTML = ""` in
//      afterEach can detach a portal node React still owns, which then throws
//      NotFoundError during the renderer's unmount. Wait for the exit to land.

import { expect, vi } from "vitest";

/** Resolves once no popup is still animating in or out of document.body. */
export async function waitForTransientPopups(): Promise<void> {
  await vi.waitFor(() => {
    expect(document.body.querySelector("[data-ending-style], [data-starting-style]")).toBeNull();
  });
}

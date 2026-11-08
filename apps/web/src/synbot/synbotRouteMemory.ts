// FILE: synbotRouteMemory.ts
// Purpose: Remembers that the window was on the SynBot page (and which bot) so a relaunch, which
//          lands on the app's index, returns there instead of Home (SynBot, Beta). Any other page
//          forgets it; the index itself leaves it alone, since a launch passes through it.
// Layer: Browser storage helper (per execution host, like the sidebar's last thread route)
// Exports: SynbotPageMemory, rememberSynbotRoute, readSynbotPageMemory

import { executionStorage } from "../lib/hosts/executionStorage";

const STORAGE_KEY = "synara:synbot-page:v1";

/** The SynBot page's search to reopen (`{}` is SynBot's chat). */
export interface SynbotPageMemory {
  readonly bot?: string;
}

/** Records where the window is: the SynBot page with its `?bot`, or another page (null). */
export function rememberSynbotRoute(pathname: string, bot: string | undefined): void {
  if (pathname === "/") return;
  try {
    if (pathname === "/synbot") {
      executionStorage.setItem(STORAGE_KEY, JSON.stringify(bot ? { bot } : {}));
    } else {
      executionStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Storage blocked: a relaunch lands on Home as it always did.
  }
}

/** The SynBot page the window was on when it closed, or null. */
export function readSynbotPageMemory(): SynbotPageMemory | null {
  try {
    const raw = executionStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { readonly bot?: unknown };
    return typeof parsed.bot === "string" && parsed.bot.length > 0 ? { bot: parsed.bot } : {};
  } catch {
    return null;
  }
}

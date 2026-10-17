import { session as electronSession, WebContentsView, type WebContents } from "electron";
import type { CookieSessionBackend } from "./browserSessionRestore";

/**
 * Close the hidden view this long after its last cookie read/restore. The
 * restore path runs once at startup and a session import reads twice back to
 * back, so a short grace coalesces those without keeping a renderer process
 * alive for the app's lifetime.
 */
export const COOKIE_SESSION_VIEW_IDLE_CLOSE_MS = 5_000;

type CookieViewContents = Pick<WebContents, "loadURL" | "isDestroyed" | "close"> & {
  readonly debugger: Pick<WebContents["debugger"], "attach" | "sendCommand">;
};

type CookieChangeListener = () => void;

/** The Electron surface this backend needs; injectable so tests can fake it. */
export interface CookieSessionElectronSurface {
  createView(partition: string): { readonly webContents: CookieViewContents };
  cookies(partition: string): {
    on(event: "changed", listener: CookieChangeListener): unknown;
    removeListener(event: "changed", listener: CookieChangeListener): unknown;
  };
}

const electronSurface: CookieSessionElectronSurface = {
  createView: (partition) =>
    // This never navigates to a website, joins the UI, or accepts agent commands.
    new WebContentsView({
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    }),
  cookies: (partition) => electronSession.fromPartition(partition).cookies,
};

export function createCookieSessionBackend(
  partition: string,
  surface: CookieSessionElectronSurface = electronSurface,
): CookieSessionBackend {
  const changedListeners = new Set<CookieChangeListener>();
  let disposed = false;
  // WebContentsView owns the contents; retain the owner across async operations
  // and the idle grace so GC cannot destroy an in-use cookie target.
  let view: ReturnType<CookieSessionElectronSurface["createView"]> | undefined;
  let ready: Promise<CookieViewContents> | undefined;
  let users = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const clearIdleTimer = (): void => {
    if (idleTimer === undefined) return;
    clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  const closeView = (): void => {
    clearIdleTimer();
    const current = view?.webContents;
    view = undefined;
    ready = undefined;
    if (current && !current.isDestroyed()) current.close();
  };

  const openView = (): Promise<CookieViewContents> => {
    if (ready) return ready;
    view = surface.createView(partition);
    const created = view.webContents;
    const opening = (async () => {
      created.debugger.attach("1.3");
      await created.loadURL("about:blank");
      return created;
    })();
    ready = opening;
    // A failed open must not pin a broken view: the next call starts fresh.
    opening.catch(() => {
      if (ready === opening) closeView();
    });
    return opening;
  };

  const withView = async <T>(operation: (view: CookieViewContents) => Promise<T>): Promise<T> => {
    if (disposed) throw new Error("Browser cookie session is closed.");
    clearIdleTimer();
    users += 1;
    try {
      return await operation(await openView());
    } finally {
      users -= 1;
      if (users === 0 && !disposed && view) {
        idleTimer = setTimeout(() => {
          idleTimer = undefined;
          if (users === 0) closeView();
        }, COOKIE_SESSION_VIEW_IDLE_CLOSE_MS);
        idleTimer.unref?.();
      }
    }
  };

  return {
    read() {
      // Electron's browser-scoped Storage domain resolves the default profile,
      // not this view's partition. Use the target-scoped Network commands.
      return withView(async (view) => {
        const result = await view.debugger.sendCommand("Network.getAllCookies");
        return result.cookies;
      });
    },
    restore(cookies) {
      return withView(async (view) => {
        if (cookies.length) await view.debugger.sendCommand("Network.setCookies", { cookies });
      });
    },
    onChange(listener) {
      // The partition's cookie store reports changes without any view alive.
      surface.cookies(partition).on("changed", listener);
      changedListeners.add(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // The partition session outlives this backend; a stale listener would
      // fire the restore path against a closed backend.
      const cookies = surface.cookies(partition);
      for (const listener of changedListeners) cookies.removeListener("changed", listener);
      changedListeners.clear();
      closeView();
    },
  };
}

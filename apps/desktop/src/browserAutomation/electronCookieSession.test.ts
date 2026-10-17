import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));

import {
  COOKIE_SESSION_VIEW_IDLE_CLOSE_MS,
  createCookieSessionBackend,
  type CookieSessionElectronSurface,
} from "./electronCookieSession";

function createSurface() {
  const cookieEvents = new EventEmitter();
  const views: Array<{
    destroyed: boolean;
    attach: ReturnType<typeof vi.fn>;
    sendCommand: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const surface: CookieSessionElectronSurface = {
    createViewContents: vi.fn(() => {
      const view = {
        destroyed: false,
        attach: vi.fn(),
        sendCommand: vi.fn(async (method: string) =>
          method === "Network.getAllCookies" ? { cookies: [{ name: "sid" }] } : {},
        ),
        close: vi.fn(() => {
          view.destroyed = true;
        }),
      };
      views.push(view);
      return {
        loadURL: vi.fn(async () => undefined),
        isDestroyed: () => view.destroyed,
        close: view.close,
        debugger: { attach: view.attach, sendCommand: view.sendCommand },
      } as unknown as ReturnType<CookieSessionElectronSurface["createViewContents"]>;
    }),
    cookies: () => cookieEvents,
  };
  return { surface, views, cookieEvents };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createCookieSessionBackend", () => {
  it("creates no renderer until cookies are read or restored", () => {
    const { surface, cookieEvents } = createSurface();
    const backend = createCookieSessionBackend("persist:test", surface);
    const listener = vi.fn();

    backend.onChange(listener);
    cookieEvents.emit("changed");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(surface.createViewContents).not.toHaveBeenCalled();
    backend.dispose();
    expect(cookieEvents.listenerCount("changed")).toBe(0);
  });

  it("opens the view per use, coalesces back-to-back calls, and closes it when idle", async () => {
    vi.useFakeTimers();
    const { surface, views } = createSurface();
    const backend = createCookieSessionBackend("persist:test", surface);

    await backend.restore([{ name: "sid" }]);
    await expect(backend.read()).resolves.toEqual([{ name: "sid" }]);

    expect(surface.createViewContents).toHaveBeenCalledTimes(1);
    expect(views[0]?.attach).toHaveBeenCalledWith("1.3");
    expect(views[0]?.sendCommand).toHaveBeenCalledWith("Network.setCookies", {
      cookies: [{ name: "sid" }],
    });
    expect(views[0]?.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(COOKIE_SESSION_VIEW_IDLE_CLOSE_MS);
    expect(views[0]?.close).toHaveBeenCalledTimes(1);

    await backend.read();
    expect(surface.createViewContents).toHaveBeenCalledTimes(2);
    backend.dispose();
    expect(views[1]?.close).toHaveBeenCalledTimes(1);
  });

  it("disposes idempotently and refuses later cookie access", async () => {
    const { surface, views } = createSurface();
    const backend = createCookieSessionBackend("persist:test", surface);
    await backend.read();

    backend.dispose();
    backend.dispose();

    expect(views[0]?.close).toHaveBeenCalledTimes(1);
    await expect(backend.read()).rejects.toThrow("Browser cookie session is closed.");
    expect(surface.createViewContents).toHaveBeenCalledTimes(1);
  });

  it("retries with a fresh view after a failed open", async () => {
    const { surface, views } = createSurface();
    const backend = createCookieSessionBackend("persist:test", surface);
    vi.mocked(surface.createViewContents).mockImplementationOnce(() => {
      const failing = {
        loadURL: vi.fn(async () => {
          throw new Error("load failed");
        }),
        isDestroyed: () => false,
        close: vi.fn(),
        debugger: { attach: vi.fn(), sendCommand: vi.fn() },
      };
      return failing as unknown as ReturnType<CookieSessionElectronSurface["createViewContents"]>;
    });

    await expect(backend.read()).rejects.toThrow("load failed");
    await expect(backend.read()).resolves.toEqual([{ name: "sid" }]);
    expect(views).toHaveLength(1);
    backend.dispose();
  });
});

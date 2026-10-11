import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeToWindowReturn } from "./useRefreshOnWindowReturn";

afterEach(() => vi.unstubAllGlobals());

function surfaces() {
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  return { window, document };
}

describe("refreshing native permissions on return", () => {
  it("refreshes on focus and visibility without polling or overlapping requests", async () => {
    const { window, document } = surfaces();
    let finish!: () => void;
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const dispose = subscribeToWindowReturn(refresh);
    expect(refresh).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    window.dispatchEvent(new Event("focus"));
    expect(refresh).toHaveBeenCalledOnce();
    finish();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    finish();
    dispose();
  });

  it("ignores hidden windows and removes listeners when the surface leaves", async () => {
    const { window, document } = surfaces();
    const refresh = vi.fn();
    const dispose = subscribeToWindowReturn(refresh);
    document.visibilityState = "hidden";
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(refresh).not.toHaveBeenCalled();
    document.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    dispose();
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("allows rechecking after a failed refresh", async () => {
    const { window } = surfaces();
    const refresh = vi.fn().mockRejectedValue(new Error("disconnected"));
    const dispose = subscribeToWindowReturn(refresh);
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    dispose();
  });
});

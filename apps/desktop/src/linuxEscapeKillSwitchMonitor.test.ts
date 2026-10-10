import { describe, expect, it, vi } from "vitest";

import {
  LinuxEscapeKillSwitchMonitor,
  linuxEscapeSession,
  type LinuxEscapeKillSwitchMonitorOptions,
} from "./linuxEscapeKillSwitchMonitor";

function fixture(sessionType: LinuxEscapeKillSwitchMonitorOptions["sessionType"] = "x11") {
  const callbacks = new Map<string, () => void>();
  const register = vi.fn((accelerator: string, callback: () => void) => {
    if (callbacks.has(accelerator)) return false;
    callbacks.set(accelerator, callback);
    return true;
  });
  const unregister = vi.fn((accelerator: string) => {
    callbacks.delete(accelerator);
  });
  const isSuspended = vi.fn(() => false);
  const isRegistered = vi.fn((accelerator: string) => callbacks.has(accelerator));
  const onEscape = vi.fn();
  const onStateChange = vi.fn();
  const onError = vi.fn();
  const monitor = new LinuxEscapeKillSwitchMonitor({
    shortcutRegistry: { register, unregister, isRegistered, isSuspended },
    sessionType,
    onEscape,
    onStateChange,
    onError,
  });
  return {
    monitor,
    callbacks,
    register,
    unregister,
    isSuspended,
    onEscape,
    onStateChange,
    onError,
  };
}

describe("Linux Escape shortcut", () => {
  it("reserves Escape only while armed and ignores a callback delivered after disarm", async () => {
    const f = fixture();
    const unrelatedShortcut = vi.fn();
    f.callbacks.set("Control+Shift+S", unrelatedShortcut);
    expect(f.register).not.toHaveBeenCalled();
    expect(f.monitor.state).toEqual({ ready: false, error: "input_monitor_idle" });

    await f.monitor.activate();
    await f.monitor.activate();
    f.monitor.setArmed(true);
    expect(f.register).toHaveBeenCalledTimes(1);
    expect(f.monitor.state).toEqual({ ready: true });
    const oldCallback = f.callbacks.get("Escape")!;
    oldCallback();
    expect(f.onEscape).toHaveBeenCalledTimes(1);

    f.monitor.setArmed(false);
    oldCallback();
    expect(f.monitor.state).toEqual({ ready: false, error: "input_monitor_idle" });
    expect(f.onEscape).toHaveBeenCalledTimes(1);
    expect(f.unregister).toHaveBeenCalledExactlyOnceWith("Escape");
    expect(f.callbacks.get("Control+Shift+S")).toBe(unrelatedShortcut);

    await f.monitor.activate();
    oldCallback();
    expect(f.onEscape).toHaveBeenCalledTimes(1);
    f.callbacks.get("Escape")!();
    expect(f.onEscape).toHaveBeenCalledTimes(2);
    f.monitor.dispose();
    expect(f.callbacks.has("Escape")).toBe(false);
    expect(f.callbacks.get("Control+Shift+S")).toBe(unrelatedShortcut);
  });

  it("never replaces or unregisters another feature's Escape reservation", async () => {
    const f = fixture();
    const existing = vi.fn();
    f.callbacks.set("Escape", existing);
    await f.monitor.activate();
    expect(f.monitor.state).toEqual({ ready: false, error: "linux_escape_shortcut_conflict" });
    expect(f.register).not.toHaveBeenCalled();
    f.monitor.setArmed(false);
    f.monitor.dispose();
    expect(f.unregister).not.toHaveBeenCalled();
    expect(f.callbacks.get("Escape")).toBe(existing);
  });

  it.each(["wayland", "unknown"] as const)(
    "does not confuse an unverified %s portal registration with a working kill switch",
    async (session) => {
      const f = fixture(session);
      await f.monitor.activate();
      expect(f.monitor.state).toEqual({
        ready: false,
        error:
          session === "wayland"
            ? "linux_escape_portal_unverified"
            : "linux_escape_session_unavailable",
      });
      expect(f.register).not.toHaveBeenCalled();
      f.monitor.dispose();
      expect(f.unregister).not.toHaveBeenCalled();
    },
  );

  it("keeps input closed when the OS refuses registration and permits a later explicit retry", async () => {
    const f = fixture();
    f.register.mockReturnValueOnce(false);
    await f.monitor.activate();
    expect(f.monitor.state).toEqual({ ready: false, error: "linux_escape_registration_failed" });
    expect(f.onStateChange).not.toHaveBeenCalledWith({ ready: true });
    await f.monitor.activate();
    expect(f.monitor.state).toEqual({ ready: true });
    f.monitor.dispose();
  });

  it("keeps input closed when Electron throws during registration", async () => {
    const f = fixture();
    f.register.mockImplementationOnce(() => {
      throw new Error("app not ready");
    });
    await f.monitor.activate();
    expect(f.monitor.state).toEqual({ ready: false, error: "linux_escape_registration_failed" });
    f.monitor.dispose();
    expect(f.unregister).not.toHaveBeenCalled();
  });

  it("reports suspension and obtains a fresh registration before resuming", async () => {
    const f = fixture();
    await f.monitor.activate();
    const oldCallback = f.callbacks.get("Escape")!;
    f.isSuspended.mockReturnValue(true);
    oldCallback();
    expect(f.monitor.state).toEqual({ ready: false, error: "linux_escape_shortcut_suspended" });
    expect(f.onEscape).not.toHaveBeenCalled();
    expect(f.onStateChange).toHaveBeenLastCalledWith({
      ready: false,
      error: "linux_escape_shortcut_suspended",
    });
    f.isSuspended.mockReturnValue(false);
    await f.monitor.activate();
    expect(f.unregister).toHaveBeenCalledExactlyOnceWith("Escape");
    expect(f.register).toHaveBeenCalledTimes(2);
    expect(f.monitor.state).toEqual({ ready: true });
    oldCallback();
    expect(f.onEscape).not.toHaveBeenCalled();
    f.monitor.dispose();
  });

  it("reports a removed shortcut before another input can be admitted", async () => {
    const f = fixture();
    await f.monitor.activate();
    f.callbacks.delete("Escape");
    expect(f.monitor.state).toEqual({ ready: false, error: "linux_escape_shortcut_lost" });
    expect(f.onStateChange).toHaveBeenLastCalledWith({
      ready: false,
      error: "linux_escape_shortcut_lost",
    });
    f.monitor.dispose();
    expect(f.unregister).not.toHaveBeenCalled();
  });

  it("disposal releases the owned key and permanently rejects later activation", async () => {
    const f = fixture();
    await f.monitor.activate();
    const callback = f.callbacks.get("Escape")!;
    f.monitor.dispose();
    f.monitor.dispose();
    await f.monitor.activate();
    f.monitor.setArmed(true);
    callback();
    expect(f.monitor.state).toEqual({ ready: false, error: "input_monitor_stopped" });
    expect(f.onEscape).not.toHaveBeenCalled();
    expect(f.register).toHaveBeenCalledTimes(1);
    expect(f.unregister).toHaveBeenCalledTimes(1);
  });

  it("reports a failed release and retries only the owned key during disposal", async () => {
    const f = fixture();
    await f.monitor.activate();
    const callback = f.callbacks.get("Escape")!;
    f.unregister.mockImplementationOnce(() => {
      throw new Error("unregister failed");
    });
    f.monitor.setArmed(false);
    callback();
    expect(f.monitor.state).toEqual({ ready: false, error: "linux_escape_release_failed" });
    expect(f.onEscape).not.toHaveBeenCalled();
    expect(f.onError).toHaveBeenLastCalledWith("The Escape shortcut could not be released.");
    f.monitor.dispose();
    expect(f.unregister).toHaveBeenNthCalledWith(2, "Escape");
    expect(f.callbacks.has("Escape")).toBe(false);
  });
});

describe("Linux Escape display session", () => {
  it.each([
    ["", { DISPLAY: ":1", XDG_SESSION_TYPE: "x11" }],
    ["auto", { DISPLAY: ":1", XDG_SESSION_TYPE: "x11" }],
    ["x11", { DISPLAY: ":1" }],
  ])("recognizes an existing direct X11 configuration", (ozone, environment) => {
    expect(linuxEscapeSession(ozone, environment)).toBe("x11");
  });

  it.each([
    ["wayland", { DISPLAY: ":1", XDG_SESSION_TYPE: "x11" }],
    ["", { DISPLAY: ":1", WAYLAND_DISPLAY: "wayland-1" }],
    ["x11", { DISPLAY: ":1", XDG_SESSION_TYPE: "wayland" }],
  ])(
    "does not mistake native Wayland or XWayland for global X11 coverage",
    (ozone, environment) => {
      expect(linuxEscapeSession(ozone, environment)).toBe("wayland");
    },
  );

  it.each([
    ["", {}],
    ["", { DISPLAY: ":1" }],
    ["x11", {}],
    ["headless", { DISPLAY: ":1", XDG_SESSION_TYPE: "x11" }],
    ["", { DISPLAY: ":1", XDG_SESSION_TYPE: "tty" }],
  ])("leaves an ambiguous or non-desktop session unavailable", (ozone, environment) => {
    expect(linuxEscapeSession(ozone, environment)).toBe("unknown");
  });
});

import { describe, expect, it } from "vitest";

import { KWIN_SERVICE } from "./kwinDbus.ts";
import {
  COMPUTER_BACKEND_OVERRIDES,
  InvalidComputerBackendOverrideError,
  isLinuxBackendChoice,
  parseComputerBackendOverride,
  selectLinuxBackend,
  waylandSession,
} from "./linuxBackendSelection.ts";

/** A host that owns the given bus names, or one whose bus cannot be reached. */
function host(options: { readonly names?: readonly string[]; readonly busError?: string } = {}) {
  const names = new Set(options.names ?? []);
  return (name: string) =>
    options.busError
      ? Promise.reject(new Error(options.busError))
      : Promise.resolve(names.has(name));
}

const KDE_HOST = host({ names: [KWIN_SERVICE] });
const GNOME_HOST = host();
/** What logind sets for the sessions the KWin plugin can be reached in. */
const WAYLAND_SESSION = { XDG_SESSION_TYPE: "wayland" } as const;

describe("parseComputerBackendOverride", () => {
  it("accepts every backend the server can name, case-insensitively", () => {
    for (const choice of COMPUTER_BACKEND_OVERRIDES) {
      expect(parseComputerBackendOverride(choice.toUpperCase())).toBe(choice);
      expect(parseComputerBackendOverride(` ${choice} `)).toBe(choice);
    }
    expect(parseComputerBackendOverride(undefined)).toBeUndefined();
    expect(parseComputerBackendOverride("  ")).toBeUndefined();
  });

  it("throws on a typo instead of silently booting the wrong backend", () => {
    // Every other env var here degrades to a default on bad input. This one
    // names the backend, so ignoring it would look like the override is broken.
    expect(() => parseComputerBackendOverride("protal")).toThrow(
      InvalidComputerBackendOverrideError,
    );
    expect(() => parseComputerBackendOverride("protal")).toThrow("cua");
  });

  it("has no shared-seat backend to name", () => {
    // Nothing in the tree drives the human's own seat, so a portal backend is
    // simply not a backend Synara has — the same refusal as any typo.
    expect(() => parseComputerBackendOverride("portal")).toThrow(
      InvalidComputerBackendOverrideError,
    );
  });

  it("tells the platform-neutral backends apart from the Linux tiers", () => {
    expect(isLinuxBackendChoice("fake")).toBe(false);
    expect(isLinuxBackendChoice("cua")).toBe(false);
    expect(isLinuxBackendChoice("kwin")).toBe(true);
    expect(isLinuxBackendChoice(undefined)).toBe(false);
  });
});

describe("selectLinuxBackend", () => {
  it("picks the KWin backend on a KDE Wayland host with nothing else set", async () => {
    // The hard regression guard: a KDE user who sets nothing must land on
    // exactly the backend they had before any other backend existed.
    await expect(
      selectLinuxBackend({ env: WAYLAND_SESSION, busNameHasOwner: KDE_HOST }),
    ).resolves.toMatchObject({ choice: "kwin", forced: false });
    // A session started outside a login manager often has no XDG_SESSION_TYPE
    // at all, and a Wayland socket is the same fact by another name.
    await expect(
      selectLinuxBackend({ env: { WAYLAND_DISPLAY: "wayland-0" }, busNameHasOwner: KDE_HOST }),
    ).resolves.toMatchObject({ choice: "kwin" });
  });

  it("leaves Plasma on X11 unclaimed rather than picking a backend that refuses forever", async () => {
    // KWin owns the name on X11 too, and there the plugin's dedicated seat does
    // not exist: the KWin backend refuses a non-Wayland session outright.
    await expect(
      selectLinuxBackend({
        env: { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" },
        busNameHasOwner: KDE_HOST,
      }),
    ).resolves.toBeUndefined();
    await expect(
      selectLinuxBackend({ env: {}, busNameHasOwner: KDE_HOST }),
    ).resolves.toBeUndefined();
  });

  it("claims nothing when no process owns the KWin name", async () => {
    await expect(
      selectLinuxBackend({ env: WAYLAND_SESSION, busNameHasOwner: GNOME_HOST }),
    ).resolves.toBeUndefined();
  });

  it("ignores XDG_CURRENT_DESKTOP entirely, in both directions", async () => {
    // A login manager sets this and a user can override it; the compositor
    // owning the bus name is the only fact that decides whether KWin is there.
    await expect(
      selectLinuxBackend({
        env: { ...WAYLAND_SESSION, XDG_CURRENT_DESKTOP: "GNOME" },
        busNameHasOwner: KDE_HOST,
      }),
    ).resolves.toMatchObject({ choice: "kwin" });
    await expect(
      selectLinuxBackend({
        env: { ...WAYLAND_SESSION, XDG_CURRENT_DESKTOP: "KDE" },
        busNameHasOwner: GNOME_HOST,
      }),
    ).resolves.toBeUndefined();
  });

  it("puts the override ahead of everything and never consults the bus for it", async () => {
    let asked = 0;
    const selection = await selectLinuxBackend({
      env: { XDG_SESSION_TYPE: "x11" },
      override: "kwin",
      busNameHasOwner: (name) => {
        asked += 1;
        return GNOME_HOST(name);
      },
    });

    expect(selection).toMatchObject({ choice: "kwin", forced: true });
    expect(selection?.reason).toContain("no other backend is tried");
    expect(asked).toBe(0);
  });

  it("treats an unreachable session bus as a host the KWin plugin cannot serve", async () => {
    // A headless host or a service unit has no ambient bus, and every call to
    // the plugin goes over that bus.
    await expect(
      selectLinuxBackend({
        env: WAYLAND_SESSION,
        busNameHasOwner: host({ busError: "connect ENOENT /run/user/1000/bus" }),
      }),
    ).resolves.toBeUndefined();
  });
});

describe("waylandSession", () => {
  it("is the same question the KWin backend refuses a session over", () => {
    expect(waylandSession({ XDG_SESSION_TYPE: "wayland" })).toBe(true);
    expect(waylandSession({ XDG_SESSION_TYPE: "Wayland" })).toBe(true);
    expect(waylandSession({ XDG_SESSION_TYPE: "x11" })).toBe(false);
    expect(waylandSession({ XDG_SESSION_TYPE: "tty" })).toBe(false);
    // An explicit session type wins over a stray socket variable.
    expect(waylandSession({ XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: "wayland-0" })).toBe(false);
    expect(waylandSession({ WAYLAND_DISPLAY: "wayland-0" })).toBe(true);
    expect(waylandSession({})).toBe(false);
  });
});

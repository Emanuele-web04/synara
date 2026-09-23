import { describe, expect, it } from "vitest";

import { KWIN_SERVICE } from "./kwinDbus.ts";
import {
  COMPUTER_BACKEND_OVERRIDES,
  InvalidComputerBackendOverrideError,
  isLinuxBackendChoice,
  nestedModeForChoice,
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
    expect(isLinuxBackendChoice("hyprland")).toBe(true);
    expect(isLinuxBackendChoice("nested")).toBe(true);
    expect(isLinuxBackendChoice("nested-window")).toBe(true);
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

  it("gives Plasma on X11 a nested desktop rather than a backend that refuses forever", async () => {
    // KWin owns the name on X11 too, and there the plugin's dedicated seat does
    // not exist: the KWin backend refuses a non-Wayland session outright, and
    // nothing falls back, so the old answer was a desktop that never worked.
    const selection = await selectLinuxBackend({
      env: { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" },
      busNameHasOwner: KDE_HOST,
    });

    expect(selection).toMatchObject({ choice: "nested", forced: false });
    expect(selection?.reason).toContain("X11 session");
  });

  it("treats a tty with no session at all as non-Wayland", async () => {
    await expect(selectLinuxBackend({ env: {}, busNameHasOwner: KDE_HOST })).resolves.toMatchObject(
      { choice: "nested" },
    );
  });

  it("gives the agent its own headless desktop when nothing owns the KWin name", async () => {
    // The non-KDE default: never the human's seat, and never a window popping
    // up on the human's desktop either — the headless nested compositor is
    // the resolution, watched through the Computer pane alone.
    const selection = await selectLinuxBackend({
      env: WAYLAND_SESSION,
      busNameHasOwner: GNOME_HOST,
    });

    expect(selection).toMatchObject({ choice: "nested", forced: false });
    expect(selection?.reason).toContain("instead of sharing the human's");
    expect(selection?.reason).toContain("nothing appears on this desktop");
  });

  it("puts the nested opt-in ahead of auto-detection, in both modes", async () => {
    await expect(
      selectLinuxBackend({ env: { SYNARA_COMPUTER_NESTED: "1" }, busNameHasOwner: KDE_HOST }),
    ).resolves.toMatchObject({ choice: "nested", forced: false });
    await expect(
      selectLinuxBackend({
        env: { SYNARA_COMPUTER_NESTED: "window" },
        busNameHasOwner: GNOME_HOST,
      }),
    ).resolves.toMatchObject({ choice: "nested-window", forced: false });
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
    ).resolves.toMatchObject({ choice: "nested" });
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

  it("picks the Hyprland backend when a live Hyprland session owns the environment", async () => {
    const selection = await selectLinuxBackend({
      env: { HYPRLAND_INSTANCE_SIGNATURE: "abc123" },
      busNameHasOwner: GNOME_HOST,
      hyprlandSessionPresent: () => true,
    });

    expect(selection).toMatchObject({ choice: "hyprland", forced: false });
    expect(selection?.reason).toContain("real desktop");
  });

  it("puts Hyprland detection ahead of the KWin bus probe", async () => {
    // The decisive case: a stray kwin_wayland (a nested or headless test
    // compositor) can own org.kde.KWin on the session bus of a machine whose
    // human is sitting at a Hyprland desktop. The inherited instance signature
    // is direct evidence of that desktop and must win.
    let asked = 0;
    const selection = await selectLinuxBackend({
      env: {},
      busNameHasOwner: (name) => {
        asked += 1;
        return KDE_HOST(name);
      },
      hyprlandSessionPresent: () => true,
    });

    expect(selection?.choice).toBe("hyprland");
    expect(asked).toBe(0);
  });

  it("does not detect Hyprland from the signature alone without a live socket", async () => {
    // The env var survives into terminals that outlive a crashed compositor
    // and into sessions this process spawned itself; the socket is the
    // liveness check, and without it the ordinary resolution continues.
    await expect(
      selectLinuxBackend({
        env: { ...WAYLAND_SESSION, HYPRLAND_INSTANCE_SIGNATURE: "stale" },
        busNameHasOwner: KDE_HOST,
        hyprlandSessionPresent: () => false,
      }),
    ).resolves.toMatchObject({ choice: "kwin" });
  });

  it("honors SYNARA_COMPUTER_BACKEND=hyprland ahead of detection", async () => {
    const selection = await selectLinuxBackend({
      env: {},
      override: "hyprland",
      busNameHasOwner: KDE_HOST,
      hyprlandSessionPresent: () => false,
    });

    expect(selection).toMatchObject({ choice: "hyprland", forced: true });
  });

  it("gives the agent its own desktop when the session bus cannot answer at all", async () => {
    // A headless host or a service unit has no ambient bus. The KWin plugin
    // is unreachable without one, while the nested session starts its own, so
    // this is the one tier that can work - and the reason still names the bus
    // failure for anyone who expected KWin.
    const selection = await selectLinuxBackend({
      env: WAYLAND_SESSION,
      busNameHasOwner: host({ busError: "connect ENOENT /run/user/1000/bus" }),
    });

    expect(selection?.choice).toBe("nested");
    expect(selection?.reason).toContain("ENOENT");
  });
});

describe("nestedModeForChoice", () => {
  it("maps the two nested choices onto the compositor modes and nothing else", () => {
    expect(nestedModeForChoice("nested")).toBe("virtual");
    expect(nestedModeForChoice("nested-window")).toBe("window");
    expect(nestedModeForChoice("kwin")).toBeUndefined();
    expect(nestedModeForChoice("hyprland")).toBeUndefined();
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

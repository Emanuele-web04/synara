import { describe, expect, it } from "vitest";

import {
  AGENT_ACCESSIBILITY_ENVIRONMENT,
  CHROMIUM_ACCESSIBILITY_ARGUMENT,
  desktopApplicationEnvironment,
  withAgentAccessibilityArguments,
  singleInstanceLaunch,
  withIsolatedProfile,
} from "./desktopAppEnvironment.ts";

describe("desktopApplicationEnvironment", () => {
  const base: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    HOME: "/home/user",
    USER: "user",
    LOGNAME: "user",
    SHELL: "/bin/zsh",
    LANG: "en_GB.UTF-8",
    LC_TIME: "de_DE.UTF-8",
    TZ: "Europe/Berlin",
    XDG_RUNTIME_DIR: "/run/user/1000",
    XDG_SESSION_TYPE: "wayland",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    WAYLAND_DISPLAY: "wayland-0",
    DISPLAY: ":0",
    XAUTHORITY: "/home/user/.Xauthority",
    QT_PLUGIN_PATH: "/home/user/.local/lib/qt6/plugins",
    GTK_THEME: "Breeze",
    GDK_SCALE: "2",
    SYNARA_AUTH_TOKEN: "secret",
    SYNARA_KWIN_PLUGIN_DIR: "/somewhere",
    ELECTRON_RUN_AS_NODE: "1",
    NODE_OPTIONS: "--inspect",
    OPENAI_API_KEY: "sk-secret",
    ANTHROPIC_API_KEY: "secret",
    SSH_AUTH_SOCK: "/tmp/agent",
  };

  it("keeps only the desktop session's variables", () => {
    const environment = desktopApplicationEnvironment(base);
    expect(Object.keys(environment).toSorted()).toEqual(
      [
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "SHELL",
        "LANG",
        "LC_TIME",
        "TZ",
        "XDG_RUNTIME_DIR",
        "XDG_SESSION_TYPE",
        "DBUS_SESSION_BUS_ADDRESS",
        "WAYLAND_DISPLAY",
        "DISPLAY",
        "XAUTHORITY",
        "QT_PLUGIN_PATH",
        "GTK_THEME",
        "GDK_SCALE",
      ].toSorted(),
    );
    expect(environment.SYNARA_AUTH_TOKEN).toBeUndefined();
    expect(environment.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(environment.NODE_OPTIONS).toBeUndefined();
    expect(environment.OPENAI_API_KEY).toBeUndefined();
  });

  it("applies overrides verbatim, including removal", () => {
    const environment = desktopApplicationEnvironment(base, {
      WAYLAND_DISPLAY: "wayland-9",
      DISPLAY: undefined,
      SYNARA_NESTED: "1",
    });
    expect(environment.WAYLAND_DISPLAY).toBe("wayland-9");
    expect("DISPLAY" in environment).toBe(false);
    expect(environment.SYNARA_NESTED).toBe("1");
  });

  it("drops undefined base entries rather than copying them through", () => {
    const environment = desktopApplicationEnvironment({ HOME: undefined, PATH: "/bin" });
    expect(environment).toEqual({ PATH: "/bin" });
  });
});

describe("agent launch accessibility", () => {
  it("turns accessibility on in the environment and keeps it through a second scrub", () => {
    const once = desktopApplicationEnvironment(
      { PATH: "/usr/bin" },
      AGENT_ACCESSIBILITY_ENVIRONMENT,
    );
    expect(once).toMatchObject({
      ACCESSIBILITY_ENABLED: "1",
      QT_LINUX_ACCESSIBILITY_ALWAYS_ON: "1",
    });
    // The nested session scrubs the backend's environment again.
    expect(desktopApplicationEnvironment(once)).toMatchObject({
      ACCESSIBILITY_ENABLED: "1",
      QT_LINUX_ACCESSIBILITY_ALWAYS_ON: "1",
    });
  });

  it.each([
    ["/usr/bin/chromium", ["https://example.com"]],
    ["/opt/google/chrome/google-chrome", []],
    ["/usr/bin/code", ["--new-window"]],
    ["/usr/lib/electron37/electron", []],
    ["/usr/bin/electron37", ["/usr/lib/app"]],
    ["/var/lib/flatpak/exports/bin/com.google.Chrome", []],
  ])("adds Chromium's accessibility switch for %s", (command, args) => {
    expect(withAgentAccessibilityArguments({ command, args }).args).toEqual([
      ...args,
      CHROMIUM_ACCESSIBILITY_ARGUMENT,
    ]);
  });

  it("adds the switch after the app id of a flatpak run, and before a --", () => {
    expect(
      withAgentAccessibilityArguments({
        command: "/usr/bin/flatpak",
        args: ["run", "--branch=stable", "--command=chrome", "com.google.Chrome", "--", "x"],
      }).args,
    ).toEqual([
      "run",
      "--branch=stable",
      "--command=chrome",
      "com.google.Chrome",
      CHROMIUM_ACCESSIBILITY_ARGUMENT,
      "--",
      "x",
    ]);
  });

  it.each([
    ["/usr/bin/firefox", ["https://example.com"]],
    ["/usr/bin/gio", ["launch", "/usr/share/applications/chromium.desktop"]],
    ["/usr/bin/flatpak", ["run", "org.mozilla.firefox"]],
    ["/usr/bin/kate", []],
  ])("leaves %s alone", (command, args) => {
    expect(withAgentAccessibilityArguments({ command, args }).args).toEqual(args);
  });

  it("never adds the switch twice", () => {
    const launch = { command: "/usr/bin/chromium", args: [CHROMIUM_ACCESSIBILITY_ARGUMENT] };
    expect(withAgentAccessibilityArguments(launch)).toBe(launch);
  });
});

describe("single-instance launches", () => {
  it("recognises Chromium, Electron and LibreOffice however they are started", () => {
    expect(singleInstanceLaunch({ command: "/usr/bin/chromium", args: [] })).toEqual({
      family: "chromium",
      name: "chromium",
    });
    expect(singleInstanceLaunch({ command: "/usr/bin/code", args: ["."] })).toMatchObject({
      family: "chromium",
    });
    expect(
      singleInstanceLaunch({ command: "flatpak", args: ["run", "com.google.Chrome"] }),
    ).toEqual({ family: "chromium", name: "com.google.Chrome", flatpakAppId: "com.google.Chrome" });
    expect(
      singleInstanceLaunch({
        command: "/var/lib/flatpak/exports/bin/org.libreoffice.LibreOffice",
        args: [],
      }),
    ).toMatchObject({ family: "libreoffice", flatpakAppId: "org.libreoffice.LibreOffice" });
    expect(singleInstanceLaunch({ command: "/usr/bin/soffice", args: ["--writer"] })).toEqual({
      family: "libreoffice",
      name: "soffice",
    });
    expect(
      singleInstanceLaunch({
        command: "/usr/bin/gio",
        args: ["launch", "/usr/share/applications/chromium.desktop"],
      }),
    ).toEqual({ family: "chromium", name: "chromium", desktopEntry: true });
    expect(singleInstanceLaunch({ command: "/usr/bin/kcalc", args: [] })).toBeUndefined();
    expect(singleInstanceLaunch({ command: "/usr/bin/firefox", args: [] })).toBeUndefined();
  });

  it("binds the launch to the given profile, replacing one the caller named", () => {
    const chromium = { command: "/usr/bin/chromium", args: [] };
    expect(
      withIsolatedProfile(
        {
          ...chromium,
          args: ["--user-data-dir=/home/u/.config/chromium", "https://x", "--", "--file"],
        },
        { family: "chromium", name: "chromium" },
        "/run/nested/profiles/chromium",
      ).args,
    ).toEqual(["https://x", "--user-data-dir=/run/nested/profiles/chromium", "--", "--file"]);
    expect(
      withIsolatedProfile(
        { ...chromium, args: ["--user-data-dir", "/home/u/.config/chromium", "https://x"] },
        { family: "chromium", name: "chromium" },
        "/p",
      ).args,
    ).toEqual(["https://x", "--user-data-dir=/p"]);
    expect(
      withIsolatedProfile(
        { command: "/usr/bin/soffice", args: ["-env:UserInstallation=file:///home/u", "--calc"] },
        { family: "libreoffice", name: "soffice" },
        "/run/nested/profiles/soffice",
      ).args,
    ).toEqual(["--calc", "-env:UserInstallation=file:///run/nested/profiles/soffice"]);
  });
});

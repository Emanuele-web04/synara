import { describe, expect, it } from "vitest";

import { desktopApplicationEnvironment } from "./desktopAppEnvironment.ts";

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

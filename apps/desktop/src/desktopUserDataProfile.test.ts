import { describe, expect, it } from "vitest";

import { resolveDesktopAppDataBase, resolveDesktopUserDataPath } from "./desktopUserDataProfile";

describe("desktopUserDataProfile", () => {
  it("resolves the canonical Synara profile names", () => {
    const appDataBase = "/Users/tester/Library/Application Support";
    expect(resolveDesktopUserDataPath({ appDataBase, isDevelopment: true })).toBe(
      "/Users/tester/Library/Application Support/synara-dev",
    );
    expect(resolveDesktopUserDataPath({ appDataBase, isDevelopment: false })).toBe(
      "/Users/tester/Library/Application Support/synara",
    );
  });

  it("uses XDG_CONFIG_HOME on Linux when available", () => {
    expect(
      resolveDesktopAppDataBase({
        platform: "linux",
        env: { XDG_CONFIG_HOME: "/tmp/xdg" },
        homeDir: "/home/tester",
      }),
    ).toBe("/tmp/xdg");
  });
});

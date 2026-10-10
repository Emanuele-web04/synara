// FILE: providerUsage/providers/cursor.test.ts
// Purpose: Cursor usage looks up state.vscdb with each OS's real Cursor user-data path.

import nodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { outboundHttp } from "@synara/shared/outboundHttp";
import * as credentials from "../credentials";

import { cursorStateDbPaths, cursorUsageFetcher } from "./cursor";

afterEach(() => vi.restoreAllMocks());

describe("cursorStateDbPaths", () => {
  it("does not use the global Keychain token for an isolated account", async () => {
    const keychainRead = vi
      .spyOn(credentials, "readKeychainPassword")
      .mockResolvedValue("personal-token");
    const request = vi.spyOn(outboundHttp, "request").mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: new TextEncoder().encode("{}"),
      url: "https://api2.cursor.sh",
    });
    const snapshot = await cursorUsageFetcher.fetch({
      homeDir: "/nonexistent-cursor-account",
      env: {},
      platform: "darwin",
      nowMs: 1_780_000_000_000,
      isolateCredentials: true,
    });
    expect(snapshot.status).toBe("needs-auth");
    expect(keychainRead).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("uses Application Support on macOS", () => {
    expect(
      cursorStateDbPaths({
        homeDir: "/Users/tester",
        env: {},
        platform: "darwin",
      }),
    ).toEqual([
      nodePath.join(
        "/Users/tester",
        "Library",
        "Application Support",
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb",
      ),
    ]);
  });

  it("uses %APPDATA% on Windows, and falls back to ~/AppData/Roaming when unset", () => {
    const homeDir = "C:\\Users\\tester";
    expect(
      cursorStateDbPaths({
        homeDir,
        env: { APPDATA: nodePath.join(homeDir, "AppData", "Roaming") },
        platform: "win32",
      }),
    ).toEqual([
      nodePath.join(
        homeDir,
        "AppData",
        "Roaming",
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb",
      ),
    ]);
    expect(
      cursorStateDbPaths({
        homeDir,
        env: {},
        platform: "win32",
      }),
    ).toEqual([
      nodePath.join(
        homeDir,
        "AppData",
        "Roaming",
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb",
      ),
    ]);
  });

  it("honors XDG_CONFIG_HOME on Linux", () => {
    expect(
      cursorStateDbPaths({
        homeDir: "/home/tester",
        env: { XDG_CONFIG_HOME: "/tmp/xdg-config" },
        platform: "linux",
      }),
    ).toEqual([nodePath.join("/tmp/xdg-config", "Cursor", "User", "globalStorage", "state.vscdb")]);
  });
});

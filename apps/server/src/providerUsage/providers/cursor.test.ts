// FILE: providerUsage/providers/cursor.test.ts
// Purpose: Cursor usage looks up state.vscdb with each OS's real Cursor user-data path,
// and never sends a safe-storage sealed accessToken cell upstream as a Bearer token.

import nodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { outboundHttp } from "@synara/shared/outboundHttp";
import * as credentials from "../credentials";
import { readItemTableValues } from "../sqlite";

import { cursorStateDbPaths, cursorUsageFetcher } from "./cursor";
import * as cursorSafeStorage from "./cursorSafeStorage";

vi.mock("../sqlite", () => ({ readItemTableValues: vi.fn(async () => ({})) }));
vi.mock("./cursorSafeStorage", async (importOriginal) => {
  const actual = await importOriginal<typeof cursorSafeStorage>();
  return { ...actual, unsealCursorSafeStorageValue: vi.fn(async () => null) };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

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

function bearerOf(input: Parameters<typeof outboundHttp.request>[0] | undefined): string | null {
  const headers = input?.headers;
  return headers === undefined ? null : new Headers(headers).get("authorization");
}

describe("safe-storage sealed access tokens", () => {
  const NOW_MS = 1_780_000_000_000;
  const PLAIN_JWT = `${"a".repeat(20)}.${Buffer.from(
    JSON.stringify({ exp: Math.floor((NOW_MS + 3_600_000) / 1000) }),
  ).toString("base64url")}.${"b".repeat(20)}`;
  // Envelope contents are opaque here — unsealing is the module under test's own seam.
  const SEALED = `cursor-safe-storage:v1:${"QUJD".repeat(16)}`;
  const itemTable = vi.mocked(readItemTableValues);
  const unseal = vi.mocked(cursorSafeStorage.unsealCursorSafeStorageValue);

  function stubOkRequest() {
    return vi.spyOn(outboundHttp, "request").mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: new TextEncoder().encode("{}"),
      url: "https://api2.cursor.sh",
    });
  }

  const ctx = {
    homeDir: "/fixture-cursor-home",
    env: {},
    platform: "darwin" as const,
    nowMs: NOW_MS,
  };

  it("sends the unsealed token, not the sealed cell text", async () => {
    itemTable.mockResolvedValue({
      "cursorAuth/accessToken": SEALED,
      "cursorAuth/stripeMembershipType": "pro",
    });
    unseal.mockResolvedValue(PLAIN_JWT);
    const request = stubOkRequest();
    const snapshot = await cursorUsageFetcher.fetch(ctx);
    expect(snapshot.status).toBe("ok");
    expect(snapshot.planName).toBe("Pro");
    expect(unseal).toHaveBeenCalledWith(expect.objectContaining({ platform: "darwin" }), SEALED);
    expect(bearerOf(request.mock.calls[0]?.[0])).toBe(`Bearer ${PLAIN_JWT}`);
  });

  it("falls back to the legacy keychain entry when the sealed cell cannot be unsealed", async () => {
    itemTable.mockResolvedValue({ "cursorAuth/accessToken": SEALED });
    unseal.mockResolvedValue(null);
    vi.spyOn(credentials, "readKeychainPassword").mockResolvedValue("keychain-token");
    const request = stubOkRequest();
    const snapshot = await cursorUsageFetcher.fetch(ctx);
    expect(snapshot.status).toBe("ok");
    expect(bearerOf(request.mock.calls[0]?.[0])).toBe("Bearer keychain-token");
  });

  it("never sends the sealed text as a bearer token", async () => {
    itemTable.mockResolvedValue({ "cursorAuth/accessToken": SEALED });
    unseal.mockResolvedValue(null);
    vi.spyOn(credentials, "readKeychainPassword").mockResolvedValue(null);
    const request = stubOkRequest();
    const snapshot = await cursorUsageFetcher.fetch(ctx);
    expect(snapshot.status).toBe("needs-auth");
    expect(request).not.toHaveBeenCalled();
  });

  it("treats a raw os_crypt blob cell as sealed", async () => {
    itemTable.mockResolvedValue({ "cursorAuth/accessToken": "v10�ciphertext" });
    vi.spyOn(credentials, "readKeychainPassword").mockResolvedValue(null);
    const request = stubOkRequest();
    const snapshot = await cursorUsageFetcher.fetch(ctx);
    expect(snapshot.status).toBe("needs-auth");
    expect(request).not.toHaveBeenCalled();
  });

  it("reports needs-auth for a sealed cell on Linux without a keychain path", async () => {
    itemTable.mockResolvedValue({ "cursorAuth/accessToken": SEALED });
    const request = stubOkRequest();
    const snapshot = await cursorUsageFetcher.fetch({ ...ctx, platform: "linux" });
    expect(snapshot.status).toBe("needs-auth");
    expect(request).not.toHaveBeenCalled();
  });

  it("does not attempt unseal fallback keychain reads for an isolated account", async () => {
    itemTable.mockResolvedValue({ "cursorAuth/accessToken": SEALED });
    const keychainRead = vi
      .spyOn(credentials, "readKeychainPassword")
      .mockResolvedValue("personal-token");
    const request = stubOkRequest();
    const snapshot = await cursorUsageFetcher.fetch({ ...ctx, isolateCredentials: true });
    expect(snapshot.status).toBe("needs-auth");
    expect(keychainRead).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps sending a plaintext token unchanged", async () => {
    itemTable.mockResolvedValue({ "cursorAuth/accessToken": PLAIN_JWT });
    const request = stubOkRequest();
    const snapshot = await cursorUsageFetcher.fetch(ctx);
    expect(snapshot.status).toBe("ok");
    expect(unseal).not.toHaveBeenCalled();
    expect(bearerOf(request.mock.calls[0]?.[0])).toBe(`Bearer ${PLAIN_JWT}`);
  });
});

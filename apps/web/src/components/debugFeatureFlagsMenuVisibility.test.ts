import { describe, expect, it } from "vitest";

import {
  isLoopbackHostname,
  shouldShowDebugFeatureFlagsMenu,
} from "./debugFeatureFlagsMenuVisibility";

describe("debugFeatureFlagsMenuVisibility", () => {
  it("accepts loopback hostnames only", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("LOCALHOST.")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);

    expect(isLoopbackHostname("192.168.1.42")).toBe(false);
    expect(isLoopbackHostname("dpcode.cc")).toBe(false);
    expect(isLoopbackHostname("")).toBe(false);
  });

  it("requires dev mode, loopback, and explicit storage opt-in", () => {
    expect(
      shouldShowDebugFeatureFlagsMenu({
        isDev: true,
        hostname: "localhost",
        storageValue: "true",
      }),
    ).toBe(true);

    expect(
      shouldShowDebugFeatureFlagsMenu({
        isDev: false,
        hostname: "localhost",
        storageValue: "true",
      }),
    ).toBe(false);

    expect(
      shouldShowDebugFeatureFlagsMenu({
        isDev: true,
        hostname: "dpcode.cc",
        storageValue: "true",
      }),
    ).toBe(false);

    expect(
      shouldShowDebugFeatureFlagsMenu({
        isDev: true,
        hostname: "localhost",
        storageValue: null,
      }),
    ).toBe(false);
  });
});

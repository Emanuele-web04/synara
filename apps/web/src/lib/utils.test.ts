import { assert, describe, it } from "vitest";

import { isMacPlatform, isWindowsPlatform } from "./utils";

describe("isMacPlatform", () => {
  it("matches browser and Node.js macOS platform identifiers", () => {
    assert.isTrue(isMacPlatform("MacIntel"));
    assert.isTrue(isMacPlatform("darwin"));
  });

  it("does not match Windows or Linux", () => {
    assert.isFalse(isMacPlatform("Win32"));
    assert.isFalse(isMacPlatform("Linux x86_64"));
  });
});

describe("isWindowsPlatform", () => {
  it("matches Windows platform identifiers", () => {
    assert.isTrue(isWindowsPlatform("Win32"));
    assert.isTrue(isWindowsPlatform("Windows"));
    assert.isTrue(isWindowsPlatform("windows_nt"));
  });

  it("does not match darwin", () => {
    assert.isFalse(isWindowsPlatform("darwin"));
  });
});

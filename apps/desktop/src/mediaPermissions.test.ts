// FILE: mediaPermissions.test.ts
// Purpose: Verifies the desktop microphone permission guard stays tolerant of optional Electron fields.
// Layer: Desktop unit test
// Depends on: mediaPermissions helper.

import { describe, expect, it } from "vitest";

import { shouldAllowMediaPermissionRequest } from "./mediaPermissions";

describe("shouldAllowMediaPermissionRequest", () => {
  it("allows requests when Electron omits mediaTypes", () => {
    expect(shouldAllowMediaPermissionRequest({})).toBe(true);
  });

  it("allows requests when Electron reports audio capture", () => {
    expect(shouldAllowMediaPermissionRequest({ mediaTypes: ["audio"] })).toBe(true);
  });

  it("rejects requests that only ask for video capture", () => {
    expect(shouldAllowMediaPermissionRequest({ mediaTypes: ["video"] })).toBe(false);
  });
});

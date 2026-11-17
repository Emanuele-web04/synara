import { describe, expect, it } from "vitest";

import { deviceKindFor } from "./DeviceFrame";

describe("deviceKindFor", () => {
  it("trusts the family over a name that disagrees with it", () => {
    // The name heuristic only holds while every Apple tablet says "iPad"; the
    // profile's family is what makes a rename harmless.
    expect(
      deviceKindFor({ platform: "ios-simulator", name: "Magic Slate", family: "tablet" }),
    ).toBe("iPad");
  });

  it("falls back to the name when no family was reported", () => {
    expect(deviceKindFor({ platform: "ios-simulator", name: "iPad Air 13-inch (M3)" })).toBe(
      "iPad",
    );
    expect(deviceKindFor({ platform: "ios-simulator", name: "iPhone SE (3rd generation)" })).toBe(
      "iPhone",
    );
  });
});

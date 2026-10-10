import { describe, expect, it } from "vitest";

import { deviceKindFor, screenGeometry } from "./DeviceFrame";

describe("deviceKindFor", () => {
  it("trusts the family over a name that disagrees with it", () => {
    // the name heuristic only holds while every Apple tablet says "iPad"; the profile's family is what makes a rename harmless
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

describe("screenGeometry", () => {
  it("takes its aspect from the device's own pixel dimensions", () => {
    // an iPhone SE is far squarer than an iPhone 17 Pro — the chassis must follow the moment the device is picked, not after it streams
    const tall = screenGeometry("iPhone", 1206, 2622);
    const short = screenGeometry("iPhone", 750, 1334);

    expect(short.aspect).toBeGreaterThan(tall.aspect);
  });
});

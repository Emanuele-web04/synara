import { describe, expect, it } from "vitest";

import {
  persistAppSnapIcon,
  readAppSnapIcon,
  selectAppSnapIconEvictionKeys,
} from "./appSnapIconStore";

describe("AppSnap icon cache guards", () => {
  it("evicts the oldest icons once the cache exceeds its cap", () => {
    const entries = Array.from({ length: 102 }, (_, index) => ({
      bundleIdentifier: `dev.synara.test-${index}`,
      updatedAt: index,
    }));

    expect(selectAppSnapIconEvictionKeys(entries)).toEqual([
      "dev.synara.test-0",
      "dev.synara.test-1",
    ]);
  });

  it("ignores invalid cache inputs before opening IndexedDB", async () => {
    await expect(
      persistAppSnapIcon({
        bundleIdentifier: "",
        dataUrl: "https://example.com/icon.png",
      }),
    ).resolves.toBeUndefined();
    await expect(readAppSnapIcon("")).resolves.toBeNull();
  });
});

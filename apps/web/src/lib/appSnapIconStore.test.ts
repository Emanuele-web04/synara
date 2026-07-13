import { describe, expect, it } from "vitest";

import { persistAppSnapIcon, readAppSnapIcon } from "./appSnapIconStore";

describe("AppSnap icon cache guards", () => {
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

import { describe, expect, it } from "vitest";

import { matchesImageSignature } from "./http";

describe("matchesImageSignature", () => {
  it("accepts matching raster signatures", () => {
    expect(
      matchesImageSignature(
        "image/png",
        Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBe(true);
    expect(
      matchesImageSignature(
        "image/jpeg",
        Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]),
      ),
    ).toBe(true);
    expect(matchesImageSignature("image/webp", Buffer.from("RIFF0000WEBP"))).toBe(true);
  });

  it("rejects MIME mismatches and active SVG content", () => {
    expect(matchesImageSignature("image/png", Buffer.from("not-a-png"))).toBe(false);
    expect(matchesImageSignature("image/svg+xml", Buffer.from("<svg></svg>"))).toBe(false);
  });
});

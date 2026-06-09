// FILE: backendNodeOptions.test.ts
// Purpose: Verifies desktop backend Node args preserve user-provided Node options.
// Layer: Desktop startup tests

import { describe, expect, it } from "vitest";

import {
  resolveBackendMaxOldSpaceMb,
  resolveBackendNodeArgs,
  withBackendHeapLimitArg,
} from "./backendNodeOptions";

const gb = (value: number) => value * 1024 * 1024 * 1024;

describe("resolveBackendMaxOldSpaceMb", () => {
  it("uses a valid explicit override", () => {
    expect(resolveBackendMaxOldSpaceMb({ configuredMb: "5120", totalMemoryBytes: gb(16) })).toBe(
      5120,
    );
  });

  it("clamps explicit overrides to bootable bounds", () => {
    expect(resolveBackendMaxOldSpaceMb({ configuredMb: "64", totalMemoryBytes: gb(16) })).toBe(
      1024,
    );
    expect(resolveBackendMaxOldSpaceMb({ configuredMb: "999999", totalMemoryBytes: gb(16) })).toBe(
      32768,
    );
  });

  it("ignores non-numeric overrides", () => {
    expect(resolveBackendMaxOldSpaceMb({ configuredMb: "lots", totalMemoryBytes: gb(24) })).toBe(
      6144,
    );
  });

  it("computes a bounded default from system memory", () => {
    expect(resolveBackendMaxOldSpaceMb({ totalMemoryBytes: gb(8) })).toBe(3072);
    expect(resolveBackendMaxOldSpaceMb({ totalMemoryBytes: gb(24) })).toBe(6144);
    expect(resolveBackendMaxOldSpaceMb({ totalMemoryBytes: gb(128) })).toBe(8192);
  });
});

describe("withBackendHeapLimitArg", () => {
  it("adds a heap limit when none exists", () => {
    expect(withBackendHeapLimitArg("--trace-warnings", 4096)).toEqual([
      "--max-old-space-size=4096",
    ]);
  });

  it("preserves an existing hyphenated heap limit", () => {
    expect(withBackendHeapLimitArg("--max-old-space-size=2048 --trace-warnings", 4096)).toEqual([]);
  });

  it("preserves an existing underscored heap limit", () => {
    expect(withBackendHeapLimitArg("--max_old_space_size=2048", 4096)).toEqual([]);
  });
});

describe("resolveBackendNodeArgs", () => {
  it("returns only the backend heap arg while leaving existing NODE_OPTIONS untouched", () => {
    expect(
      resolveBackendNodeArgs({
        existingNodeOptions: "--enable-source-maps",
        totalMemoryBytes: gb(24),
      }),
    ).toEqual(["--max-old-space-size=6144"]);
  });
});

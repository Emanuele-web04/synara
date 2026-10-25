import { describe, expect, it } from "vitest";

import { nativeEditorUnavailableError } from "./nativeEditorGate";

describe("nativeEditorUnavailableError", () => {
  it("allows editor RPCs on Stable and all other flavors", () => {
    for (const flavor of [
      "production",
      "beta",
      "canary",
      "cua",
      "development",
      "unknown",
    ] as const) {
      expect(nativeEditorUnavailableError(flavor)).toBeNull();
    }
  });
});

import { describe, expect, it } from "vitest";

import { NATIVE_EDITOR_UNAVAILABLE_CODE, nativeEditorUnavailableError } from "./nativeEditorGate";

describe("nativeEditorUnavailableError", () => {
  it("refuses the native editor on the Stable desktop only", () => {
    expect(nativeEditorUnavailableError("production")?.code).toBe(NATIVE_EDITOR_UNAVAILABLE_CODE);
    expect(nativeEditorUnavailableError("production")?.retryable).toBe(false);
    for (const flavor of ["beta", "canary", "cua", "development", "unknown"] as const) {
      expect(nativeEditorUnavailableError(flavor)).toBeNull();
    }
  });
});

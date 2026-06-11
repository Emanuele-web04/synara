// FILE: composerStackedHeaderFrame.test.ts
// Purpose: Pins the shared composer-stacked activity rail token used by ComposerStackedHeaderFrame.
// Layer: Chat composer regression test
// Depends on: composerPickerStyles sizing token.

import { describe, expect, it } from "vitest";

import { COMPOSER_STACKED_HEADER_FRAME_CLASS_NAME } from "./composerPickerStyles";

describe("COMPOSER_STACKED_HEADER_FRAME_CLASS_NAME", () => {
  it("keeps the stacked rail narrower than the composer column", () => {
    const classes = COMPOSER_STACKED_HEADER_FRAME_CLASS_NAME.split(/\s+/);

    expect(classes).toContain("mx-auto");
    expect(classes).toContain("-mb-px");
    expect(classes).toContain("w-11/12");
    expect(classes).toContain("min-w-0");
    expect(classes).not.toContain("w-full");
  });
});

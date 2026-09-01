// FILE: composerPickerStyles.test.ts
// Purpose: Pins shared composer picker and toolbar styling contracts.
// Layer: Chat composer regression test

import { describe, expect, it } from "vitest";

import {
  COMPOSER_TOOLBAR_CAPSULE_HOVER_CLASS_NAME,
  COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME,
} from "./composerPickerStyles";

describe("composerPickerStyles", () => {
  it("gives toolbar picker triggers the shared capsule hover treatment", () => {
    expect(COMPOSER_TOOLBAR_CAPSULE_HOVER_CLASS_NAME).toContain("rounded-full");
    expect(COMPOSER_TOOLBAR_CAPSULE_HOVER_CLASS_NAME).toContain(
      "hover:bg-[var(--color-background-button-secondary-hover)]",
    );
    expect(COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME).toContain(
      COMPOSER_TOOLBAR_CAPSULE_HOVER_CLASS_NAME,
    );
  });
});

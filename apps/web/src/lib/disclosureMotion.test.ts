import { describe, expect, it } from "vitest";

import {
  disclosureChevronClassName,
  disclosureContentClassName,
  disclosureShellClassName,
  DISCLOSURE_CHEVRON_MOTION_CLASS,
  DISCLOSURE_COLLAPSIBLE_PANEL_CLASS,
  DISCLOSURE_SHELL_MOTION_CLASS,
  DISCLOSURE_SHELL_CLOSED_CLASS,
  DISCLOSURE_SHELL_OPEN_CLASS,
} from "./disclosureMotion";

describe("disclosureMotion", () => {
  it("maps open state to the shared shell classes", () => {
    expect(disclosureShellClassName(true)).toContain(DISCLOSURE_SHELL_OPEN_CLASS);
    expect(disclosureShellClassName(false)).toContain(DISCLOSURE_SHELL_CLOSED_CLASS);
  });

  it("rotates the chevron when open", () => {
    expect(disclosureChevronClassName(true)).toContain("rotate-90");
    expect(disclosureChevronClassName(false)).not.toContain("rotate-90");
  });

  it("disables interaction on closed content", () => {
    expect(disclosureContentClassName(false)).toContain("pointer-events-none");
    expect(disclosureContentClassName(true)).not.toContain("pointer-events-none");
  });

  it("keeps every disclosure path on the shared 220ms reduced-motion contract", () => {
    for (const className of [
      DISCLOSURE_SHELL_MOTION_CLASS,
      DISCLOSURE_CHEVRON_MOTION_CLASS,
      DISCLOSURE_COLLAPSIBLE_PANEL_CLASS,
    ]) {
      expect(className).toContain("duration-220");
      expect(className).toContain("ease-out");
      expect(className).toContain("motion-reduce:transition-none");
    }
  });
});

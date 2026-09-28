import { describe, expect, it } from "vitest";

import {
  disclosureContentClassName,
  disclosurePopClassName,
  DISCLOSURE_CHEVRON_MOTION_CLASS,
  DISCLOSURE_COLLAPSIBLE_PANEL_CLASS,
  DISCLOSURE_POP_CLOSED_CLASS,
  DISCLOSURE_POP_CLOSE_MS,
  DISCLOSURE_POP_MOTION_CLASS,
  DISCLOSURE_POP_OPEN_CLASS,
  DISCLOSURE_POP_OPEN_MS,
  DISCLOSURE_SHELL_MOTION_CLASS,
} from "./disclosureMotion";

describe("disclosureMotion", () => {
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

  it("pops floating cards from the top-right corner", () => {
    expect(DISCLOSURE_POP_MOTION_CLASS).toContain("origin-top-right");
    expect(DISCLOSURE_POP_OPEN_CLASS).toContain("translate-y-0");
    expect(DISCLOSURE_POP_OPEN_CLASS).toContain("scale-100");
    expect(DISCLOSURE_POP_OPEN_CLASS).toContain("opacity-100");
    expect(disclosurePopClassName(true)).toContain("translate-y-0");
    expect(disclosurePopClassName(true)).toContain("scale-100");
    expect(disclosurePopClassName(true)).toContain("opacity-100");
    expect(DISCLOSURE_POP_CLOSED_CLASS).toContain("translate-y-1.5");
    expect(DISCLOSURE_POP_CLOSED_CLASS).toContain("scale-[0.97]");
    expect(DISCLOSURE_POP_CLOSED_CLASS).toContain("opacity-0");
    expect(DISCLOSURE_POP_CLOSED_CLASS).toContain("pointer-events-none");
    expect(disclosurePopClassName(false)).toContain("translate-y-1.5");
    expect(disclosurePopClassName(false)).toContain("scale-[0.97]");
    expect(disclosurePopClassName(false)).toContain("opacity-0");
    expect(disclosurePopClassName(false)).toContain("pointer-events-none");
    expect(disclosurePopClassName(true)).not.toContain("pointer-events-none");
  });

  it("uses asymmetric pop durations with reduced-motion fallback", () => {
    expect(DISCLOSURE_POP_OPEN_MS).toBe(280);
    expect(DISCLOSURE_POP_CLOSE_MS).toBe(160);
    expect(DISCLOSURE_POP_MOTION_CLASS).toContain("transition-[opacity,transform]");
    expect(DISCLOSURE_POP_MOTION_CLASS).toContain("duration-280");
    expect(DISCLOSURE_POP_MOTION_CLASS).toContain("ease-out");
    expect(DISCLOSURE_POP_MOTION_CLASS).toContain("motion-reduce:transition-none");
    expect(disclosurePopClassName(true)).toContain("duration-280");
    expect(disclosurePopClassName(true)).toContain("motion-reduce:transition-none");
    expect(disclosurePopClassName(false)).toContain("duration-160");
    expect(disclosurePopClassName(false)).not.toContain("duration-280");
    expect(disclosurePopClassName(false)).toContain("motion-reduce:transition-none");
  });
});

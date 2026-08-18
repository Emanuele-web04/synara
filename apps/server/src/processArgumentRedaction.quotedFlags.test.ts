import { describe, expect, it } from "vitest";

import { redactSensitiveProcessArgs } from "./processArgumentRedaction";

describe("redactSensitiveProcessArgs quoted flags", () => {
  it("redacts quoted sensitive flag values containing spaces", () => {
    expect(
      redactSensitiveProcessArgs(`tool --password "correct horse" --token='alpha beta' --verbose`),
    ).toBe("tool --password [redacted] --token=[redacted] --verbose");
  });

  it("fails closed for an unterminated quoted sensitive flag value", () => {
    expect(redactSensitiveProcessArgs('tool --password "correct horse')).toBe(
      "tool --password [redacted]",
    );
  });
});

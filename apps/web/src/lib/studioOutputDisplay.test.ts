import { describe, expect, it } from "vitest";

import { humanizeStudioOutputName } from "./studioOutputDisplay";

describe("humanizeStudioOutputName", () => {
  it("drops the extension and date prefix and de-snake_cases the rest", () => {
    expect(humanizeStudioOutputName("2026-07-08_chat_whatsapp_autotorino.pdf")).toBe(
      "Chat whatsapp autotorino",
    );
  });

  it("handles undated, hyphenated, and dotted names", () => {
    expect(humanizeStudioOutputName("customer-report.pdf")).toBe("Customer report");
    expect(humanizeStudioOutputName("notes.md")).toBe("Notes");
    expect(humanizeStudioOutputName("v1.2_release_notes.md")).toBe("V1.2 release notes");
  });

  it("falls back to the remaining stem when only a date is left, and to the raw name when empty", () => {
    expect(humanizeStudioOutputName("2026-07-08.pdf")).toBe("2026-07-08");
    expect(humanizeStudioOutputName("___.pdf")).toBe("___");
  });
});

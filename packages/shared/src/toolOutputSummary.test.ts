import { describe, expect, it } from "vitest";

import { countTextLines, summarizeToolRawOutput } from "./toolOutputSummary";

describe("toolOutputSummary", () => {
  it("summarizes Cursor search totals", () => {
    expect(summarizeToolRawOutput({ totalFiles: 33, truncated: false })).toBe("33 files found");
    expect(summarizeToolRawOutput({ totalFiles: 1, truncated: true })).toBe(
      "1 file found (truncated)",
    );
  });

  it("summarizes text content with a human line count", () => {
    expect(countTextLines("one\ntwo\n")).toBe(2);
    expect(summarizeToolRawOutput({ content: "one\ntwo\n" })).toBe("Read 2 lines");
  });

  it("uses the first stdout line as a fallback", () => {
    expect(summarizeToolRawOutput({ stdout: "done\nextra" })).toBe("done");
    expect(summarizeToolRawOutput({ rawInput: {} })).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { HARD_BREAK, savedTextRuns } from "./canvasRichText";

describe("savedTextRuns", () => {
  it("keeps the text exactly as typed when no line was broken", () => {
    const runs = [
      { text: "\n  Build ", style: "" },
      { text: "faster", style: "font-weight:700", source: "s" },
    ];
    expect(savedTextRuns(runs, true)).toEqual({ runs, breaks: false });
  });

  it("saves a broken line as a newline, with the text as a collapsing block shows it", () => {
    const runs = [
      { text: "\n  Build  ", style: "" },
      { text: `fast${HARD_BREAK}`, style: "font-weight:700", source: "s" },
      { text: "  today ", style: "" },
    ];
    expect(savedTextRuns(runs, true)).toEqual({
      runs: [
        { text: "Build ", style: "" },
        { text: "fast\n", style: "font-weight:700", source: "s" },
        { text: "today", style: "" },
      ],
      breaks: true,
    });
    // A block that keeps whitespace keeps all of it.
    expect(savedTextRuns(runs, false).runs.map((run) => run.text)).toEqual([
      "\n  Build  ",
      "fast\n",
      "  today ",
    ]);
  });
});

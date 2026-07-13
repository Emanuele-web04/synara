import { describe, expect, it } from "vitest";

import { parseFindingComment } from "./pullRequestComment.logic";

describe("parseFindingComment", () => {
  it("parses an H1 title followed by a severity line", () => {
    const body = [
      "# Side fork discarded silently",
      "",
      "High Severity",
      "",
      "If another root sheet is active, attempting to open a side conversation prevents its sheet from appearing.",
    ].join("\n");
    expect(parseFindingComment(body)).toEqual({
      title: "Side fork discarded silently",
      severity: "High",
      body: "If another root sheet is active, attempting to open a side conversation prevents its sheet from appearing.",
    });
  });

  it("parses an H2 title with no blank line separators", () => {
    const body = [
      "## Reconnect clears closed side tombstones",
      "Medium Severity",
      "Details here.",
    ].join("\n");
    expect(parseFindingComment(body)).toEqual({
      title: "Reconnect clears closed side tombstones",
      severity: "Medium",
      body: "Details here.",
    });
  });

  it("normalizes severity casing", () => {
    const body = ["# Title", "low SEVERITY", "Body."].join("\n");
    expect(parseFindingComment(body)?.severity).toBe("Low");
  });

  it.each([
    ["**High Severity**", "High"],
    ["__Medium Severity__", "Medium"],
    ["### **Low Severity**", "Low"],
    ["#### High Severity", "High"],
  ] as const)("parses decorated severity line %s", (severityLine, severity) => {
    expect(parseFindingComment(["### Finding title", severityLine, "Details."].join("\n"))).toEqual(
      {
        title: "Finding title",
        severity,
        body: "Details.",
      },
    );
  });

  it("keeps the severity match strict after stripping supported decoration", () => {
    expect(parseFindingComment("# Title\n### This is High Severity feedback\nBody")).toBeNull();
    expect(parseFindingComment("# Title\n**High Severity__\nBody")).toBeNull();
  });

  it("returns null for a comment with no heading", () => {
    expect(parseFindingComment("Just a regular comment with no heading at all.")).toBeNull();
  });

  it("returns null for a heading with no following severity line", () => {
    const body = ["# A title", "", "Just some prose, no severity line."].join("\n");
    expect(parseFindingComment(body)).toBeNull();
  });

  it("returns null for a heading followed only by blank lines", () => {
    expect(parseFindingComment("# A title\n\n")).toBeNull();
  });

  it("returns null for a plain bot summary comment", () => {
    const body =
      "Cursor Bugbot has reviewed your changes using high effort and found 5 potential issues.";
    expect(parseFindingComment(body)).toBeNull();
  });

  it("handles an empty remaining body", () => {
    const body = ["# Title", "High Severity"].join("\n");
    expect(parseFindingComment(body)).toEqual({ title: "Title", severity: "High", body: "" });
  });
});

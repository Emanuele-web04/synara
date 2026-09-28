import { describe, expect, it } from "vitest";
import { repairMarkdownTableDelimiters } from "./markdownTableRepair";

describe("repairMarkdownTableDelimiters", () => {
  it("drops delimiter cells beyond the header cell count", () => {
    const source = ["| a | b |", "|:--|---|--:|", "| 1 | 2 |"].join("\n");

    expect(repairMarkdownTableDelimiters(source)).toBe(
      ["| a | b |", "| :-- | --- |", "| 1 | 2 |"].join("\n"),
    );
  });

  it("keeps the kept cells' alignment markers when padding", () => {
    const source = ["| a | b | c |", "|:--|--:|"].join("\n");

    expect(repairMarkdownTableDelimiters(source)).toBe(
      ["| a | b | c |", "| :-- | --: | --- |"].join("\n"),
    );
  });

  it("repairs a table that follows a closed fence", () => {
    const source = ["```ts", "const x = 1;", "```", "", "| a | b |", "|---|"].join("\n");

    expect(repairMarkdownTableDelimiters(source)).toBe(
      ["```ts", "const x = 1;", "```", "", "| a | b |", "| --- | --- |"].join("\n"),
    );
  });

  it("ignores indented code blocks", () => {
    const source = ["Example:", "", "    | a | b |", "    |---|"].join("\n");

    expect(repairMarkdownTableDelimiters(source)).toBe(source);
  });

  it("ignores blockquoted headers", () => {
    const source = ["> | a | b |", "|---|"].join("\n");

    expect(repairMarkdownTableDelimiters(source)).toBe(source);
  });

  it("does not treat a dashed body row of an ongoing table as a delimiter", () => {
    const source = ["| a | b |", "| --- | --- |", "| 1 | 2 |", "| --- |"].join("\n");

    expect(repairMarkdownTableDelimiters(source)).toBe(source);
  });

  it("does not pair two delimiter-shaped rows as header and delimiter", () => {
    const source = ["|---|---|", "|---|"].join("\n");

    expect(repairMarkdownTableDelimiters(source)).toBe(source);
  });

  it("does not count escaped pipes as cell boundaries", () => {
    const source = ["| a \\| b | c |", "|---|"].join("\n");

    expect(repairMarkdownTableDelimiters(source)).toBe(
      ["| a \\| b | c |", "| --- | --- |"].join("\n"),
    );
  });
});

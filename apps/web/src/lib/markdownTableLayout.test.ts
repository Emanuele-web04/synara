import { describe, expect, it } from "vitest";

import {
  classifyTableCell,
  extractTableMarkdown,
  glueTableCellText,
  rehypeTableLayout,
  resolveTableColumnKinds,
} from "./markdownTableLayout";

describe("classifyTableCell", () => {
  it.each([
    "290 MB",
    "410–420 MB",
    "0.7 s",
    "3.1–4.9 s",
    "3.1–4.9 s",
    "2–3 ms",
    "−49%",
    "~4–6 s (+1 s)",
    "16 ms/frame",
    "$12.50",
    "1,400",
    "0",
    "10×",
  ])("reads %s as a number", (text) => {
    expect(classifyTableCell(text)).toBe("numeric");
  });

  it.each(["PR #2156", "Review requested", "SYN-142", "v1.2.3", "2026-11-15", "0 processes"])(
    "reads %s as short",
    (text) => {
      expect(classifyTableCell(text)).toBe("short");
    },
  );

  it.each([
    "Reading the transcript for the prediction (largest seeded thread, 1,400 messages)",
    "1 process, started 1 s later",
    "Claude prediction process",
  ])("reads %s as text", (text) => {
    expect(classifyTableCell(text)).toBe("text");
  });

  it.each(["", "  ", "–", "—", "-", "?", "n/a", "N/A"])("reads %j as empty", (text) => {
    expect(classifyTableCell(text)).toBe("empty");
  });
});

describe("resolveTableColumnKinds", () => {
  it("keeps short columns unwrapped next to a text column and ignores empty cells", () => {
    expect(
      resolveTableColumnKinds([
        ["text", "short"],
        ["numeric", "empty"],
        ["short", "numeric"],
        ["empty", "empty"],
      ]),
    ).toEqual(["text", "numeric", "short", "short"]);
  });

  it("lets short columns wrap between words when no text column can give up width", () => {
    expect(resolveTableColumnKinds([["short"], ["numeric"]])).toEqual(["label", "numeric"]);
  });
});

describe("glueTableCellText", () => {
  it("joins numbers to units, spaced ranges and references with same-length no-break spaces", () => {
    const glued = glueTableCellText("took 3.1–4.9 s, 2 – 5 ms and 1,400 messages in PR #2156");
    expect(glued).toBe("took 3.1–4.9 s, 2 – 5 ms and 1,400 messages in PR #2156");
  });

  it("leaves numbers followed by ordinary words alone", () => {
    expect(glueTableCellText("1 process, started 1 second later")).toBe(
      "1 process, started 1 second later",
    );
  });
});

describe("extractTableMarkdown", () => {
  it("returns a top-level table as written", () => {
    const source = "Intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter";
    const start = source.indexOf("| a");
    const end = source.indexOf("\n\nAfter");
    expect(extractTableMarkdown(source, { start, end, column: 1 })).toBe(
      "| a | b |\n|---|---|\n| 1 | 2 |",
    );
  });

  it("drops the quote or list indent repeated on later rows", () => {
    const quoted = "> | a |\n>|---|\n> | 1 |\n>| 2 |";
    expect(extractTableMarkdown(quoted, { start: 2, end: quoted.length, column: 3 })).toBe(
      "| a |\n|---|\n| 1 |\n| 2 |",
    );
    const listed = "- item\n\n  | a |\n  |---|\n  | 1 |";
    const start = listed.indexOf("| a");
    expect(extractTableMarkdown(listed, { start, end: listed.length, column: 3 })).toBe(
      "| a |\n|---|\n| 1 |",
    );
  });
});

type Node = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
};

const text = (value: string): Node => ({ type: "text", value });
const cell = (tagName: "th" | "td", ...children: Node[]): Node => ({
  type: "element",
  tagName,
  properties: {},
  children,
});
const element = (tagName: string, ...children: Node[]): Node => ({
  type: "element",
  tagName,
  properties: {},
  children,
});

describe("rehypeTableLayout", () => {
  it("marks every cell with its column kind and leaves inline code verbatim", () => {
    const table = element(
      "table",
      element("thead", element("tr", cell("th"), cell("th", text("Time")), cell("th"))),
      element(
        "tbody",
        element(
          "tr",
          cell("td", text("Reading the transcript for the prediction, 1,400 messages")),
          cell("td", text("3.1–4.9 s")),
          cell("td", element("code", text("PR #1"))),
        ),
        element("tr", cell("td", text("Opening a chat")), cell("td", text("–")), cell("td")),
      ),
    );
    rehypeTableLayout()({ type: "root", children: [table] });

    const [head, body] = table.children!;
    const headCells = head!.children![0]!.children!;
    const [first, second] = body!.children!;
    expect(headCells.map((node) => node.properties?.dataTableColumn)).toEqual([
      "text",
      "numeric",
      "short",
    ]);
    expect(first!.children![0]!.children![0]!.value).toBe(
      "Reading the transcript for the prediction, 1,400 messages",
    );
    expect(first!.children![1]!.children![0]!.value).toBe("3.1–4.9 s");
    expect(first!.children![2]!.children![0]!.children![0]!.value).toBe("PR #1");
    expect(second!.children![1]!.properties).toEqual({
      dataTableCell: "empty",
      dataTableColumn: "numeric",
    });
  });

  it("lets a header wider than its values wrap, and keeps a narrower one on one line", () => {
    const table = element(
      "table",
      element(
        "thead",
        element("tr", cell("th", text("Before p50")), cell("th", text("Peak memory"))),
      ),
      element("tbody", element("tr", cell("td", text("42 ms")), cell("td", text("410–420 MB")))),
    );
    rehypeTableLayout()({ type: "root", children: [table] });
    const [before, memory] = table.children![0]!.children![0]!.children!;
    expect(before!.properties).toEqual({ dataTableColumn: "numeric", dataTableHeader: "wrap" });
    expect(memory!.properties).toEqual({ dataTableColumn: "numeric" });
  });

  it("treats a cell with line breaks as text", () => {
    const table = element(
      "table",
      element("tbody", element("tr", cell("td", text("a"), element("br"), text("b")))),
    );
    rehypeTableLayout()({ type: "root", children: [table] });
    expect(table.children![0]!.children![0]!.children![0]!.properties?.dataTableColumn).toBe(
      "text",
    );
  });
});

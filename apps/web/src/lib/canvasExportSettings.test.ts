import { describe, expect, it } from "vitest";
import {
  addExportEntry,
  combinedPdfOrder,
  combinedPdfQuality,
  exportFileName,
  exportOutputSize,
  exportRowsState,
  parseExportScale,
  stepExportScale,
  textExportLabel,
  withExportFormat,
  withExportScale,
} from "./canvasExportSettings";

const png = (scale: string, suffix = scale === "1x" ? "" : `@${scale}`) => ({
  format: "png" as const,
  scale,
  suffix,
});

describe("export sizes", () => {
  it("reads the Size field", () => {
    expect(parseExportScale("2")).toEqual({ scale: "2x" });
    expect(parseExportScale(" 1.5X ")).toEqual({ scale: "1.5x" });
    expect(parseExportScale("512px")).toEqual({ scale: "512w" });
    expect(parseExportScale("512.9h")).toEqual({ scale: "512h" });
    expect(parseExportScale("1080p")).toEqual({ scale: "1080p" });
    expect(parseExportScale("0x")).toEqual({ error: "zero" });
    expect(parseExportScale("0.4w")).toEqual({ error: "zero" });
    expect(parseExportScale("big")).toEqual({ error: "invalid" });
  });

  it("steps by whole numbers, and by quarters below 1x", () => {
    expect(stepExportScale("1.5x", 1)).toBe("2x");
    expect(stepExportScale("1x", -1)).toBe("0.75x");
    expect(stepExportScale("0.25x", -1)).toBe("0.25x");
    expect(stepExportScale("512w", 1)).toBe("513w");
  });

  it("keeps the output sizes and caps", () => {
    const board = { width: 300, height: 200 };
    expect(exportOutputSize(board, "512w")).toEqual({ width: 512, height: 341 });
    expect(exportOutputSize(board, "512h")).toEqual({ width: 768, height: 512 });
    expect(exportOutputSize(board, "720p")).toEqual({ width: 1080, height: 720 });
    expect(exportOutputSize(board, "1.5x")).toEqual({ width: 450, height: 300 });
    expect(exportOutputSize({ width: 24, height: 24 }, "0x")).toEqual({ width: 24, height: 24 });
    expect(exportOutputSize({ width: 252, height: 24 }, "100x")).toEqual({
      width: 16000,
      height: 1524,
    });
  });
});

describe("export rows", () => {
  it("adds the first unused of 1x, 2x and 3x on top, 1x below a lone 2x", () => {
    expect(addExportEntry([], "jpg")).toEqual([{ format: "jpg", scale: "2x", suffix: "@2x" }]);
    expect(addExportEntry([], "pdf")).toEqual([{ format: "pdf", scale: "1x", suffix: "" }]);
    expect(addExportEntry([png("2x")], "png")).toEqual([png("2x"), png("1x")]);
    expect(addExportEntry([png("1x"), png("2x")], "png")).toEqual([
      png("3x"),
      png("1x"),
      png("2x"),
    ]);
    expect(addExportEntry([png("1x"), png("2x"), png("3x")], "png")[0]).toEqual(png("3x"));
  });

  it("keeps the suffix in step with the size unless it was customized", () => {
    expect(withExportScale(png("2x"), "3x").suffix).toBe("@3x");
    expect(withExportScale(png("2x"), "1x").suffix).toBe("");
    expect(withExportScale(png("1x"), "512w").suffix).toBe("@512w");
    expect(withExportScale(png("2x", "-retina"), "3x").suffix).toBe("-retina");
  });

  it("forces PDF rows to 1x and drops a suffix that only named the size", () => {
    expect(withExportFormat(png("2x"), "pdf")).toEqual({ format: "pdf", scale: "1x", suffix: "" });
    expect(withExportFormat(png("2x", "-print"), "pdf").suffix).toBe("-print");
    expect(withExportScale({ format: "pdf", scale: "1x", suffix: "" }, "2x").scale).toBe("1x");
  });

  it("shows shared rows, nothing, or mixed for several nodes", () => {
    expect(exportRowsState([undefined, []])).toEqual({ kind: "empty" });
    expect(exportRowsState([[png("2x")], [png("2x")]])).toEqual({
      kind: "rows",
      entries: [png("2x")],
    });
    expect(exportRowsState([undefined, [png("2x")]])).toEqual({
      kind: "mixed",
      first: [png("2x")],
    });
  });
});

describe("files", () => {
  it("names files <label><suffix>.<ext> and shortens text labels", () => {
    expect(exportFileName("Sign in", "@2x", "png")).toBe("Sign in@2x.png");
    expect(exportFileName("..Hero/CTA\\x", "", "pdf")).toBe("Hero_CTA_x.pdf");
    expect(exportFileName("", "", "jpg")).toBe("Export.jpg");
    expect(textExportLabel("  Build   anything with your agents ")).toBe("Build anything with…");
  });

  it("orders combined PDF pages by rows, then left to right", () => {
    const box = (id: string, x: number, y: number, height = 100) => ({
      id,
      box: { x, y, width: 100, height },
    });
    const order = combinedPdfOrder([
      box("below", 0, 300),
      box("right", 200, 10),
      box("left", 0, 0),
      box("empty", 0, 0, 0),
      box("barely", 400, 90),
    ]).map((node) => node.id);
    // "barely" overlaps the first row by 10%, under the 15% threshold.
    expect(order).toEqual(["left", "right", "barely", "below"]);
  });

  it("uses the best PDF quality set on any node", () => {
    const pdf = (quality: "low" | "medium" | "high") => ({
      format: "pdf" as const,
      scale: "1x",
      suffix: "",
      quality,
    });
    expect(combinedPdfQuality([[pdf("low")], [pdf("medium")], [png("2x")]])).toBe("medium");
    expect(combinedPdfQuality([undefined])).toBe("high");
  });
});

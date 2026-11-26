import type { DesignFrame } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import {
  canvasClipboardHtml,
  copyFrames,
  isSvgDocument,
  layersHtml,
  looksLikeHtml,
  PASTE_OFFSET,
  pastedFrames,
  readEmbeddedTree,
  readPaste,
} from "./canvasClipboard";

const frame: DesignFrame = {
  id: "f",
  title: "Home",
  x: 100,
  y: 200,
  width: 400,
  height: 300,
  revision: 4,
  layers: {
    roots: ["a"],
    nodes: [
      { id: "a", type: "element", tag: "p", attributes: { style: "margin:0" }, children: ["t"] },
      { id: "t", type: "text", text: "Hi — ü" },
    ],
  },
};

/** A DataTransfer stand-in with the given flavours. */
const transfer = (flavours: Record<string, string>, files: File[] = []) => ({
  files: files as unknown as FileList,
  getData: (type: string) => flavours[type] ?? "",
});

describe("canvas clipboard", () => {
  it("B10: layer HTML for a duplicate leaves what was copied in place", () => {
    const copied = copyFrames([frame]);
    expect(layersHtml(frame, ["a"])).toContain("Hi");
    expect(readPaste(transfer({ "text/plain": copied.text }))).toMatchObject({
      kind: "tree",
      tree: { frames: [{ id: "f" }] },
    });
  });

  it("copies a text with styled spans whole: spans in the HTML and in the embedded tree", () => {
    const rich: DesignFrame = {
      ...frame,
      layers: {
        roots: ["p"],
        nodes: [
          { id: "p", type: "element", tag: "p", attributes: {}, children: ["t1", "s", "t2"] },
          { id: "t1", type: "text", text: "Build " },
          {
            id: "s",
            type: "element",
            tag: "span",
            attributes: { style: "font-weight:700" },
            children: ["t3"],
          },
          { id: "t3", type: "text", text: "faster" },
          { id: "t2", type: "text", text: " today" },
        ],
      },
    };
    expect(layersHtml(rich, ["p"])).toBe(
      '<p>Build <span style="font-weight:700">faster</span> today</p>',
    );
    const html = canvasClipboardHtml({ frames: [rich], layers: [] }, layersHtml(rich, ["p"]));
    expect(readEmbeddedTree(html)?.frames[0]?.layers).toEqual(rich.layers);
  });

  it("embeds the copied tree in the HTML flavour and reads it back in another window", () => {
    const html = canvasClipboardHtml({ frames: [frame], layers: [] }, "<p>Hi</p>");
    expect(html.startsWith('<meta charset="utf-8"><!--synara-canvas:v1:')).toBe(true);
    expect(readEmbeddedTree(html)).toEqual({ frames: [frame], layers: [] });
    expect(readPaste(transfer({ "text/html": html, "text/plain": "other" }))).toEqual({
      kind: "tree",
      tree: { frames: [frame], layers: [] },
    });
  });

  it("ignores an embedded tree that is not a valid canvas tree (untrusted data)", () => {
    const forged = `<!--synara-canvas:v1:${btoa(JSON.stringify({ frames: [{ id: "x" }] }))}-->`;
    expect(readEmbeddedTree(forged)).toBeNull();
    expect(readEmbeddedTree("<!--synara-canvas:v1:not base64!-->")).toBeNull();
  });

  it("classifies pastes in order: images, the tree, SVG, HTML source, text", () => {
    const image = new File(["x"], "a.png", { type: "image/png" });
    const html = canvasClipboardHtml({ frames: [], layers: [frame.layers] }, "");
    expect(readPaste(transfer({ "text/html": html }, [image]))).toEqual({
      kind: "image",
      file: image,
    });
    expect(readPaste(transfer({ "text/html": html }))?.kind).toBe("tree");
    expect(readPaste(transfer({ "text/plain": "<div><p>Hi</p></div>" }))?.kind).toBe("html");
    expect(readPaste(transfer({ "text/plain": "<b>not closed" }))?.kind).toBe("text");
    // An SVG document is inserted through the sanitizer, prolog, comments and DOCTYPE included.
    const svg =
      '<?xml version="1.0"?>\n<!-- icon -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>\n';
    expect(readPaste(transfer({ "text/plain": svg }))).toEqual({ kind: "svg", svg: svg.trim() });
    expect(isSvgDocument('<svg viewBox="0 0 1 1"/>')).toBe(true);
    // Not a whole document: HTML around an SVG is HTML source; an unfinished one is text.
    expect(readPaste(transfer({ "text/plain": "<div><svg></svg></div>" }))?.kind).toBe("html");
    expect(isSvgDocument("<svg><path d='M0 0'/>")).toBe(false);
    // No backtracking blow-up on a long run of comments that never reaches an <svg>.
    const started = performance.now();
    expect(isSvgDocument(`${"<!---->".repeat(20_000)}<div>`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
    // The canvas's own copy of an SVG layer still pastes as its embedded tree.
    const tree = canvasClipboardHtml({ frames: [], layers: [frame.layers] }, svg);
    expect(readPaste(transfer({ "text/html": tree, "text/plain": svg }))?.kind).toBe("tree");
    expect(readPaste(transfer({ "text/plain": "  " }))).toBeNull();
    expect(looksLikeHtml("<!doctype html><html></html>")).toBe(true);
    expect(looksLikeHtml("<br/>")).toBe(true);
    expect(looksLikeHtml("a <b>c</b>")).toBe(false);
  });

  it("B11: each paste of the same frames lands one offset further and keeps their layout", () => {
    const other = { ...frame, id: "g", x: 600 };
    const first = pastedFrames([frame, other], [frame, other]);
    expect(first.map((item) => [item.x, item.y])).toEqual([
      [100 + PASTE_OFFSET, 200 + PASTE_OFFSET],
      [600 + PASTE_OFFSET, 200 + PASTE_OFFSET],
    ]);
    expect(first.every((item) => item.revision === 1 && item.title === `${frame.title} copy`)).toBe(
      true,
    );
    const second = pastedFrames([frame], [frame, ...first]);
    expect([second[0]!.x, second[0]!.y]).toEqual([100 + 2 * PASTE_OFFSET, 200 + 2 * PASTE_OFFSET]);
    // On top of or in place of a frame: at its position.
    expect(
      pastedFrames([frame, other], [], { x: 0, y: 0 }).map((item) => [item.x, item.y]),
    ).toEqual([
      [0, 0],
      [500, 0],
    ]);
  });
});

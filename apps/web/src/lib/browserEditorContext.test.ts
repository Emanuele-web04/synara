import { describe, expect, it } from "vitest";

import {
  buildBrowserDrawingPromptBlock,
  buildBrowserSelectionPromptBlock,
  buildBrowserStyleEditPromptBlock,
  BROWSER_STYLE_EDIT_STYLING_NOTE,
  extractBrowserEditorContextPromptBlocks,
  normalizeBrowserElementFontOptions,
  normalizeBrowserElementStylePatch,
  removeBrowserAnnotationContextPrompt,
  removeBrowserEditorContextPrompts,
  splitFontFamilyList,
  upsertBrowserAnnotationContextPrompt,
} from "./browserEditorContext";

function annotationBlock(strokeCount: number): string {
  return buildBrowserDrawingPromptBlock({
    source: "browser-annotation",
    url: "http://localhost:8891/browser-editor-demo/index.html",
    title: "Northstar Studio",
    viewport: {
      width: 800,
      height: 600,
      devicePixelRatio: 2,
    },
    document: {
      width: 1200,
      height: 1800,
    },
    scroll: {
      x: 0,
      y: 240,
    },
    selectedSelector: "main > section.hero",
    selectedElement: {
      url: "http://localhost:8891/browser-editor-demo/index.html",
      title: "Northstar Studio",
      selector: "main > section.hero",
      tagName: "SECTION",
      role: "region",
      accessibleName: "Launch experiments",
      text: "Launch experiments without losing the plot.",
      attributes: {
        class: "hero",
        "data-component": "landing-hero",
      },
      rect: {
        x: 40,
        y: 120,
        width: 720,
        height: 420,
      },
      viewport: {
        width: 800,
        height: 600,
        devicePixelRatio: 2,
      },
      outerHTML: '<section class="hero" data-component="landing-hero"><h1>Launch experiments without losing the plot.</h1></section>',
    },
    strokes: Array.from({ length: strokeCount }, (_, index) => ({
      id: `stroke-${index}`,
      points: [
        { x: 10, y: 20 },
        { x: 100 + index, y: 120 + index },
      ],
    })),
    textAnnotations: [
      {
        id: "note-1",
        x: 180,
        y: 220,
        boxX: 190,
        boxY: 186,
        text: "Tighten this headline.",
      },
    ],
    arrows: [
      {
        id: "arrow-1",
        from: { x: 378, y: 201 },
        to: { x: 430, y: 150 },
        sourceTextAnnotationId: "note-1",
        sourceHandle: "right",
      },
    ],
  });
}

describe("browser editor annotation prompt blocks", () => {
  it("replaces the generated live annotation block instead of appending duplicates", () => {
    const first = annotationBlock(1);
    const second = annotationBlock(2);
    const prompt = upsertBrowserAnnotationContextPrompt(`Please update this\n\n${first}`, second);

    expect(prompt).toContain("Please update this");
    expect(prompt).toContain("source: browser-annotation");
    expect(prompt).toContain("strokeCount: 2");
    expect(prompt).toContain("textCount: 1");
    expect(prompt).toContain("arrowCount: 1");
    expect(prompt).toContain(
      "- stroke 1: start: x=10, y=20; end: x=100, y=120; bounds: x=10, y=20, width=90, height=100; pointCount: 2",
    );
    expect(prompt).not.toContain("sampled path");
    expect(prompt).toContain("Tighten this headline.");
    expect(prompt).toContain(
      "- arrow 1: from: x=378, y=201; to: x=430, y=150; bounds: x=378, y=150, width=52, height=51; sourceTextAnnotationId: note-1; sourceHandle: right",
    );
    expect(prompt).not.toContain("polyline");
    expect(prompt).not.toContain("markerEnd");
    expect(prompt).toContain("selectedElement:");
    expect(prompt).toContain("  selector: main > section.hero");
    expect(prompt).toContain("  tag: section");
    expect(prompt).toContain("  role: region");
    expect(prompt).toContain("  accessibleName: Launch experiments");
    expect(prompt).toContain("  bounds: x=40, y=120, width=720, height=420");
    expect(prompt).toContain("    - data-component: landing-hero");
    expect(prompt).toContain(
      "    <section class=\"hero\" data-component=\"landing-hero\"><h1>Launch experiments without losing the plot.</h1></section>",
    );
    expect(prompt).not.toContain("strokeCount: 1");
    expect(prompt.match(/<browser-drawing-selection>/g)).toHaveLength(1);
  });

  it("builds a selection-only context block without drawing metadata", () => {
    const block = buildBrowserSelectionPromptBlock({
      url: "http://localhost:8891/browser-editor-demo/index.html",
      title: "Northstar Studio",
      selector: "main > section.hero",
      tagName: "SECTION",
      role: "region",
      accessibleName: "Launch experiments",
      text: "Launch experiments without losing the plot.",
      attributes: {
        class: "hero",
      },
      rect: {
        x: 40,
        y: 120,
        width: 720,
        height: 420,
      },
      viewport: {
        width: 800,
        height: 600,
        devicePixelRatio: 2,
      },
      outerHTML: '<section class="hero"><h1>Launch experiments without losing the plot.</h1></section>',
    });

    expect(block).toContain("<browser-selection-selection>");
    expect(block).toContain("source: browser-selection");
    expect(block).toContain("selectedSelector: main > section.hero");
    expect(block).toContain("outerHTML:");
    expect(block).not.toContain("strokeCount");
    expect(block).not.toContain("textAnnotations");
  });

  it("includes payload truncation metadata for large selected elements", () => {
    const block = buildBrowserSelectionPromptBlock({
      url: "http://localhost:8891/browser-editor-demo/index.html",
      title: "Northstar Studio",
      selector: "main > section.hero",
      tagName: "SECTION",
      role: "region",
      accessibleName: "Launch experiments",
      text: "Launch experiments\n...[truncated; original length 2400 chars]",
      attributes: { class: "hero" },
      rect: { x: 40, y: 120, width: 720, height: 420 },
      viewport: { width: 800, height: 600, devicePixelRatio: 2 },
      outerHTML: '<section class="hero">...</section>\n...[truncated; original length 5200 chars]',
      payload: {
        textLength: 2400,
        textTruncated: true,
        outerHTMLLength: 5200,
        outerHTMLTruncated: true,
      },
    });

    expect(block).toContain("payload:");
    expect(block).toContain("textLength: 2400");
    expect(block).toContain("textTruncated: yes");
    expect(block).toContain("outerHTMLLength: 5200");
    expect(block).toContain("outerHTMLTruncated: yes");
  });

  it("builds style edit context with styling-location priority guidance", () => {
    const block = buildBrowserStyleEditPromptBlock({
      element: {
        url: "http://localhost:8891/browser-editor-demo/index.html",
        title: "Northstar Studio",
        selector: "main > section.hero > h1",
        tagName: "H1",
        role: null,
        accessibleName: "Launch experiments",
        text: "Launch experiments without losing the plot.",
        attributes: {
          class: "headline",
        },
        rect: { x: 40, y: 120, width: 720, height: 160 },
        viewport: { width: 800, height: 600, devicePixelRatio: 2 },
        outerHTML: '<h1 class="headline">Launch experiments without losing the plot.</h1>',
        style: {
          color: "rgb(15, 23, 42)",
          backgroundColor: "rgba(0, 0, 0, 0)",
          fontFamily: "Inter, sans-serif",
          fontSize: "72px",
          fontWeight: "800",
          fontStyle: "normal",
          lineHeight: "76px",
          letterSpacing: "normal",
          textAlign: "start",
          opacity: "1",
          display: "block",
          padding: "0px",
          margin: "0px",
          borderWidth: "0px",
          borderColor: "rgb(15, 23, 42)",
          borderRadius: "0px",
          boxShadow: "none",
        },
      },
      currentStyle: null,
      previewStyle: {
        color: "#123456",
        fontSize: "64px",
        backgroundColor: "",
      },
      manualOverride: false,
    });

    expect(block).toContain("<browser-style-edit-selection>");
    expect(block).toContain("source: browser-style-edit");
    expect(block).toContain("selectedSelector: main > section.hero > h1");
    expect(block).toContain("manualOverride: disabled");
    expect(block).toContain("changedProperties: 2");
    expect(block).toContain(BROWSER_STYLE_EDIT_STYLING_NOTE);
    expect(block).toContain("- color: rgb(15, 23, 42)");
    expect(block).toContain("- fontSize: 72px");
    expect(block).toContain("- color: #123456");
    expect(block).toContain("- fontSize: 64px");
    expect(block.match(/previewStyleRequest:[\s\S]*attributes:/)?.[0]).not.toContain(
      "backgroundColor:",
    );

    const contexts = extractBrowserEditorContextPromptBlocks(block);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.kind).toBe("style-edit");
    expect(contexts[0]?.label).toBe("Live Editor Context: style edit");
  });

  it("normalizes empty style patch values", () => {
    expect(
      normalizeBrowserElementStylePatch({
        color: " #fff ",
        fontSize: "",
        borderRadius: " 8px",
      }),
    ).toEqual({
      color: "#fff",
      borderRadius: "8px",
    });
  });

  it("normalizes page font options with the current font first", () => {
    expect(splitFontFamilyList('Inter, "Helvetica Neue", sans-serif')).toEqual([
      "Inter",
      '"Helvetica Neue"',
      "sans-serif",
    ]);

    const fonts = normalizeBrowserElementFontOptions({
      currentFontFamily: 'Inter, "Helvetica Neue", sans-serif',
      pageFonts: [
        { value: "Inter", source: "page", loaded: true },
        { value: '"Display Serif"', source: "page", loaded: false },
      ],
    });

    expect(fonts[0]).toMatchObject({
      value: 'Inter, "Helvetica Neue", sans-serif',
      source: "current",
      loaded: true,
    });
    expect(fonts.some((font) => font.value === '"Display Serif"' && font.loaded === false)).toBe(
      true,
    );
    expect(fonts.filter((font) => font.value === "Inter")).toHaveLength(1);
  });

  it("removes only the generated live annotation block", () => {
    const manualBlock = buildBrowserDrawingPromptBlock({
      url: "http://localhost:8891/manual.html",
      title: "Manual annotation",
      viewport: {
        width: 400,
        height: 300,
      },
      strokes: [
        {
          id: "manual-stroke",
          points: [
            { x: 1, y: 2 },
            { x: 3, y: 4 },
          ],
        },
      ],
    });
    const prompt = removeBrowserAnnotationContextPrompt(
      `Keep this\n\n${annotationBlock(1)}\n\n${manualBlock}`,
    );

    expect(prompt).toContain("Keep this");
    expect(prompt).toContain("Manual annotation");
    expect(prompt).not.toContain("source: browser-annotation");
  });

  it("extracts browser context blocks and removes them from display text", () => {
    const selectionBlock = buildBrowserSelectionPromptBlock({
      url: "http://localhost:8891/browser-editor-demo/index.html",
      title: "Northstar Studio",
      selector: "main > section.hero",
      tagName: "SECTION",
      role: "region",
      accessibleName: "Launch experiments",
      text: "Launch experiments without losing the plot.",
      attributes: { class: "hero" },
      rect: { x: 40, y: 120, width: 720, height: 420 },
      viewport: { width: 800, height: 600, devicePixelRatio: 2 },
      outerHTML: '<section class="hero"><h1>Launch experiments without losing the plot.</h1></section>',
    });
    const prompt = `Please update this hero.\n\n${selectionBlock}\n\nThanks.`;

    const contexts = extractBrowserEditorContextPromptBlocks(prompt);

    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.kind).toBe("selection");
    expect(removeBrowserEditorContextPrompts(prompt)).toBe("Please update this hero.\n\nThanks.");
  });
});

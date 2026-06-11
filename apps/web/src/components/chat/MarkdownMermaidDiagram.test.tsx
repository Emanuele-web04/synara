// @vitest-environment happy-dom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isMermaidFence, MarkdownMermaidDiagram } from "./MarkdownMermaidDiagram";

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async (_id: string, code: string) => ({
    svg: `<svg data-testid="mermaid-svg"><text>${code}</text></svg>`,
  })),
}));

vi.mock("mermaid", () => ({
  default: mermaidMock,
}));

describe("MarkdownMermaidDiagram", () => {
  beforeEach(() => {
    mermaidMock.initialize.mockClear();
    mermaidMock.render.mockReset();
    mermaidMock.render.mockResolvedValue({
      svg: '<svg data-testid="mermaid-svg"><text>rendered</text></svg>',
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("recognizes only plain mermaid language fences", () => {
    expect(
      isMermaidFence({
        language: "mermaid",
        isFileReference: false,
        filePath: null,
        fileName: null,
        directory: null,
        lineRange: null,
      }),
    ).toBe(true);
    expect(
      isMermaidFence({
        language: "mermaid",
        isFileReference: true,
        filePath: "docs/mermaid",
        fileName: "mermaid",
        directory: "docs",
        lineRange: null,
      }),
    ).toBe(false);
  });

  it("renders Mermaid source to SVG after mount", async () => {
    const { container } = render(
      <MarkdownMermaidDiagram
        code={["flowchart LR", "  A --> B"].join("\n")}
        themeName="github-light"
        fallback={<pre>source fallback</pre>}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('[data-testid="mermaid-svg"]')).not.toBeNull();
    });

    expect(mermaidMock.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        securityLevel: "strict",
        flowchart: { htmlLabels: false },
      }),
    );
    expect(container.textContent).toContain("rendered");
    expect(container.textContent).not.toContain("source fallback");
  });

  it("falls back to source when Mermaid rendering fails", async () => {
    mermaidMock.render.mockRejectedValueOnce(new Error("invalid diagram"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container } = render(
      <MarkdownMermaidDiagram
        code={["flowchart LR", "  A --> B"].join("\n")}
        themeName="github-light"
        fallback={<pre>flowchart LR source fallback</pre>}
      />,
    );

    await waitFor(() => {
      expect(container.textContent).toContain("source fallback");
    });

    expect(container.querySelector('[data-testid="mermaid-svg"]')).toBeNull();
    warnSpy.mockRestore();
  });
});

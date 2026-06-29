// FILE: ChatMarkdown.visual.browser.tsx
// Purpose: Browser fixture evidence for the shared assistant markdown renderer.
// Layer: Web browser regression test

import "../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import ChatMarkdown from "./ChatMarkdown";

vi.mock("@pierre/diffs", () => ({
  parsePatchFiles: () => [],
  getFiletypeFromFileName: (fileName: string) => fileName.split(".").pop() ?? "text",
  getSharedHighlighter: () =>
    Promise.resolve({
      codeToHtml(code: string) {
        return `<pre class="shiki"><code>${code}</code></pre>`;
      },
    }),
}));

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: () => undefined,
    render: () =>
      Promise.resolve({
        svg: '<svg role="img" aria-label="Fixture Mermaid diagram" viewBox="0 0 160 40"><rect width="160" height="40" rx="6" fill="#f2f2f2"/><text x="16" y="25" fill="#111">A -> B</text></svg>',
      }),
  },
}));

const MARKDOWN_FIXTURE = [
  "# Release Notes",
  "## Renderer parity",
  "> Keep quoted prose readable while still giving it a rail.",
  "",
  "Inline `ChatMarkdown.tsx`, [local file](./src/components/ChatMarkdown.tsx:12), and [web](https://e.co).",
  "",
  "| Surface | Status |",
  "| --- | --- |",
  "| Tables | Contained |",
  "",
  "```ts",
  "const stable = true;",
  "```",
  "",
  "```mermaid",
  "flowchart LR",
  "  A --> B",
  "```",
  "",
  "Inline math $x^2$.",
  "",
  "![generated](./generated-preview.png)",
].join("\n");

describe("ChatMarkdown visual fixture", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("renders the shared markdown stack for screenshot evidence", async () => {
    await render(
      <main
        data-testid="markdown-fixture"
        style={{
          width: "720px",
          maxWidth: "520px",
          padding: "24px",
          color: "var(--foreground)",
          background: "var(--background)",
        }}
      >
        <ChatMarkdown
          text={MARKDOWN_FIXTURE}
          cwd="/Users/tylersheffield/code/synara/apps/web"
          isStreaming={false}
        />
      </main>,
    );

    await expect.element(page.getByRole("heading", { name: "Release Notes" })).toBeVisible();
    await expect.element(page.getByText("Keep quoted prose readable")).toBeVisible();
    await expect.element(page.getByText("const stable = true;")).toBeVisible();
    await expect.element(page.getByText("Inline math")).toBeVisible();
    await expect
      .poll(() => document.querySelector(".chat-markdown-table-scroll") !== null)
      .toBe(true);
    await expect.poll(() => document.querySelector("[data-chat-mermaid]") !== null).toBe(true);
    await expect.element(page.getByRole("img", { name: "Fixture Mermaid diagram" })).toBeVisible();

    await page.screenshot({
      element: page.getByTestId("markdown-fixture"),
      path: "../../../../.supergoal/evidence/phase-7-markdown-fixture.png",
    });
  });
});

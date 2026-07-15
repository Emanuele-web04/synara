import { describe, expect, it } from "vitest";

import {
  preparePullRequestMarkdown,
  pullRequestMarkdownPreview,
  splitPullRequestMarkdownSections,
} from "./pullRequestMarkdown.logic";

describe("preparePullRequestMarkdown", () => {
  it("strips template comments and converts bare <br> tags to newlines", () => {
    expect(preparePullRequestMarkdown("<!-- boilerplate -->Hello<br/>world<br >!")).toBe(
      "Hello\nworld\n!",
    );
  });

  it("keeps <br> tags inside code fences verbatim", () => {
    const markdown = "```html\na<br/>b\n```";
    expect(preparePullRequestMarkdown(markdown)).toBe(markdown);
  });

  it("drops invisible formatting wrappers outside fences only", () => {
    expect(preparePullRequestMarkdown("<sub>small</sub> and <KBD>Esc</KBD>")).toBe("small and Esc");
    const fenced = "```html\n<sub>kept</sub>\n```";
    expect(preparePullRequestMarkdown(fenced)).toBe(fenced);
  });
});

describe("pullRequestMarkdownPreview", () => {
  it("flattens bot badge markup into readable text", () => {
    const body =
      "**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub> Derive the MCP endpoint from the bound host**";
    expect(pullRequestMarkdownPreview(body)).toBe(
      "P2 Badge Derive the MCP endpoint from the bound host",
    );
  });

  it("drops details boilerplate and keeps the readable remainder", () => {
    const body =
      "# Heading\n\nSee [the docs](https://example.com).\n\n<details><summary>Logs</summary>walls of text</details>";
    expect(pullRequestMarkdownPreview(body)).toBe("Heading\nSee the docs.");
  });

  it("collapses fenced code to a marker", () => {
    expect(pullRequestMarkdownPreview("Before\n\n```ts\nconst x = 1;\n```\n\nAfter")).toBe(
      "Before\n[code]\nAfter",
    );
  });
});

describe("splitPullRequestMarkdownSections", () => {
  it("returns one markdown section for plain bodies", () => {
    expect(splitPullRequestMarkdownSections("Just text.")).toEqual([
      { kind: "markdown", text: "Just text." },
    ]);
  });

  it("extracts details blocks with their summaries and surrounding text", () => {
    const body =
      "Intro.\n<details> <summary>ℹ️ About Codex in GitHub</summary>\nBoilerplate here.\n</details>\nOutro.";
    expect(splitPullRequestMarkdownSections(body)).toEqual([
      { kind: "markdown", text: "Intro." },
      { kind: "details", summary: "ℹ️ About Codex in GitHub", body: "Boilerplate here." },
      { kind: "markdown", text: "Outro." },
    ]);
  });

  it("labels summary-less blocks and strips html from summaries", () => {
    const body = "<details><summary><b>Logs</b></summary>x</details>";
    expect(splitPullRequestMarkdownSections(body)).toEqual([
      { kind: "details", summary: "Logs", body: "x" },
    ]);
    expect(splitPullRequestMarkdownSections("<details>y</details>")).toEqual([
      { kind: "details", summary: "Details", body: "y" },
    ]);
  });

  it("treats details markup inside code fences as content", () => {
    const body = "```\n<details>sample</details>\n```";
    expect(splitPullRequestMarkdownSections(body)).toEqual([{ kind: "markdown", text: body }]);
  });
});

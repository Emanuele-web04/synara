// FILE: ChatMarkdown.find.browser.tsx
// Purpose: Browser regression for parse-free in-thread find decoration updates.
// Layer: Vitest browser tests

import { useState } from "react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const reactMarkdownRender = vi.hoisted(() => vi.fn());

vi.mock("react-markdown", () => {
  return {
    default: (props: { children?: string }) => {
      reactMarkdownRender();
      return <p>{props.children}</p>;
    },
    defaultUrlTransform: (value: string) => value,
  };
});

import ChatMarkdown from "./ChatMarkdown";

function FindQueryHarness({ directionMode }: { directionMode: "off" | "auto-blocks" }) {
  const [query, setQuery] = useState("error");
  return (
    <div>
      <button type="button" onClick={() => setQuery("failed")}>
        Change query
      </button>
      <ChatMarkdown
        directionMode={directionMode}
        text="Error first, then failed."
        cwd={undefined}
        isStreaming={false}
        findQuery={query}
      />
    </div>
  );
}

describe("ChatMarkdown in-thread find", () => {
  afterEach(() => {
    reactMarkdownRender.mockClear();
  });

  it.each(["off", "auto-blocks"] as const)(
    "updates find without reparsing in %s",
    async (directionMode) => {
      await render(<FindQueryHarness directionMode={directionMode} />);
      expect(reactMarkdownRender).toHaveBeenCalledTimes(1);

      await page.getByRole("button", { name: "Change query" }).click();

      expect(reactMarkdownRender).toHaveBeenCalledTimes(1);
    },
  );
});

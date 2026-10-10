// FILE: PullRequestMarkdown.browser.tsx
// Purpose: Browser-level coverage for opening PR body images in the fullscreen preview.
// Layer: Pull request presentation test

import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { PullRequestMarkdown } from "./PullRequestMarkdown";

// Absolute http(s) URL, like GitHub's user-attachment links.
const IMAGE = `${window.location.origin}/synara.png`;
const BODY = [
  `![Before](${IMAGE}#before)`,
  "",
  `![After](${IMAGE}#after)`,
  "",
  `[![Badge](${IMAGE}#badge)](https://example.com)`,
].join("\n");

describe("PullRequestMarkdown images", () => {
  it("keeps linked badges as one keyboard link without a nested preview button", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <PullRequestMarkdown text={BODY} fallback="" cwd="/repo" />
      </QueryClientProvider>,
    );
    try {
      await expect.element(page.getByRole("link", { name: "Badge" })).toBeInTheDocument();
      await expect.element(page.getByRole("button", { name: "Badge" })).not.toBeInTheDocument();
      const badge = document.querySelector<HTMLImageElement>('img[alt="Badge"]')!;
      expect(badge.tabIndex).toBe(-1);
      expect(badge.closest("a")?.getAttribute("href")).toBe("https://example.com");
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it.each(["distinct", "shared"])("opens the clicked image when URLs are %s", async (urls) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <PullRequestMarkdown
          text={urls === "shared" ? BODY.replace(/#before|#after/g, "") : BODY}
          fallback=""
          cwd="/repo"
        />
      </QueryClientProvider>,
    );

    try {
      await page.getByRole("button", { name: "After" }).click();
      const dialog = page.getByRole("dialog", { name: "Expanded image preview" });
      await expect.element(dialog).toBeInTheDocument();
      // The linked badge stays a link and is left out of the gallery.
      await expect.element(page.getByText("After (2/2)")).toBeInTheDocument();

      await userEvent.keyboard("{ArrowLeft}");
      await expect.element(page.getByText("Before (1/2)")).toBeInTheDocument();

      await userEvent.keyboard("{Escape}");
      await expect.element(dialog).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });
});

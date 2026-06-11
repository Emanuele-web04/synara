import "../../index.css";

import type { ReviewTargetKey } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ReviewDiffPane } from "./ReviewDiffPane";

const TARGET: ReviewTargetKey = { _tag: "pullRequest", repositoryId: "repo123", number: 7 };

async function mountDiffPane(props?: {
  isLoading?: boolean;
  patch?: string | undefined;
  target?: ReviewTargetKey | null;
  viewedPaths?: ReadonlySet<string>;
  onToggleViewed?: (path: string) => void;
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(["review", "comments", JSON.stringify(props?.target ?? TARGET)], {
    comments: [],
  });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <ReviewDiffPane
        patch={props?.patch}
        target={props?.target ?? TARGET}
        isLoading={props?.isLoading ?? true}
        summary={{ files: 2, additions: 12, deletions: 3 }}
        files={[
          { path: "src/review/a.tsx", insertions: 10, deletions: 1 },
          { path: "src/review/b.tsx", insertions: 2, deletions: 2 },
        ]}
        onSelectFile={() => undefined}
        {...(props?.viewedPaths ? { viewedPaths: props.viewedPaths } : {})}
        {...(props?.onToggleViewed ? { onToggleViewed: props.onToggleViewed } : {})}
      />
    </QueryClientProvider>,
    { container: host },
  );

  return {
    cleanup: async () => {
      await screen.unmount();
      queryClient.clear();
      host.remove();
    },
  };
}

describe("ReviewDiffPane", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps diff toolbar controls interactive in the loading state", async () => {
    const mounted = await mountDiffPane({ target: null });

    try {
      await expect.element(page.getByLabelText("Jump to changed file")).toBeInTheDocument();
      await page.getByRole("button", { name: "Split diff view" }).click();
      await page.getByRole("button", { name: "Enable diff line wrapping" }).click();

      expect(page.getByRole("button", { name: "Split diff view" }).element()).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(
        page.getByRole("button", { name: "Disable diff line wrapping" }).element(),
      ).toBeTruthy();
      expect(document.body.textContent ?? "").toContain("All files");
      const stackedButton = page.getByRole("button", { name: "Stacked diff view" }).element();
      expect(stackedButton.getBoundingClientRect().width).toBeGreaterThanOrEqual(28);
      expect(document.querySelector('[aria-label="Diff view options"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders the empty-diff state without requiring a review target", async () => {
    const mounted = await mountDiffPane({ isLoading: false, target: null });

    try {
      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("No changes to review");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("marks files reviewed from the diff header", async () => {
    const onToggleViewed = vi.fn();
    const mounted = await mountDiffPane({
      isLoading: false,
      onToggleViewed,
      patch: `diff --git a/src/review/a.tsx b/src/review/a.tsx
index 1111111..2222222 100644
--- a/src/review/a.tsx
+++ b/src/review/a.tsx
@@ -1,2 +1,3 @@
 export const a = 1;
+export const reviewed = true;
 export const b = 2;
`,
    });

    try {
      const markReviewed = page.getByRole("checkbox", {
        name: "Mark src/review/a.tsx as reviewed",
      });
      await expect.element(markReviewed).toBeVisible();
      await markReviewed.click();
      expect(onToggleViewed).toHaveBeenCalledWith("src/review/a.tsx");
    } finally {
      await mounted.cleanup();
    }
  });
});

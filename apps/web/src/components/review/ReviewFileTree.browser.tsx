import "../../index.css";

import type { ReviewChangedFile } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ReviewFileTree } from "./ReviewFileTree";

const FILES = [
  { path: "src/components/review/ReviewDiffPane.tsx", insertions: 12, deletions: 3 },
  { path: "src/components/review/ReviewLayout.tsx", insertions: 2, deletions: 1 },
  { path: "packages/contracts/src/review.ts", insertions: 4, deletions: 0 },
] satisfies ReadonlyArray<ReviewChangedFile>;

async function mountFileTree(props?: {
  files?: ReadonlyArray<ReviewChangedFile>;
  isLoading?: boolean;
  selectedFilePath?: string | null;
  viewedPaths?: ReadonlySet<string>;
}) {
  const onSelectFile = vi.fn();
  const onToggleViewed = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <ReviewFileTree
      files={props?.files ?? FILES}
      isLoading={props?.isLoading ?? false}
      selectedFilePath={props?.selectedFilePath ?? null}
      viewedPaths={props?.viewedPaths ?? new Set()}
      onSelectFile={onSelectFile}
      onToggleViewed={onToggleViewed}
    />,
    { container: host },
  );

  return {
    onSelectFile,
    onToggleViewed,
    rerender: async (nextProps?: {
      files?: ReadonlyArray<ReviewChangedFile>;
      isLoading?: boolean;
      selectedFilePath?: string | null;
      viewedPaths?: ReadonlySet<string>;
    }) => {
      await screen.rerender(
        <ReviewFileTree
          files={nextProps?.files ?? FILES}
          isLoading={nextProps?.isLoading ?? false}
          selectedFilePath={nextProps?.selectedFilePath ?? null}
          viewedPaths={nextProps?.viewedPaths ?? new Set()}
          onSelectFile={onSelectFile}
          onToggleViewed={onToggleViewed}
        />,
      );
    },
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("ReviewFileTree", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("wires file selection without toggling viewed state", async () => {
    const mounted = await mountFileTree();

    try {
      await page.getByRole("treeitem", { name: /ReviewDiffPane\.tsx/ }).click();

      expect(mounted.onSelectFile).toHaveBeenCalledWith("src/components/review/ReviewDiffPane.tsx");
      expect(mounted.onToggleViewed).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders files after the loading tree receives async data", async () => {
    const mounted = await mountFileTree({ files: [], isLoading: true });

    try {
      await expect
        .element(page.getByRole("treeitem", { name: /ReviewDiffPane\.tsx/ }))
        .not.toBeInTheDocument();

      await mounted.rerender({ files: FILES, isLoading: false });

      await expect
        .element(page.getByRole("treeitem", { name: /ReviewDiffPane\.tsx/ }))
        .toBeVisible();
      await page.getByRole("treeitem", { name: /ReviewDiffPane\.tsx/ }).click();
      expect(mounted.onSelectFile).toHaveBeenCalledWith("src/components/review/ReviewDiffPane.tsx");
    } finally {
      await mounted.cleanup();
    }
  });

  it("wires the reviewed checkbox without selecting the file row", async () => {
    const mounted = await mountFileTree({
      viewedPaths: new Set(["src/components/review/ReviewDiffPane.tsx"]),
    });

    try {
      await page.getByRole("checkbox", { name: "Mark file as not reviewed" }).click();

      expect(mounted.onToggleViewed).toHaveBeenCalledWith(
        "src/components/review/ReviewDiffPane.tsx",
      );
      expect(mounted.onSelectFile).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("marks the selected file with aria-current", async () => {
    const mounted = await mountFileTree({
      selectedFilePath: "packages/contracts/src/review.ts",
    });

    try {
      const selected = page.getByRole("treeitem", { name: /review\.ts/ }).element();
      expect(selected).toHaveAttribute("aria-current", "true");
      expect(selected.className).toContain("before:bg-primary");
    } finally {
      await mounted.cleanup();
    }
  });

  it("collapses and expands directories without changing file selection", async () => {
    const mounted = await mountFileTree();

    try {
      await page.getByRole("treeitem", { name: /components 0\/2/ }).click();
      expect(document.body.textContent ?? "").not.toContain("ReviewDiffPane.tsx");
      expect(mounted.onSelectFile).not.toHaveBeenCalled();

      await page.getByRole("treeitem", { name: /components 0\/2/ }).click();
      await page.getByRole("treeitem", { name: /ReviewLayout\.tsx/ }).click();

      expect(mounted.onSelectFile).toHaveBeenCalledWith("src/components/review/ReviewLayout.tsx");
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps selected nested files visible through collapsed ancestors", async () => {
    const mounted = await mountFileTree({
      selectedFilePath: "src/components/review/ReviewDiffPane.tsx",
    });

    try {
      await page.getByRole("treeitem", { name: "src 0/2" }).click();

      const selected = page.getByRole("treeitem", { name: /ReviewDiffPane\.tsx/ }).element();
      expect(selected).toBeVisible();
      expect(selected).toHaveAttribute("aria-current", "true");
    } finally {
      await mounted.cleanup();
    }
  });
});

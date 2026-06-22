import "../../index.css";

import type { ReviewChangedFile } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ReviewFileTree } from "./ReviewFileTree";

const FILE_TREE_BENCHMARK_FILE_COUNT = 5_000;
const MIN_FILE_TREE_RENDER_REDUCTION = 10;

function makeChangedFiles(count: number): ReviewChangedFile[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `apps/web/src/generated/feature-${String(Math.floor(index / 100)).padStart(2, "0")}/file-${String(index).padStart(5, "0")}.tsx`,
    insertions: 1,
    deletions: index % 3 === 0 ? 1 : 0,
    status: "modified",
  }));
}

function NaiveFileTree(props: { files: ReadonlyArray<ReviewChangedFile> }) {
  return (
    <div role="tree" aria-label="Naive file tree">
      {props.files.map((file) => (
        <button key={file.path} type="button" role="treeitem" className="flex h-7 w-full">
          {file.path}
        </button>
      ))}
    </div>
  );
}

async function mountNaiveFileTree(files: ReadonlyArray<ReviewChangedFile>) {
  const host = document.createElement("div");
  host.className = "h-[800px] bg-background text-foreground";
  document.body.append(host);
  const startedAt = performance.now();
  const screen = await render(<NaiveFileTree files={files} />, { container: host });
  const elapsedMs = performance.now() - startedAt;
  return {
    elapsedMs,
    mountedRows: host.querySelectorAll('[role="treeitem"]').length,
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

async function mountOptimizedFileTree(files: ReadonlyArray<ReviewChangedFile>) {
  await page.viewport(1440, 900);
  const host = document.createElement("div");
  host.className = "h-[800px] bg-background text-foreground";
  document.body.append(host);
  const startedAt = performance.now();
  const screen = await render(
    <ReviewFileTree
      files={files}
      isLoading={false}
      selectedFilePath={null}
      viewedPaths={new Set()}
      onSelectFile={() => {}}
      onToggleViewed={() => {}}
    />,
    { container: host },
  );
  await expect.element(page.getByRole("tree")).toBeVisible();
  const elapsedMs = performance.now() - startedAt;
  return {
    elapsedMs,
    mountedRows: host.querySelectorAll('[role="treeitem"]').length,
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("review file tree performance benchmark", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps mounted file rail rows at least 10x below naive rendering", async () => {
    const files = makeChangedFiles(FILE_TREE_BENCHMARK_FILE_COUNT);

    const naive = await mountNaiveFileTree(files);
    await naive.cleanup();

    const optimized = await mountOptimizedFileTree(files);
    try {
      const mountedRowReduction = naive.mountedRows / Math.max(optimized.mountedRows, 1);
      const elapsedReduction = naive.elapsedMs / Math.max(optimized.elapsedMs, 1);
      const benchmark = {
        inputFiles: FILE_TREE_BENCHMARK_FILE_COUNT,
        naiveMountedRows: naive.mountedRows,
        optimizedMountedRows: optimized.mountedRows,
        mountedRowReduction,
        elapsedReduction,
        naiveElapsedMs: Math.round(naive.elapsedMs),
        optimizedElapsedMs: Math.round(optimized.elapsedMs),
      };
      console.info("[benchmark] review file tree", JSON.stringify(benchmark));

      expect(naive.mountedRows).toBe(FILE_TREE_BENCHMARK_FILE_COUNT);
      expect(optimized.mountedRows).toBeGreaterThan(0);
      expect(mountedRowReduction).toBeGreaterThanOrEqual(MIN_FILE_TREE_RENDER_REDUCTION);
    } finally {
      await optimized.cleanup();
    }
  });
});

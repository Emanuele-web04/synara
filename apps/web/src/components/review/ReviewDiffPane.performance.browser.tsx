import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ReviewDiffPane } from "./ReviewDiffPane";

const DIFF_FILE_COUNT = 2_000;
const MIN_DIFF_RENDER_REDUCTION = 10;
const MIN_DIFF_ELAPSED_REDUCTION = 10;

interface BenchmarkFileDiff {
  readonly name: string;
  readonly prevName: string;
  readonly cacheKey: string;
}

const generatedFiles = vi.hoisted(() =>
  Array.from({ length: 2_000 }, (_, index) => {
    const path = `apps/web/src/generated/file-${String(index).padStart(4, "0")}.tsx`;
    return {
      name: `b/${path}`,
      prevName: `a/${path}`,
      cacheKey: `file-${String(index)}`,
    } satisfies BenchmarkFileDiff;
  }),
);
const generatedPatch = vi.hoisted(() =>
  Array.from({ length: 2_000 }, (_, index) => {
    const path = `apps/web/src/generated/file-${String(index).padStart(4, "0")}.tsx`;
    return [
      `diff --git a/${path} b/${path}`,
      "index 1111111..2222222 100644",
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1 +1 @@",
      `-old ${String(index)}`,
      `+new ${String(index)}`,
    ].join("\n");
  }).join("\n"),
);
const parsePatchFilesMock = vi.hoisted(() =>
  vi.fn((patch: string) => {
    const header = patch.match(/^diff --git a\/(.+) b\/(.+)$/m);
    const path = header?.[2] ?? "unknown.ts";
    return [
      {
        files: [
          {
            name: `b/${path}`,
            prevName: `a/${path}`,
            cacheKey: `parsed:${path}:${String(patch.length)}`,
          } satisfies BenchmarkFileDiff,
        ],
      },
    ];
  }),
);
const burnDiffBlockRenderWork = vi.hoisted(() => (seed: string): number => {
  let hash = 0;
  for (let index = 0; index < 160_000; index += 1) {
    hash = (hash + seed.charCodeAt(index % seed.length) * (index + 1)) % 1_000_003;
  }
  return hash;
});

vi.mock("@pierre/diffs", () => ({
  parsePatchFiles: parsePatchFilesMock,
}));

vi.mock("@pierre/diffs/react", () => ({
  FileDiff: (props: { fileDiff: BenchmarkFileDiff }) => {
    const checksum = burnDiffBlockRenderWork(props.fileDiff.cacheKey);
    return (
      <section
        data-review-file-diff={props.fileDiff.cacheKey}
        data-render-checksum={String(checksum)}
        style={{ height: "320px", borderBottom: "1px solid transparent" }}
      />
    );
  },
}));

function NaiveReviewDiffBody(props: { files: ReadonlyArray<BenchmarkFileDiff> }) {
  return (
    <div>
      {props.files.map((fileDiff) => (
        <NaiveReviewDiffBlock key={fileDiff.cacheKey} fileDiff={fileDiff} />
      ))}
    </div>
  );
}

function NaiveReviewDiffBlock(props: { fileDiff: BenchmarkFileDiff }) {
  const checksum = burnDiffBlockRenderWork(props.fileDiff.cacheKey);
  return (
    <section
      data-review-file-diff={props.fileDiff.cacheKey}
      data-render-checksum={String(checksum)}
      style={{ height: "320px", borderBottom: "1px solid transparent" }}
    />
  );
}

async function mountNaiveDiff() {
  const host = document.createElement("div");
  host.className = "h-[800px] bg-background text-foreground";
  document.body.append(host);
  const startedAt = performance.now();
  const screen = await render(<NaiveReviewDiffBody files={generatedFiles} />, { container: host });
  const elapsedMs = performance.now() - startedAt;
  return {
    elapsedMs,
    mountedDiffBlocks: host.querySelectorAll("[data-review-file-diff]").length,
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

async function mountOptimizedDiff() {
  await page.viewport(1440, 900);
  const host = document.createElement("div");
  host.className = "h-[800px] bg-background text-foreground";
  document.body.append(host);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const startedAt = performance.now();
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <ReviewDiffPane
        patch={generatedPatch}
        target={null}
        cwd={null}
        isLoading={false}
        summary={{ files: DIFF_FILE_COUNT, additions: DIFF_FILE_COUNT, deletions: 0 }}
        files={generatedFiles.map((fileDiff) => ({
          path: fileDiff.name.slice(2),
          status: "modified",
          insertions: 1,
          deletions: 0,
        }))}
        viewedPaths={new Set()}
        onSelectFile={() => {}}
        onToggleViewed={() => {}}
      />
    </QueryClientProvider>,
    { container: host },
  );
  await expect.element(page.getByText("Changed files", { exact: true })).toBeVisible();
  await vi.waitFor(() => {
    expect(host.querySelectorAll("[data-review-file-diff]").length).toBeGreaterThan(0);
  });
  const elapsedMs = performance.now() - startedAt;
  return {
    elapsedMs,
    mountedDiffBlocks: host.querySelectorAll("[data-review-file-diff]").length,
    optionNodes: host.querySelectorAll("option").length,
    cleanup: async () => {
      await screen.unmount();
      queryClient.clear();
      host.remove();
    },
  };
}

describe("review diff pane performance benchmark", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps mounted diff file work at least 10x below naive rendering", async () => {
    const naive = await mountNaiveDiff();
    await naive.cleanup();

    const optimized = await mountOptimizedDiff();
    try {
      const mountedBlockReduction =
        naive.mountedDiffBlocks / Math.max(optimized.mountedDiffBlocks, 1);
      const elapsedReduction = naive.elapsedMs / Math.max(optimized.elapsedMs, 1);
      const benchmark = {
        inputFiles: DIFF_FILE_COUNT,
        naiveMountedDiffBlocks: naive.mountedDiffBlocks,
        optimizedMountedDiffBlocks: optimized.mountedDiffBlocks,
        optimizedOptionNodes: optimized.optionNodes,
        optimizedParseCalls: parsePatchFilesMock.mock.calls.length,
        mountedBlockReduction,
        elapsedReduction,
        naiveElapsedMs: Math.round(naive.elapsedMs),
        optimizedElapsedMs: Math.round(optimized.elapsedMs),
      };
      console.info("[benchmark] review diff pane", JSON.stringify(benchmark));

      expect(naive.mountedDiffBlocks).toBe(DIFF_FILE_COUNT);
      expect(optimized.mountedDiffBlocks).toBeGreaterThan(0);
      expect(optimized.optionNodes).toBe(0);
      expect(parsePatchFilesMock.mock.calls.length).toBeLessThan(60);
      expect(mountedBlockReduction).toBeGreaterThanOrEqual(MIN_DIFF_RENDER_REDUCTION);
      expect(elapsedReduction).toBeGreaterThanOrEqual(MIN_DIFF_ELAPSED_REDUCTION);
    } finally {
      await optimized.cleanup();
    }
  });
});

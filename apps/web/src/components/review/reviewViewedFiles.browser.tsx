import type { ReviewTargetKey } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { reviewViewedStorageKey, useReviewViewedFiles } from "./reviewViewedFiles";

const TARGET: ReviewTargetKey = { _tag: "pullRequest", repositoryId: "repo123", number: 7 };

function ViewedHarness(props: {
  target: ReviewTargetKey | null;
  filePaths: ReadonlyArray<string>;
}) {
  const { viewedPaths, toggleViewed } = useReviewViewedFiles(props.target, props.filePaths);
  return (
    <div>
      <output aria-label="viewed files">{[...viewedPaths].join(",")}</output>
      <button type="button" onClick={() => toggleViewed("src/a.ts")}>
        Toggle A
      </button>
      <button type="button" onClick={() => toggleViewed("src/missing.ts")}>
        Toggle Missing
      </button>
    </div>
  );
}

async function mountViewedHarness(props: {
  target: ReviewTargetKey | null;
  filePaths: ReadonlyArray<string>;
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(<ViewedHarness target={props.target} filePaths={props.filePaths} />, {
    container: host,
  });
  return {
    rerender: async (nextProps: {
      target: ReviewTargetKey | null;
      filePaths: ReadonlyArray<string>;
    }) => {
      await screen.rerender(
        <ViewedHarness target={nextProps.target} filePaths={nextProps.filePaths} />,
      );
    },
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("useReviewViewedFiles", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("persists viewed files and ignores paths outside the current file list", async () => {
    const mounted = await mountViewedHarness({
      target: TARGET,
      filePaths: ["src/a.ts", "src/b.ts"],
    });

    try {
      await page.getByRole("button", { name: "Toggle A" }).click();
      await page.getByRole("button", { name: "Toggle Missing" }).click();

      await vi.waitFor(() => {
        expect(page.getByLabelText("viewed files").element()).toHaveTextContent("src/a.ts");
      });

      const key = reviewViewedStorageKey(TARGET);
      expect(key).not.toBeNull();
      expect(localStorage.getItem(key ?? "")).toBe(JSON.stringify(["src/a.ts"]));
    } finally {
      await mounted.cleanup();
    }
  });

  it("prunes loaded viewed state when the changed-file list changes", async () => {
    const key = reviewViewedStorageKey(TARGET);
    expect(key).not.toBeNull();
    localStorage.setItem(key ?? "", JSON.stringify(["src/a.ts", "src/deleted.ts"]));

    const mounted = await mountViewedHarness({
      target: TARGET,
      filePaths: ["src/a.ts", "src/b.ts"],
    });

    try {
      await vi.waitFor(() => {
        expect(page.getByLabelText("viewed files").element()).toHaveTextContent("src/a.ts");
      });

      await mounted.rerender({ target: TARGET, filePaths: ["src/b.ts"] });

      await vi.waitFor(() => {
        expect(page.getByLabelText("viewed files").element()).toHaveTextContent("");
      });
      expect(localStorage.getItem(key ?? "")).toBe(JSON.stringify([]));
    } finally {
      await mounted.cleanup();
    }
  });

  it("stays inert until a review target exists", async () => {
    const mounted = await mountViewedHarness({
      target: null,
      filePaths: ["src/a.ts"],
    });

    try {
      await page.getByRole("button", { name: "Toggle A" }).click();

      await vi.waitFor(() => {
        expect(page.getByLabelText("viewed files").element()).toHaveTextContent("");
      });
      expect(localStorage.length).toBe(0);
    } finally {
      await mounted.cleanup();
    }
  });
});

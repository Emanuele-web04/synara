import "../../index.css";

import type { NativeApi, ProjectFileSystemEntry } from "@synara/contracts";
import { ThreadId } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  requestExplorerReveal,
  useExplorerRevealRequestStore,
} from "../../explorerRevealRequestStore";
import { resolveWorkspaceDirectoryOpenTarget } from "../../lib/workspaceFileOpener";
import { projectListDirectoriesQueryOptions } from "../../lib/projectReactQuery";
import { DockExplorerPane } from "./DockExplorerPane";

vi.mock("../WorkspaceFilePreview", () => ({ WorkspaceFilePreview: () => null }));

const threadId = ThreadId.makeUnsafe("directory-reveal-test");
let restoreNativeApi: (() => void) | undefined;

afterEach(() => {
  restoreNativeApi?.();
  useExplorerRevealRequestStore.setState({ requestsByThreadId: {} });
});

function directory(path: string): ProjectFileSystemEntry {
  return { path, name: path.split("/").at(-1)!, kind: "directory", hasChildren: true };
}

async function renderExplorer(
  cwd: string,
  listDirectories: NativeApi["projects"]["listDirectories"],
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const previous = Object.getOwnPropertyDescriptor(window, "nativeApi");
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: {
      projects: {
        listDirectories,
        searchEntries: vi.fn().mockResolvedValue({ entries: [], truncated: false }),
      },
    },
  });
  restoreNativeApi = () => {
    if (previous) Object.defineProperty(window, "nativeApi", previous);
    else Reflect.deleteProperty(window, "nativeApi");
  };
  return render(
    <QueryClientProvider client={queryClient}>
      <DockExplorerPane threadId={threadId} workspaceRoot={cwd} isVisible />
    </QueryClientProvider>,
  );
}

it("reveals Windows links using actual entry casing and still collapses manually", async () => {
  const cwd = "c:/repo/app";
  const listDirectories = vi
    .fn<NativeApi["projects"]["listDirectories"]>()
    .mockImplementation(async ({ relativePath }) => ({
      entries:
        relativePath === "src"
          ? [directory("src/inner")]
          : relativePath === "src/inner"
            ? [{ path: "src/inner/readme.md", name: "readme.md", kind: "file" }]
            : [directory("src")],
    }));
  await renderExplorer(cwd, listDirectories);
  requestExplorerReveal(
    threadId,
    resolveWorkspaceDirectoryOpenTarget("C:\\Repo\\App\\SRC\\INNER\\", cwd)!,
  );

  await expect.element(page.getByTitle("src/inner/readme.md", { exact: true })).toBeVisible();
  expect(listDirectories).toHaveBeenCalledWith({ cwd, relativePath: "src", includeFiles: true });
  await page.getByTitle("src", { exact: true }).click();
  await expect
    .element(page.getByTitle("src", { exact: true }))
    .toHaveAttribute("aria-expanded", "false");
});

it("keeps POSIX directory reveals case-sensitive", async () => {
  const cwd = "/repo/app";
  await renderExplorer(
    cwd,
    vi
      .fn<NativeApi["projects"]["listDirectories"]>()
      .mockImplementation(async ({ relativePath }) => ({
        entries: relativePath
          ? [{ path: `${relativePath}/readme.md`, name: "readme.md", kind: "file" }]
          : [directory("src"), directory("SRC")],
      })),
  );
  requestExplorerReveal(threadId, resolveWorkspaceDirectoryOpenTarget("/repo/app/SRC/", cwd)!);

  await expect.element(page.getByTitle("SRC/readme.md", { exact: true })).toBeVisible();
  await expect
    .element(page.getByTitle("src", { exact: true }))
    .toHaveAttribute("aria-expanded", "false");
});

it("clears an existing search when the workspace root is revealed", async () => {
  const cwd = "c:/repo/app";
  await renderExplorer(cwd, vi.fn().mockResolvedValue({ entries: [directory("src")] }));
  const search = page.getByPlaceholder("Search files");
  await search.fill("missing");
  await expect.element(page.getByText("No matching files.")).toBeVisible();

  requestExplorerReveal(threadId, resolveWorkspaceDirectoryOpenTarget("C:\\Repo\\App", cwd)!);
  await expect.element(search).toHaveValue("");
  await expect.element(page.getByTitle("src", { exact: true })).toBeVisible();
});

it("ignores a pending directory reveal after a newer root request", async () => {
  const cwd = "c:/repo/app";
  let resolveListing!: (result: { entries: ProjectFileSystemEntry[] }) => void;
  const pending = new Promise<{ entries: ProjectFileSystemEntry[] }>((resolve) => {
    resolveListing = resolve;
  });
  const listDirectories = vi
    .fn<NativeApi["projects"]["listDirectories"]>()
    .mockReturnValue(pending);
  await renderExplorer(cwd, listDirectories);
  const search = page.getByPlaceholder("Search files");
  await search.fill("before first reveal");
  requestExplorerReveal(threadId, "SRC");
  await expect.element(search).toHaveValue("");
  await search.fill("before root reveal");
  requestExplorerReveal(threadId, "");
  await expect.element(search).toHaveValue("");
  resolveListing({ entries: [directory("src")] });

  await expect.element(page.getByTitle("src", { exact: true })).toBeVisible();
  await expect
    .element(page.getByTitle("src", { exact: true }))
    .toHaveAttribute("aria-expanded", "false");
});

it("refreshes an invalidated listing before resolving a Windows reveal", async () => {
  const cwd = "c:/repo/app";
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const childQuery = projectListDirectoriesQueryOptions({ cwd, relativePath: "src" });
  queryClient.setQueryData(childQuery.queryKey, { entries: [] });
  await queryClient.invalidateQueries({ queryKey: childQuery.queryKey, refetchType: "none" });
  const listDirectories = vi
    .fn<NativeApi["projects"]["listDirectories"]>()
    .mockImplementation(async ({ relativePath }) => ({
      entries:
        relativePath === "src"
          ? [directory("src/new")]
          : relativePath === "src/new"
            ? []
            : [directory("src")],
    }));
  await renderExplorer(cwd, listDirectories, queryClient);
  requestExplorerReveal(threadId, "SRC/NEW");

  await expect
    .element(page.getByTitle("src/new", { exact: true }))
    .toHaveAttribute("aria-expanded", "true");
  expect(listDirectories).toHaveBeenCalledWith({ cwd, relativePath: "src", includeFiles: true });
});

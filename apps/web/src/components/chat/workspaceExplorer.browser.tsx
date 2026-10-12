// FILE: workspaceExplorer.browser.tsx
// Purpose: Explorer compaction, lazy loading, Git updates, and secure copy regressions.
// Layer: Browser component tests (mocked native API; no running Synara server).

import "../../index.css";

import type {
  GitStatusResult,
  NativeApi,
  ProjectFileSystemEntry,
  ProjectReadFileResult,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { CHAT_FILE_REFERENCE_DRAG_TYPE } from "~/lib/chatReferences";
import { gitQueryKeys } from "~/lib/gitReactQuery";
import { projectListDirectoriesQueryOptions } from "~/lib/projectReactQuery";
import { WorkspaceExplorerSidebar } from "./workspaceExplorer";

const harness = vi.hoisted(() => ({ toast: vi.fn(), clipboard: vi.fn() }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: harness.toast } }));
vi.mock("~/lib/syntaxHighlighting", () => ({
  getSyntaxLanguageForPath: () => "text",
  getSyntaxHighlighterPromise: () => Promise.resolve({}),
}));

const CWD = "/workspace/explorer-154";
const CLEAN_STATUS: GitStatusResult = {
  branch: "main",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: false,
  upstreamBranch: null,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};
const READ_FILE: ProjectReadFileResult = {
  relativePath: "readme.md",
  contents: "read me\n",
  truncated: false,
  version: "1",
  encoding: "utf8",
  lineEnding: "lf",
};
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
let restoreNativeApi: (() => void) | undefined;
let queryClient: QueryClient;

function entry(
  path: string,
  kind: ProjectFileSystemEntry["kind"] = "directory",
): ProjectFileSystemEntry {
  return { path, name: path.split("/").at(-1)!, kind };
}

function ExplorerHarness(props: {
  cwd: string;
  onSelectFile: (path: string) => void;
  onReferenceInChat: (reference: { path: string }) => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState("");
  return (
    <QueryClientProvider client={queryClient}>
      <WorkspaceExplorerSidebar
        workspaceRoot={props.cwd}
        selectedFilePath={null}
        expandedDirectories={expanded}
        query={query}
        onQueryChange={setQuery}
        onSelectFile={props.onSelectFile}
        onReferenceInChat={props.onReferenceInChat}
        onToggleDirectory={(path) =>
          setExpanded((previous) => {
            const next = new Set(previous);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
          })
        }
      />
    </QueryClientProvider>
  );
}

async function renderExplorer(
  listDirectories: NativeApi["projects"]["listDirectories"],
  status = CLEAN_STATUS,
) {
  const readFile = vi.fn<NativeApi["projects"]["readFile"]>().mockResolvedValue(READ_FILE);
  const showMenu = vi.fn<NativeApi["contextMenu"]["show"]>().mockResolvedValue(null);
  const searchEntries = vi.fn<NativeApi["projects"]["searchEntries"]>().mockResolvedValue({
    entries: [{ path: "readme.md", kind: "file" }],
    truncated: false,
  });
  const previous = Object.getOwnPropertyDescriptor(window, "nativeApi");
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: {
      projects: { listDirectories, readFile, searchEntries },
      contextMenu: { show: showMenu },
      git: {
        status: vi
          .fn()
          .mockImplementation(async ({ cwd }) => (cwd === CWD ? status : CLEAN_STATUS)),
      },
    },
  });
  restoreNativeApi = () => {
    if (previous) Object.defineProperty(window, "nativeApi", previous);
    else Reflect.deleteProperty(window, "nativeApi");
  };
  const onSelectFile = vi.fn();
  const onReferenceInChat = vi.fn();
  const screen = await render(
    <ExplorerHarness cwd={CWD} onSelectFile={onSelectFile} onReferenceInChat={onReferenceInChat} />,
  );
  return { screen, readFile, showMenu, onSelectFile, onReferenceInChat };
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  harness.toast.mockReset();
  harness.clipboard.mockReset();
  harness.clipboard.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: harness.clipboard },
  });
});

afterEach(() => {
  queryClient.clear();
  restoreNativeApi?.();
  restoreNativeApi = undefined;
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

it("loads only the expanded chain, retains keyboard focus, and targets its final path for references", async () => {
  const listDirectories = vi
    .fn<NativeApi["projects"]["listDirectories"]>()
    .mockImplementation(async ({ relativePath }) => ({
      entries:
        relativePath === "src"
          ? [entry("src/components")]
          : relativePath === "src/components"
            ? [entry("src/components/ui")]
            : relativePath === "src/components/ui"
              ? [
                  entry("src/components/ui/button.tsx", "file"),
                  entry("src/components/ui/readme.md", "file"),
                ]
              : [entry("src"), entry("docs")],
    }));
  const { showMenu, onSelectFile, onReferenceInChat } = await renderExplorer(listDirectories);
  await expect.element(page.getByTitle("src", { exact: true })).toBeVisible();
  expect(listDirectories.mock.calls.map(([input]) => input.relativePath)).toEqual([undefined]);
  const originalTrigger = page.getByTitle("src", { exact: true }).element();
  (originalTrigger as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  const compact = page.getByTitle("src/components/ui", { exact: true });
  await expect.element(compact).toHaveTextContent("src/components/ui");
  await expect.element(compact).toHaveFocus();
  expect(compact.element()).toBe(originalTrigger);
  await expect
    .element(page.getByTitle("src/components/ui/button.tsx", { exact: true }))
    .toBeVisible();
  expect(listDirectories.mock.calls.some(([input]) => input.relativePath === "docs")).toBe(false);

  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect(onSelectFile).toHaveBeenCalledWith("src/components/ui/button.tsx");
  showMenu.mockResolvedValue("reference-in-chat");
  await compact.click({ button: "right" });
  await expect.poll(() => onReferenceInChat.mock.calls).toEqual([[{ path: "src/components/ui" }]]);
  const transfer = new DataTransfer();
  compact
    .element()
    .dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: transfer }));
  expect(transfer.getData("text/plain")).toBe("src/components/ui");
  expect(transfer.getData(CHAT_FILE_REFERENCE_DRAG_TYPE)).toBe("@src/components/ui");

  (compact.element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(compact).toHaveAttribute("aria-expanded", "false");
  await expect
    .element(page.getByTitle("src/components/ui/button.tsx", { exact: true }))
    .not.toBeInTheDocument();
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByTitle("src/components/ui/button.tsx", { exact: true }))
    .toBeVisible();
  expect(
    listDirectories.mock.calls.filter(([input]) => input.relativePath === "src/components/ui"),
  ).toHaveLength(1);
});

it("shows loading and directory failures rather than an empty placeholder listing", async () => {
  let resolveRoot!: (value: { entries: ProjectFileSystemEntry[] }) => void;
  const pending = new Promise<{ entries: ProjectFileSystemEntry[] }>((resolve) => {
    resolveRoot = resolve;
  });
  const listDirectories = vi
    .fn<NativeApi["projects"]["listDirectories"]>()
    .mockImplementation(({ relativePath }) =>
      relativePath ? Promise.reject(new Error("Directory access denied")) : pending,
    );
  await renderExplorer(listDirectories);
  await expect.element(page.getByRole("status", { name: "Loading directory..." })).toBeVisible();
  resolveRoot({ entries: [entry("src")] });
  await page.getByTitle("src", { exact: true }).click();
  await expect.element(page.getByText("Directory access denied")).toBeVisible();
});

it("splits a compact row when a cached intermediate listing gains a sibling", async () => {
  const listDirectories = vi
    .fn<NativeApi["projects"]["listDirectories"]>()
    .mockImplementation(async ({ relativePath }) => ({
      entries:
        relativePath === "src"
          ? [entry("src/ui")]
          : relativePath === "src/ui"
            ? [entry("src/ui/button.tsx", "file")]
            : [entry("src")],
    }));
  await renderExplorer(listDirectories);
  await page.getByTitle("src", { exact: true }).click();
  await expect.element(page.getByTitle("src/ui", { exact: true })).toHaveTextContent("src/ui");
  queryClient.setQueryData(
    projectListDirectoriesQueryOptions({ cwd: CWD, relativePath: "src" }).queryKey,
    {
      entries: [entry("src/ui"), entry("src/lib")],
    },
  );
  await expect
    .element(page.getByTitle("src", { exact: true }))
    .toHaveAttribute("aria-expanded", "true");
  await expect.element(page.getByTitle("src/lib", { exact: true })).toBeVisible();
  await expect
    .element(page.getByTitle("src/ui", { exact: true }))
    .toHaveAttribute("aria-expanded", "false");
});

it("surfaces failed refreshes of an intermediate compacted directory", async () => {
  const listDirectories = vi
    .fn<NativeApi["projects"]["listDirectories"]>()
    .mockImplementation(async ({ relativePath }) => ({
      entries:
        relativePath === "src"
          ? [entry("src/ui")]
          : relativePath === "src/ui"
            ? [entry("src/ui/button.tsx", "file")]
            : [entry("src")],
    }));
  await renderExplorer(listDirectories);
  await page.getByTitle("src", { exact: true }).click();
  await expect.element(page.getByTitle("src/ui/button.tsx", { exact: true })).toBeVisible();
  listDirectories.mockRejectedValue(new Error("Directory disappeared"));
  await queryClient.invalidateQueries({
    queryKey: projectListDirectoriesQueryOptions({ cwd: CWD, relativePath: "src" }).queryKey,
    exact: true,
  });
  await expect.element(page.getByText("Directory disappeared")).toBeVisible();
});

it("marks ancestor directories when Git reports a changed descendant", async () => {
  await renderExplorer(vi.fn().mockResolvedValue({ entries: [entry("src"), entry("docs")] }), {
    ...CLEAN_STATUS,
    hasWorkingTreeChanges: true,
    workingTree: {
      files: [{ path: "src/ui/button.tsx", insertions: 1, deletions: 1 }],
      insertions: 1,
      deletions: 1,
    },
  });
  await expect.element(page.getByTitle("Contains working tree changes")).toBeVisible();
  expect(
    page.getByTitle("src", { exact: true }).element().querySelector(".text-warning"),
  ).not.toBeNull();
  expect(
    page.getByTitle("docs", { exact: true }).element().querySelector(".text-warning"),
  ).toBeNull();
});

it("updates Git indicators from the shared status cache without guessing added/deleted from counts", async () => {
  const status = {
    ...CLEAN_STATUS,
    hasWorkingTreeChanges: true,
    workingTree: {
      files: [
        { path: "insert-only.ts", insertions: 1, deletions: 0 },
        { path: "binary.dat", insertions: 0, deletions: 0 },
      ],
      insertions: 1,
      deletions: 0,
    },
  };
  const listDirectories = vi.fn<NativeApi["projects"]["listDirectories"]>().mockResolvedValue({
    entries: [
      entry("insert-only.ts", "file"),
      entry("binary.dat", "file"),
      entry("clean.ts", "file"),
    ],
  });
  const { screen, onSelectFile, onReferenceInChat } = await renderExplorer(listDirectories, status);
  await expect
    .poll(() => document.querySelectorAll('[title="Working tree changes"]').length)
    .toBe(2);
  expect(
    page.getByTitle("insert-only.ts", { exact: true }).element().querySelector(".text-warning"),
  ).not.toBeNull();
  expect(
    page.getByTitle("clean.ts", { exact: true }).element().querySelector(".text-warning"),
  ).toBeNull();
  queryClient.setQueryData(gitQueryKeys.status(CWD), CLEAN_STATUS);
  await expect
    .poll(() => document.querySelectorAll('[title="Working tree changes"]').length)
    .toBe(0);
  queryClient.setQueryData(gitQueryKeys.status(CWD), status);
  await screen.rerender(
    <ExplorerHarness
      cwd="/workspace/other-explorer-154"
      onSelectFile={onSelectFile}
      onReferenceInChat={onReferenceInChat}
    />,
  );
  await expect.element(page.getByTitle("clean.ts", { exact: true })).toBeVisible();
  await expect
    .poll(() => document.querySelectorAll('[title="Working tree changes"]').length)
    .toBe(0);
  // The old checkout's cached changes must not leak into a different root.
});

it("renders authoritative colors and honest labels for empty/binary files without inventing deleted rows", async () => {
  const cases = [
    { path: "added-empty.txt", changeType: "added", label: "Added", color: "text-success" },
    { path: "untracked.bin", changeType: "untracked", label: "Untracked", color: "text-success" },
    { path: "insert-only.txt", changeType: "modified", label: "Modified", color: "text-warning" },
    {
      path: "deleted-stale.txt",
      changeType: "deleted",
      label: "Deleted",
      color: "text-destructive",
    },
    { path: "renamed.bin", changeType: "renamed", label: "Renamed", color: "text-warning" },
    { path: "copied.bin", changeType: "copied", label: "Copied", color: "text-warning" },
    {
      path: "conflict.txt",
      changeType: "unmerged",
      label: "Unmerged (conflict)",
      color: "text-warning",
    },
    {
      path: "type-change",
      changeType: "type-changed",
      label: "Type changed",
      color: "text-warning",
    },
  ] as const;
  const status: GitStatusResult = {
    ...CLEAN_STATUS,
    hasWorkingTreeChanges: true,
    workingTree: {
      files: [
        ...cases.map(({ path, changeType }) => ({ path, changeType, insertions: 0, deletions: 0 })),
        { path: "deleted-absent.txt", insertions: 0, deletions: 0, changeType: "deleted" },
      ],
      insertions: 0,
      deletions: 0,
    },
  };
  await renderExplorer(
    vi.fn().mockResolvedValue({ entries: cases.map(({ path }) => entry(path, "file")) }),
    status,
  );
  await expect.element(page.getByTitle("Added", { exact: true })).toBeVisible();
  for (const { path, label, color } of cases) {
    const row = page.getByTitle(path, { exact: true }).element();
    expect(row.querySelector(`.${color}`)).not.toBeNull();
    expect(row.querySelector(`[title="${label}"]`)?.getAttribute("aria-label")).toBe(label);
  }
  await expect
    .element(page.getByTitle("deleted-absent.txt", { exact: true }))
    .not.toBeInTheDocument();
  queryClient.setQueryData(gitQueryKeys.status(CWD), {
    ...status,
    workingTree: {
      ...status.workingTree,
      files: [{ path: "added-empty.txt", insertions: 0, deletions: 0, changeType: "modified" }],
    },
  });
  await expect
    .poll(() =>
      page
        .getByTitle("added-empty.txt", { exact: true })
        .element()
        .querySelector('[title="Modified"]')
        ?.getAttribute("aria-label"),
    )
    .toBe("Modified");
  expect(
    page.getByTitle("added-empty.txt", { exact: true }).element().querySelector(".text-warning"),
  ).not.toBeNull();
});

it("does not hide an unmerged descendant when its parent chain is compacted or closed", async () => {
  const listDirectories = vi
    .fn<NativeApi["projects"]["listDirectories"]>()
    .mockImplementation(async ({ relativePath }) => ({
      entries:
        relativePath === "src"
          ? [entry("src/ui")]
          : relativePath === "src/ui"
            ? [entry("src/ui/conflict.txt", "file")]
            : [entry("src")],
    }));
  await renderExplorer(listDirectories, {
    ...CLEAN_STATUS,
    hasWorkingTreeChanges: true,
    workingTree: {
      files: [{ path: "src/ui/conflict.txt", insertions: 0, deletions: 0, changeType: "unmerged" }],
      insertions: 0,
      deletions: 0,
    },
  });
  await expect.element(page.getByTitle("Contains unmerged changes")).toBeVisible();
  // Pointer/focus prefetch can compact the label before the click. Target the
  // same directory button rather than its transient unprefetched title.
  await page.getByRole("button", { name: /^src(?:\/ui)?/ }).click();
  await expect.element(page.getByTitle("src/ui", { exact: true })).toHaveTextContent("src/ui");
  await expect.element(page.getByTitle("Unmerged (conflict)")).toBeVisible();
  await page.getByTitle("src/ui", { exact: true }).click();
  await expect.element(page.getByTitle("Contains unmerged changes")).toBeVisible();
  await expect.element(page.getByTitle("Unmerged (conflict)")).not.toBeInTheDocument();
});

it("keeps a direct directory status visible after compacting its child chain", async () => {
  const listDirectories = vi
    .fn<NativeApi["projects"]["listDirectories"]>()
    .mockImplementation(async ({ relativePath }) => ({
      entries:
        relativePath === "module"
          ? [entry("module/src")]
          : relativePath === "module/src"
            ? [entry("module/src/readme.md", "file")]
            : [entry("module")],
    }));
  await renderExplorer(listDirectories, {
    ...CLEAN_STATUS,
    hasWorkingTreeChanges: true,
    workingTree: {
      files: [{ path: "module", insertions: 0, deletions: 0, changeType: "modified" }],
      insertions: 0,
      deletions: 0,
    },
  });
  await page.getByRole("button", { name: /^module(?:\/src)?/ }).click();
  await expect
    .element(page.getByTitle("module/src", { exact: true }))
    .toHaveTextContent("module/src");
  await expect.element(page.getByTitle("Modified", { exact: true })).toBeVisible();
  expect(
    page.getByTitle("module/src", { exact: true }).element().querySelector(".text-warning"),
  ).not.toBeNull();
});

it.each([
  { contents: "read me\n", truncated: false, title: "Contents copied" },
  { contents: "first bytes", truncated: true, title: "Partial contents copied" },
  { contents: "", truncated: false, title: "Nothing to copy" },
])("reuses the content-copy helper for $title", async ({ contents, truncated, title }) => {
  const { readFile, showMenu } = await renderExplorer(
    vi.fn().mockResolvedValue({ entries: [entry("readme.md", "file")] }),
  );
  readFile.mockResolvedValue({ ...READ_FILE, contents, truncated });
  showMenu.mockResolvedValue("copy-file-content");
  await page.getByTitle("readme.md", { exact: true }).click({ button: "right" });
  await expect.poll(() => harness.toast.mock.calls.map(([toast]) => toast.title)).toContain(title);
  expect(readFile).toHaveBeenCalledWith({ cwd: CWD, relativePath: "readme.md" });
  if (contents) expect(harness.clipboard).toHaveBeenCalledWith(contents);
  else expect(harness.clipboard).not.toHaveBeenCalled();
});

it("keeps copy variants available for searched files", async () => {
  const { showMenu } = await renderExplorer(vi.fn().mockResolvedValue({ entries: [] }), {
    ...CLEAN_STATUS,
    hasWorkingTreeChanges: true,
    workingTree: {
      files: [{ path: "readme.md", insertions: 0, deletions: 0, changeType: "added" }],
      insertions: 0,
      deletions: 0,
    },
  });
  await page.getByRole("textbox", { name: "Search files" }).fill("readme");
  await page.getByTitle("readme.md", { exact: true }).click({ button: "right" });
  expect(
    page.getByTitle("readme.md", { exact: true }).element().querySelector(".text-success"),
  ).not.toBeNull();
  const items = showMenu.mock.calls[0]?.[0];
  expect(items?.find((item) => item.id === "copy")?.children?.map((item) => item.id)).toEqual([
    "copy-path",
    "copy-absolute-path",
    "copy-file-content",
  ]);
});

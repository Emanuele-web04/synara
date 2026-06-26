// FILE: ReviewFileTreePanel.tsx
// Purpose: Compact, searchable file-tree side panel for the review/diff panel.
//          Renders the changed files of the active diff as a nested, collapsible
//          tree and navigates the diff on click. Reuses the diff path helpers,
//          file-row chrome, file icons, and disclosure motion shared with the
//          editor explorer instead of duplicating them.
// Layer: Diff panel UI

import type { FileDiffMetadata } from "@pierre/diffs/react";
import {
  forwardRef,
  memo,
  useCallback,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import { buildFileDiffTree, type FileDiffTreeNode } from "~/lib/fileDiffTree";
import { XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import { filterRenderableFilesForSearch } from "./DiffPanel.logic";
import { FileEntryIcon } from "./chat/FileEntryIcon";
import { fileRowClassName, fileRowIndentStyle } from "./chat/fileRowStyles";
import { PanelStateMessage } from "./chat/PanelStateMessage";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible";
import { DisclosureChevron } from "./ui/DisclosureChevron";
import { IconButton } from "./ui/icon-button";
import { SearchInput } from "./ui/search-input";
import { Skeleton } from "./ui/skeleton";

// Forwards its ref and spreads incoming props so directory rows can act as the
// Collapsible trigger (Base UI injects onClick/aria/data + ref onto this element).
const ReviewTreeRow = forwardRef<
  HTMLButtonElement,
  {
    depth: number;
    selected: boolean;
    leading: ReactNode;
    label: string;
    labelClassName?: string;
  } & ComponentPropsWithoutRef<"button">
>(function ReviewTreeRow(
  { depth, selected, leading, label, labelClassName, className, ...rest },
  ref,
) {
  return (
    <button
      {...rest}
      ref={ref}
      type="button"
      className={fileRowClassName(selected, cn("h-7 pr-2", className))}
      style={fileRowIndentStyle(depth)}
      title={label}
    >
      {leading}
      <span className={cn("min-w-0 truncate", labelClassName)}>{label}</span>
    </button>
  );
});

const ReviewFileTreeNodes = memo(function ReviewFileTreeNodes(props: {
  nodes: ReadonlyArray<FileDiffTreeNode>;
  depth: number;
  selectedFilePath: string | null;
  resolvedTheme: "light" | "dark";
  isPathCollapsed: (path: string) => boolean;
  onToggleDirectory: (path: string) => void;
  onSelectFile: (path: string) => void;
}) {
  return (
    <>
      {props.nodes.map((node) => {
        if (node.kind === "file") {
          return (
            // Namespace keys by kind: a diff that replaces a file with a
            // same-named directory (delete `foo`, add `foo/bar`) yields sibling
            // file and directory nodes sharing the same path.
            <ReviewTreeRow
              key={`file:${node.path}`}
              depth={props.depth}
              selected={node.path === props.selectedFilePath}
              leading={
                <FileEntryIcon
                  pathValue={node.path}
                  kind="file"
                  theme={props.resolvedTheme}
                  className="size-3.5 shrink-0 opacity-80"
                />
              }
              label={node.name}
              onClick={() => props.onSelectFile(node.path)}
            />
          );
        }
        const open = !props.isPathCollapsed(node.path);
        return (
          <Collapsible
            key={`dir:${node.path}`}
            open={open}
            onOpenChange={() => props.onToggleDirectory(node.path)}
          >
            <CollapsibleTrigger
              render={
                <ReviewTreeRow
                  depth={props.depth}
                  selected={false}
                  leading={<DisclosureChevron open={open} className="opacity-75" />}
                  label={node.name}
                  labelClassName="font-medium text-foreground/80"
                />
              }
            />
            <CollapsiblePanel>
              <ReviewFileTreeNodes
                nodes={node.children}
                depth={props.depth + 1}
                selectedFilePath={props.selectedFilePath}
                resolvedTheme={props.resolvedTheme}
                isPathCollapsed={props.isPathCollapsed}
                onToggleDirectory={props.onToggleDirectory}
                onSelectFile={props.onSelectFile}
              />
            </CollapsiblePanel>
          </Collapsible>
        );
      })}
    </>
  );
});

const REVIEW_TREE_SKELETON_ROW_WIDTHS = ["w-9/12", "w-6/12", "w-8/12", "w-5/12", "w-7/12"];

function ReviewFileTreeLoadingRows() {
  return (
    <div className="space-y-1.5 px-1 py-1.5" role="status" aria-label="Loading changed files...">
      {REVIEW_TREE_SKELETON_ROW_WIDTHS.map((width, index) => (
        <div
          key={width}
          className="flex h-5 items-center gap-1.5"
          style={fileRowIndentStyle(index % 2)}
        >
          <Skeleton className="size-3.5 shrink-0 rounded-sm" />
          <Skeleton className={cn("h-3 rounded-full", width)} />
        </div>
      ))}
    </div>
  );
}

export const ReviewFileTreePanel = memo(function ReviewFileTreePanel(props: {
  files: ReadonlyArray<FileDiffMetadata>;
  selectedFilePath: string | null;
  resolvedTheme: "light" | "dark";
  isLoading?: boolean;
  className?: string;
  onSelectFile: (filePath: string) => void;
  onClose?: () => void;
}) {
  const [query, setQuery] = useState("");
  // Default fully expanded (the diff file set is known upfront and usually
  // small), so we track which directories the user has *collapsed* rather than
  // an expanded allow-list. While searching, collapse state is ignored so every
  // match stays visible.
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(() => new Set());

  const filteredFiles = useMemo(
    () => filterRenderableFilesForSearch(props.files, query),
    [props.files, query],
  );
  const tree = useMemo(() => buildFileDiffTree(filteredFiles), [filteredFiles]);

  const isSearching = query.trim().length > 0;
  const isPathCollapsed = useCallback(
    (path: string) => !isSearching && collapsedPaths.has(path),
    [collapsedPaths, isSearching],
  );
  const handleToggleDirectory = useCallback((path: string) => {
    setCollapsedPaths((previous) => {
      const next = new Set(previous);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);
  const handleSearchKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape" && query.length > 0) {
        event.stopPropagation();
        setQuery("");
      }
    },
    [query.length],
  );

  const hasFiles = props.files.length > 0;
  const showLoadingRows = (props.isLoading ?? false) && !hasFiles;

  return (
    <aside
      className={cn(
        "flex h-full w-full min-h-0 min-w-0 flex-col border-l border-border bg-[var(--color-background-surface)]",
        props.className,
      )}
      aria-label="Review files"
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/65 p-2">
        <SearchInput
          value={query}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          placeholder="Filter files..."
          aria-label="Filter files"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleSearchKeyDown}
        />
        {props.onClose ? (
          <IconButton
            variant="ghost"
            size="icon-xs"
            className="shrink-0 text-muted-foreground hover:text-foreground"
            label="Hide file tree"
            title="Hide file tree"
            onClick={props.onClose}
          >
            <XIcon className="size-3.5" />
          </IconButton>
        ) : null}
      </div>
      <div
        className={cn(
          "min-h-0 flex-1 overflow-auto px-1 py-1",
          (showLoadingRows || tree.length === 0) && "flex flex-col",
        )}
      >
        {showLoadingRows ? (
          <ReviewFileTreeLoadingRows />
        ) : !hasFiles ? (
          <PanelStateMessage density="compact" fill="flex">
            <p>No files in this diff.</p>
          </PanelStateMessage>
        ) : tree.length === 0 ? (
          <PanelStateMessage density="compact" fill="flex">
            <p>No matching files.</p>
          </PanelStateMessage>
        ) : (
          <ReviewFileTreeNodes
            nodes={tree}
            depth={0}
            selectedFilePath={props.selectedFilePath}
            resolvedTheme={props.resolvedTheme}
            isPathCollapsed={isPathCollapsed}
            onToggleDirectory={handleToggleDirectory}
            onSelectFile={props.onSelectFile}
          />
        )}
      </div>
    </aside>
  );
});

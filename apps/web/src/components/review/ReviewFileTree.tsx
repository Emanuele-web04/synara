import type { ReviewChangedFile } from "@t3tools/contracts";
import { hotkeysCoreFeature, syncDataLoaderFeature } from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef } from "react";
import { FileEntryIcon } from "../chat/FileEntryIcon";
import { useTheme } from "../../hooks/useTheme";
import { splitRepoRelativePath } from "~/lib/diffRendering";
import { CheckIcon, FileIcon, FolderClosedIcon, FolderOpenIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Tree, TreeItem, TreeItemLabel } from "../reui/tree";
import { DiffStat } from "../chat/DiffStatLabel";
import { Skeleton } from "../ui/skeleton";
import { EmptyState } from "./reviewPrimitives";

type ReviewFileTreeNode =
  | {
      type: "directory";
      path: string;
      name: string;
      children: ReviewFileTreeNode[];
      fileCount: number;
      viewedCount: number;
      additions: number;
      deletions: number;
    }
  | {
      type: "file";
      file: ReviewChangedFile;
    };

type ReviewDirectoryBuilder = Extract<ReviewFileTreeNode, { type: "directory" }> & {
  childMap: Map<string, ReviewDirectoryBuilder | Extract<ReviewFileTreeNode, { type: "file" }>>;
};

interface ReviewTreeItem {
  id: string;
  name: string;
  children?: string[];
  node: ReviewFileTreeNode;
}

interface ReviewTreeData {
  items: Record<string, ReviewTreeItem>;
  expandedItems: string[];
}

type ReviewTreeItemInstance = ReturnType<
  ReturnType<typeof useTree<ReviewTreeItem>>["getItems"]
>[number];

const REVIEW_FILE_TREE_ROW_HEIGHT_PX = 28;
const REVIEW_FILE_TREE_OVERSCAN = 12;

function sortTreeNodes(nodes: ReviewFileTreeNode[]): ReviewFileTreeNode[] {
  return nodes.toSorted((left, right) => {
    if (left.type !== right.type) {
      return left.type === "directory" ? -1 : 1;
    }
    const leftName =
      left.type === "directory" ? left.name : splitRepoRelativePath(left.file.path).name;
    const rightName =
      right.type === "directory" ? right.name : splitRepoRelativePath(right.file.path).name;
    return leftName.localeCompare(rightName, undefined, { numeric: true, sensitivity: "base" });
  });
}

function createDirectoryBuilder(name: string, path: string): ReviewDirectoryBuilder {
  return {
    type: "directory",
    path,
    name,
    children: [],
    childMap: new Map(),
    fileCount: 0,
    viewedCount: 0,
    additions: 0,
    deletions: 0,
  };
}

function buildReviewFileTree(
  files: ReadonlyArray<ReviewChangedFile>,
  viewedPaths: ReadonlySet<string>,
): ReviewFileTreeNode[] {
  const root = createDirectoryBuilder("", "");

  for (const file of files) {
    const segments = file.path.split("/").filter((segment) => segment.length > 0);
    if (segments.length === 0) {
      continue;
    }
    let directory = root;
    let currentPath = "";
    const directoryAncestors: ReviewDirectoryBuilder[] = [];
    for (const segment of segments.slice(0, -1)) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const existing = directory.childMap.get(segment);
      const childDirectory =
        existing?.type === "directory" ? existing : createDirectoryBuilder(segment, currentPath);
      directory.childMap.set(segment, childDirectory);
      directoryAncestors.push(childDirectory);
      directory = childDirectory;
    }
    const fileName = segments.at(-1);
    if (!fileName) {
      continue;
    }
    directory.childMap.set(fileName, { type: "file", file });
    for (const directory of directoryAncestors) {
      directory.fileCount += 1;
      directory.additions += file.insertions;
      directory.deletions += file.deletions;
      if (viewedPaths.has(file.path)) {
        directory.viewedCount += 1;
      }
    }
  }

  const finalize = (
    node: ReviewDirectoryBuilder | Extract<ReviewFileTreeNode, { type: "file" }>,
  ): ReviewFileTreeNode => {
    if (node.type === "file") {
      return node;
    }
    const children = sortTreeNodes(Array.from(node.childMap.values()).map(finalize));
    return {
      type: "directory",
      path: node.path,
      name: node.name,
      children,
      fileCount: node.fileCount,
      viewedCount: node.viewedCount,
      additions: node.additions,
      deletions: node.deletions,
    };
  };

  return sortTreeNodes(Array.from(root.childMap.values()).map(finalize));
}

function buildHeadlessTreeData(nodes: ReadonlyArray<ReviewFileTreeNode>): ReviewTreeData {
  const rootId = "__review_tree_root__";
  const rootItem: ReviewTreeItem = {
    id: rootId,
    name: "Files",
    children: [],
    node: {
      type: "directory",
      path: rootId,
      name: "Files",
      children: [],
      fileCount: 0,
      viewedCount: 0,
      additions: 0,
      deletions: 0,
    },
  };
  const items: Record<string, ReviewTreeItem> = {
    [rootId]: rootItem,
  };
  const expandedItems: string[] = [];

  const visit = (node: ReviewFileTreeNode): string => {
    if (node.type === "file") {
      const id = `file:${node.file.path}`;
      items[id] = {
        id,
        name: splitRepoRelativePath(node.file.path).name,
        node,
      };
      return id;
    }

    const id = `directory:${node.path}`;
    const children = node.children.map(visit);
    items[id] = {
      id,
      name: node.name,
      children,
      node,
    };
    expandedItems.push(id);
    return id;
  };

  rootItem.children = nodes.map(visit);
  return { items, expandedItems };
}

function ViewedCheckbox(props: { viewed: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={props.viewed}
      aria-label={props.viewed ? "Mark file as not reviewed" : "Mark file as reviewed"}
      title={props.viewed ? "Reviewed" : "Mark as reviewed"}
      onClick={(event) => {
        event.stopPropagation();
        props.onToggle();
      }}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full border outline-none transition-[background-color,border-color,color,opacity,transform] duration-150 motion-reduce:transition-none",
        "focus-visible:ring-2 focus-visible:ring-ring",
        props.viewed
          ? "border-success/25 bg-success/10 text-success-foreground/85 opacity-90"
          : "border-border/45 bg-muted/20 text-transparent opacity-45 hover:border-foreground/30 hover:opacity-100 group-hover/file:opacity-75",
      )}
    >
      <CheckIcon className="size-2.5" />
    </button>
  );
}

export function ReviewFileTree(props: {
  files: ReadonlyArray<ReviewChangedFile>;
  isLoading: boolean;
  selectedFilePath: string | null;
  onSelectFile: (path: string) => void;
  viewedPaths: ReadonlySet<string>;
  onToggleViewed: (path: string) => void;
  emptyMessage?: string | undefined;
}) {
  if (props.isLoading && props.files.length === 0) {
    return (
      <ul className="flex flex-col gap-1 p-2" aria-busy="true">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <li key={index} className="flex h-8 items-center gap-2 rounded-lg px-2">
            <Skeleton className="size-3.5 shrink-0 rounded-sm" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Skeleton className="h-2.5 w-4/5" />
              <Skeleton className="h-2 w-1/2" />
            </div>
            <Skeleton className="size-3.5 shrink-0 rounded-full" />
          </li>
        ))}
      </ul>
    );
  }

  if (props.files.length === 0) {
    return (
      <EmptyState icon={<FileIcon />} title="No file changes">
        {props.emptyMessage ?? "This changeset has no modified files to review."}
      </EmptyState>
    );
  }

  return (
    <ReviewHeadlessFileTree
      files={props.files}
      selectedFilePath={props.selectedFilePath}
      viewedPaths={props.viewedPaths}
      onSelectFile={props.onSelectFile}
      onToggleViewed={props.onToggleViewed}
    />
  );
}

function ReviewHeadlessFileTree(props: {
  files: ReadonlyArray<ReviewChangedFile>;
  selectedFilePath: string | null;
  viewedPaths: ReadonlySet<string>;
  onSelectFile: (path: string) => void;
  onToggleViewed: (path: string) => void;
}) {
  const { resolvedTheme } = useTheme();
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileTree = useMemo(
    () => buildReviewFileTree(props.files, props.viewedPaths),
    [props.files, props.viewedPaths],
  );
  const treeData = useMemo(() => buildHeadlessTreeData(fileTree), [fileTree]);
  const tree = useTree<ReviewTreeItem>({
    rootItemId: "__review_tree_root__",
    initialState: {
      expandedItems: treeData.expandedItems,
    },
    indent: 18,
    getItemName: (item) => item.getItemData().name,
    isItemFolder: (item) => (item.getItemData().children?.length ?? 0) > 0,
    dataLoader: {
      getItem: (itemId) => {
        const item = treeData.items[itemId];
        if (!item) {
          throw new Error(`Unknown review file tree item: ${itemId}`);
        }
        return item;
      },
      getChildren: (itemId) => treeData.items[itemId]?.children ?? [],
    },
    features: [syncDataLoaderFeature, hotkeysCoreFeature],
  });
  const visibleItems = tree.getItems();
  const selectedItemIndex = useMemo(
    () =>
      props.selectedFilePath === null
        ? -1
        : visibleItems.findIndex((item) => {
            const node = item.getItemData().node;
            return node.type === "file" && node.file.path === props.selectedFilePath;
          }),
    [props.selectedFilePath, visibleItems],
  );
  const rowVirtualizer = useVirtualizer({
    count: visibleItems.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => REVIEW_FILE_TREE_ROW_HEIGHT_PX,
    getItemKey: (index) => visibleItems[index]?.getId() ?? index,
    overscan: REVIEW_FILE_TREE_OVERSCAN,
  });

  useEffect(() => {
    if (selectedItemIndex < 0) return;
    rowVirtualizer.scrollToIndex(selectedItemIndex, { align: "center" });
  }, [rowVirtualizer, selectedItemIndex]);

  return (
    <div ref={scrollRef} className="h-full min-h-0 overflow-y-auto">
      <Tree tree={tree} indent={18} className="relative py-1">
        <div className="relative w-full" style={{ height: rowVirtualizer.getTotalSize() }}>
          {rowVirtualizer.getVirtualItems().map((virtualItem) => {
            const item = visibleItems[virtualItem.index];
            if (!item) return null;
            return (
              <div
                key={virtualItem.key}
                data-index={virtualItem.index}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${String(virtualItem.start)}px)` }}
              >
                <ReviewFileTreeItemRow
                  item={item}
                  selectedFilePath={props.selectedFilePath}
                  viewedPaths={props.viewedPaths}
                  resolvedTheme={resolvedTheme}
                  onSelectFile={props.onSelectFile}
                  onToggleViewed={props.onToggleViewed}
                />
              </div>
            );
          })}
        </div>
      </Tree>
    </div>
  );
}

function ReviewFileTreeItemRow(props: {
  item: ReviewTreeItemInstance;
  selectedFilePath: string | null;
  viewedPaths: ReadonlySet<string>;
  resolvedTheme: "light" | "dark";
  onSelectFile: (path: string) => void;
  onToggleViewed: (path: string) => void;
}) {
  const node = props.item.getItemData().node;

  if (node.type === "directory") {
    const directory = node;
    const containsSelected = directory.children.some((child) =>
      child.type === "file"
        ? child.file.path === props.selectedFilePath
        : props.selectedFilePath !== null && props.selectedFilePath.startsWith(`${child.path}/`),
    );
    const isComplete = directory.fileCount > 0 && directory.viewedCount === directory.fileCount;
    const FolderGlyph = props.item.isExpanded() ? FolderOpenIcon : FolderClosedIcon;
    return (
      <TreeItem
        item={props.item}
        aria-label={`${directory.name} ${directory.viewedCount}/${directory.fileCount}`}
        onClick={(event) => {
          if (containsSelected) {
            event.preventDefault();
          }
        }}
        className={cn(
          "group/directory flex h-7 w-full min-w-0 items-center pe-2 text-left text-[12px]",
          "transition-[background-color,opacity] duration-150 motion-reduce:transition-none",
        )}
      >
        <TreeItemLabel
          className={cn(
            "h-7 w-full bg-transparent px-0 py-0 hover:bg-muted/35 in-data-[selected=true]:bg-transparent",
            containsSelected
              ? "bg-muted/45"
              : "text-muted-foreground/82 opacity-95 hover:bg-muted/35 hover:opacity-100",
          )}
        >
          <FolderGlyph className="size-3.5 shrink-0 text-muted-foreground/78" />
          <span
            className={cn(
              "min-w-0 flex-1 truncate font-medium",
              containsSelected ? "text-foreground" : "text-muted-foreground",
              isComplete && !containsSelected && "text-muted-foreground/85",
            )}
          >
            {directory.name}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground/60 tabular-nums transition-colors group-hover/directory:text-muted-foreground/80 group-focus-visible/directory:text-muted-foreground/80">
            {directory.viewedCount}/{directory.fileCount}
          </span>
          <DiffStat
            additions={directory.additions}
            deletions={directory.deletions}
            className="hidden shrink-0 text-[10px] opacity-75 tabular-nums group-hover/directory:inline-flex group-focus-visible/directory:inline-flex"
          />
        </TreeItemLabel>
      </TreeItem>
    );
  }

  const file = node.file;
  const { name } = splitRepoRelativePath(file.path);
  const isSelected = file.path === props.selectedFilePath;
  const isViewed = props.viewedPaths.has(file.path);
  return (
    <div className="relative">
      <TreeItem
        item={props.item}
        onClick={() => props.onSelectFile(file.path)}
        title={file.path}
        aria-label={name}
        aria-current={isSelected ? "true" : undefined}
        className={cn(
          "group/file flex h-7 w-full min-w-0 items-center pe-7 text-left text-[12px]",
          "transition-[background-color,box-shadow,opacity] duration-150 motion-reduce:transition-none",
          isSelected ? "bg-muted/55 shadow-[inset_2px_0_0_var(--primary)]" : "hover:bg-muted/35",
        )}
      >
        <TreeItemLabel
          className={cn(
            "h-7 w-full bg-transparent px-0 py-0 hover:bg-transparent in-data-[selected=true]:bg-transparent",
            isSelected ? "font-medium text-foreground" : "text-muted-foreground",
            isViewed && !isSelected && "text-muted-foreground/85",
          )}
        >
          <FileEntryIcon
            pathValue={file.path}
            kind="file"
            theme={props.resolvedTheme}
            className="size-3.5 shrink-0"
          />
          <span
            className={cn(
              "min-w-0 flex-1 truncate font-medium text-foreground/95",
              isViewed && "line-through decoration-muted-foreground/40",
            )}
          >
            {name}
          </span>
          <DiffStat
            additions={file.insertions}
            deletions={file.deletions}
            className={cn(
              "hidden shrink-0 text-[10px] tabular-nums opacity-70 transition-opacity group-hover/file:opacity-90 xl:inline-flex",
              isViewed && !isSelected && "opacity-35",
            )}
          />
        </TreeItemLabel>
      </TreeItem>
      <div
        className={cn(
          "absolute right-1.5 top-1/2 -translate-y-1/2 opacity-70 transition-opacity group-hover/file:opacity-100 focus-within:opacity-100",
          isViewed && "opacity-100",
        )}
      >
        <ViewedCheckbox viewed={isViewed} onToggle={() => props.onToggleViewed(file.path)} />
      </div>
    </div>
  );
}

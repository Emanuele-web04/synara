import type { ReviewChangedFile } from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { SearchIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

const LARGE_FILE_JUMP_THRESHOLD = 250;
const FILE_JUMP_RESULT_LIMIT = 80;

export function ReviewFileJumpControl(props: {
  files: ReadonlyArray<ReviewChangedFile>;
  selectedFilePath: string | null;
  selectedFileLabel: string;
  density: "page" | "dock";
  onSelectFile: (path: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const largeFileSet = props.files.length > LARGE_FILE_JUMP_THRESHOLD;
  const filteredFiles = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const matches =
      normalizedQuery.length === 0
        ? props.files
        : props.files.filter((file) => file.path.toLowerCase().includes(normalizedQuery));
    return matches.slice(0, FILE_JUMP_RESULT_LIMIT);
  }, [props.files, query]);

  if (!largeFileSet) {
    return (
      <select
        aria-label="Jump to changed file"
        value={props.selectedFilePath ?? ""}
        title={props.selectedFileLabel}
        onChange={(event) => props.onSelectFile(event.currentTarget.value || null)}
        className={cn(
          "min-w-0 flex-1 truncate rounded-lg font-mono text-[11px] outline-none",
          "transition-[background-color,border-color,color,box-shadow] duration-150",
          props.density === "page"
            ? "h-7 border border-border/35 bg-muted/25 px-2.5 text-foreground hover:bg-card/55 focus-visible:border-border/75 focus-visible:ring-2 focus-visible:ring-ring"
            : "min-h-7 max-w-72 border border-border/45 bg-card/30 px-2 py-0.5 text-muted-foreground hover:bg-card/55 hover:text-foreground focus-visible:border-border/80 focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <option value="">All files</option>
        {props.files.map((file) => (
          <option key={file.path} value={file.path}>
            {file.path}
          </option>
        ))}
      </select>
    );
  }

  return (
    <Popover>
      <PopoverTrigger
        aria-label="Jump to changed file"
        title={props.selectedFileLabel}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 rounded-lg font-mono text-[11px] outline-none",
          "transition-[background-color,border-color,color,box-shadow] duration-150",
          props.density === "page"
            ? "h-7 border border-border/35 bg-muted/25 px-2.5 text-foreground hover:bg-card/55 focus-visible:border-border/75 focus-visible:ring-2 focus-visible:ring-ring"
            : "min-h-7 max-w-72 border border-border/45 bg-card/30 px-2 py-0.5 text-muted-foreground hover:bg-card/55 hover:text-foreground focus-visible:border-border/80 focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <span className="min-w-0 flex-1 truncate text-left">{props.selectedFileLabel}</span>
        <SearchIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
      </PopoverTrigger>
      <PopoverPopup align="start" side="bottom" sideOffset={6} className="w-[min(34rem,80vw)] p-2">
        <div className="flex flex-col gap-2">
          <label className="flex h-8 min-w-0 items-center gap-2 rounded-lg border border-border/45 bg-muted/25 px-2">
            <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search changed files..."
              aria-label="Search changed files"
              className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-foreground outline-none placeholder:text-muted-foreground"
            />
          </label>
          <div className="max-h-72 overflow-y-auto" role="listbox" aria-label="Changed files">
            <button
              type="button"
              role="option"
              aria-selected={props.selectedFilePath === null}
              onClick={() => props.onSelectFile(null)}
              className={cn(
                "flex h-7 w-full items-center rounded-md px-2 text-left text-[12px] outline-none transition-colors",
                "hover:bg-muted/45 focus-visible:ring-2 focus-visible:ring-ring",
                props.selectedFilePath === null ? "text-foreground" : "text-muted-foreground",
              )}
            >
              All files
            </button>
            {filteredFiles.map((file) => (
              <button
                key={file.path}
                type="button"
                role="option"
                aria-selected={props.selectedFilePath === file.path}
                onClick={() => props.onSelectFile(file.path)}
                className={cn(
                  "flex h-7 w-full items-center rounded-md px-2 text-left font-mono text-[11px] outline-none transition-colors",
                  "hover:bg-muted/45 focus-visible:ring-2 focus-visible:ring-ring",
                  props.selectedFilePath === file.path
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
              >
                <span className="min-w-0 truncate">{file.path}</span>
              </button>
            ))}
          </div>
          {props.files.length > filteredFiles.length ? (
            <p className="px-1 text-[10px] text-muted-foreground">
              Showing {filteredFiles.length} of {props.files.length} files.
            </p>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

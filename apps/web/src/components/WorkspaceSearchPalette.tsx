// FILE: WorkspaceSearchPalette.tsx
// Purpose: Command-style palette for searching the current project's files by
//          name and by content (grep-style snippet search), styled after the
//          ChatGPT/Codex search overlay (neutral gray surface, soft shadow,
//          segmented mode switch, subtle match emphasis).
// Layer: Web UI components

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { FileIcon, SearchIcon } from "~/lib/icons";
import {
  projectSearchContentQueryOptions,
  projectSearchEntriesQueryOptions,
} from "~/lib/projectReactQuery";
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
} from "./ui/command";
import { isMacPlatform } from "~/lib/utils";

export type WorkspaceSearchPaletteMode = "files" | "snippets";

const SEARCH_DEBOUNCE_MS = 200;
const SNIPPET_MIN_QUERY_LENGTH = 2;
const SEARCH_LIMIT = 50;
const SEARCH_STALE_TIME_MS = 10_000;

const POPUP_CLASS =
  "max-w-2xl -translate-y-[9vh] rounded-2xl border-zinc-200/80 bg-[#fafafa] text-zinc-800 shadow-[0_0_0_1px_rgba(0,0,0,0.03),0_16px_48px_rgba(0,0,0,0.16)] before:bg-transparent dark:border-zinc-700/70 dark:bg-[#212121] dark:text-zinc-200 dark:shadow-[0_0_0_1px_rgba(255,255,255,0.04),0_16px_48px_rgba(0,0,0,0.55)]";

const PANEL_CLASS = "border-zinc-200/80 bg-transparent shadow-none dark:border-zinc-700/70";

interface WorkspaceSearchPaletteProps {
  open: boolean;
  mode: WorkspaceSearchPaletteMode;
  onModeChange: (mode: WorkspaceSearchPaletteMode) => void;
  onOpenChange: (open: boolean) => void;
  cwd: string | null;
  onOpenFile: (relativePath: string) => void;
}

function highlightRange(
  text: string,
  query: string,
): { prefix: string; match: string; suffix: string } | null {
  if (!query) return null;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const index = lowerText.indexOf(lowerQuery);
  if (index === -1) return null;
  return {
    prefix: text.slice(0, index),
    match: text.slice(index, index + lowerQuery.length),
    suffix: text.slice(index + lowerQuery.length),
  };
}

// ChatGPT-style match emphasis: no colored mark, just a subtle weight bump.
function HighlightedText(props: { text: string; query: string; muted?: boolean }) {
  const range = highlightRange(props.text, props.query);
  if (!range) {
    return <>{props.text}</>;
  }
  const matchClass = props.muted
    ? "font-medium text-zinc-700 dark:text-zinc-200"
    : "font-semibold text-zinc-950 dark:text-white";
  return (
    <>
      {range.prefix}
      <span className={matchClass}>{range.match}</span>
      {range.suffix}
    </>
  );
}

function modeButtonClass(active: boolean): string {
  return active
    ? "rounded-md bg-white px-2.5 py-1 text-xs font-medium text-zinc-900 shadow-sm dark:bg-zinc-600/90 dark:text-zinc-50"
    : "rounded-md px-2.5 py-1 text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100";
}

function EmptyState(props: { message: string }) {
  return (
    <CommandEmpty className="py-12">
      <div className="flex flex-col items-center justify-center gap-2.5 text-center text-sm text-zinc-500 dark:text-zinc-400">
        <SearchIcon className="size-4 opacity-60" />
        <div>{props.message}</div>
      </div>
    </CommandEmpty>
  );
}

export function WorkspaceSearchPalette(props: WorkspaceSearchPaletteProps) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    if (!props.open) {
      const timeoutId = window.setTimeout(() => {
        setQuery("");
        setDebouncedQuery("");
      }, 0);
      return () => window.clearTimeout(timeoutId);
    }
    return undefined;
  }, [props.open]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [query]);

  const isMac = isMacPlatform(navigator.platform);
  const modLabel = isMac ? "⌘" : "Ctrl";
  const trimmedQuery = query.trim();
  const hasUsableQuery =
    props.mode === "files"
      ? trimmedQuery.length > 0
      : trimmedQuery.length >= SNIPPET_MIN_QUERY_LENGTH;

  const fileSearchQuery = useQuery(
    projectSearchEntriesQueryOptions({
      cwd: props.cwd,
      query: debouncedQuery,
      kind: "file",
      limit: SEARCH_LIMIT,
      enabled: props.open && props.mode === "files" && debouncedQuery.length > 0,
      staleTime: SEARCH_STALE_TIME_MS,
    }),
  );

  const snippetSearchQuery = useQuery(
    projectSearchContentQueryOptions({
      cwd: props.cwd,
      query: debouncedQuery,
      limit: SEARCH_LIMIT,
      enabled:
        props.open &&
        props.mode === "snippets" &&
        debouncedQuery.length >= SNIPPET_MIN_QUERY_LENGTH,
      staleTime: SEARCH_STALE_TIME_MS,
    }),
  );

  const fileEntries =
    props.mode === "files" && hasUsableQuery ? (fileSearchQuery.data?.entries ?? []) : [];
  const snippetMatches =
    props.mode === "snippets" && hasUsableQuery ? (snippetSearchQuery.data?.matches ?? []) : [];

  const isFetching =
    props.mode === "files" ? fileSearchQuery.isFetching : snippetSearchQuery.isFetching;

  const handleOpenFile = (relativePath: string) => {
    props.onOpenChange(false);
    props.onOpenFile(relativePath);
  };

  const placeholder =
    props.mode === "files" ? "Search files by name" : "Search code and file contents";

  const promptState =
    props.mode === "files"
      ? "Type a file name to search the project."
      : `Type at least ${SNIPPET_MIN_QUERY_LENGTH} characters to search file contents.`;

  return (
    <CommandDialog open={props.open} onOpenChange={props.onOpenChange}>
      <CommandDialogPopup className={POPUP_CLASS}>
        <Command mode="none">
          <CommandPanel className={PANEL_CLASS}>
            <div className="flex flex-col gap-2 border-b border-zinc-200/70 px-3 pt-2 pb-2.5 dark:border-zinc-700/60">
              <CommandInput
                placeholder={placeholder}
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                startAddon={<SearchIcon className="size-4 text-zinc-400 dark:text-zinc-500" />}
                className="px-3 py-2 text-[15px] placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
              />
              <div className="flex items-center gap-2 px-2">
                <div
                  className="inline-flex items-center gap-0.5 rounded-lg bg-zinc-200/70 p-0.5 dark:bg-zinc-800"
                  role="tablist"
                  aria-label="Search mode"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={props.mode === "files"}
                    className={modeButtonClass(props.mode === "files")}
                    onClick={() => props.onModeChange("files")}
                  >
                    Files
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={props.mode === "snippets"}
                    className={modeButtonClass(props.mode === "snippets")}
                    onClick={() => props.onModeChange("snippets")}
                  >
                    Snippets
                  </button>
                </div>
                {props.cwd ? (
                  <span className="min-w-0 flex-1 truncate text-end text-[11px] text-zinc-400 dark:text-zinc-500">
                    {props.cwd}
                  </span>
                ) : null}
              </div>
            </div>

            <CommandList className="max-h-[min(22rem,55vh)] not-empty:px-1.5 not-empty:pt-1.5 not-empty:pb-1.5">
              {!hasUsableQuery ? (
                <EmptyState message={promptState} />
              ) : props.mode === "files" ? (
                fileEntries.length > 0 ? (
                  <CommandGroup>
                    <CommandGroupLabel className="pt-0 pb-1.5 pl-3 text-zinc-400 dark:text-zinc-500">
                      Files
                    </CommandGroupLabel>
                    {fileEntries.map((entry) => (
                      <CommandItem
                        key={entry.path}
                        value={`file:${entry.path}`}
                        className="cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-zinc-800 data-highlighted:bg-zinc-200/60 data-highlighted:text-zinc-900 dark:text-zinc-200 dark:data-highlighted:bg-zinc-700/40 dark:data-highlighted:text-zinc-100"
                        onMouseDown={(event) => {
                          event.preventDefault();
                        }}
                        onClick={() => handleOpenFile(entry.path)}
                      >
                        <FileIcon className="size-4 shrink-0 text-zinc-400 dark:text-zinc-500" />
                        <span className="min-w-0 flex-1 truncate text-sm">
                          <HighlightedText text={entry.path} query={debouncedQuery} />
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : !isFetching ? (
                  <EmptyState message="No matching files." />
                ) : null
              ) : snippetMatches.length > 0 ? (
                <CommandGroup>
                  <CommandGroupLabel className="pt-0 pb-1.5 pl-3 text-zinc-400 dark:text-zinc-500">
                    Matches
                  </CommandGroupLabel>
                  {snippetMatches.map((match) => (
                    <CommandItem
                      key={`${match.path}:${match.lineNumber}`}
                      value={`snippet:${match.path}:${match.lineNumber}`}
                      className="cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2 text-zinc-800 data-highlighted:bg-zinc-200/60 data-highlighted:text-zinc-900 dark:text-zinc-200 dark:data-highlighted:bg-zinc-700/40 dark:data-highlighted:text-zinc-100"
                      onMouseDown={(event) => {
                        event.preventDefault();
                      }}
                      onClick={() => handleOpenFile(match.path)}
                    >
                      <FileIcon className="mt-0.5 size-4 shrink-0 text-zinc-400 dark:text-zinc-500" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm">
                            <HighlightedText text={match.path} query={debouncedQuery} />
                          </span>
                          <span className="shrink-0 text-[10px] text-zinc-400 dark:text-zinc-500">
                            :{match.lineNumber}
                          </span>
                        </div>
                        <div className="mt-0.5 truncate font-mono text-[11px] leading-5 text-zinc-500 dark:text-zinc-400">
                          <HighlightedText text={match.lineText} query={debouncedQuery} muted />
                        </div>
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : !isFetching ? (
                <EmptyState message="No snippet matches." />
              ) : null}
            </CommandList>
            <CommandFooter className="border-zinc-200/70 px-4 py-2.5 text-[11px] text-zinc-400 dark:border-zinc-700/60 dark:text-zinc-500">
              <span>
                {props.mode === "files"
                  ? "Search files in the current project."
                  : "Search keywords inside project files."}
              </span>
              <span className="flex items-center gap-1.5">
                <kbd className="rounded border border-zinc-200 bg-zinc-100 px-1 py-0.5 font-sans text-[10px] text-zinc-500 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                  {modLabel}+P
                </kbd>
                <span>files</span>
                <kbd className="rounded border border-zinc-200 bg-zinc-100 px-1 py-0.5 font-sans text-[10px] text-zinc-500 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                  {modLabel}+Shift+F
                </kbd>
                <span>snippets</span>
                <kbd className="rounded border border-zinc-200 bg-zinc-100 px-1 py-0.5 font-sans text-[10px] text-zinc-500 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                  Enter
                </kbd>
                <span>open</span>
              </span>
            </CommandFooter>
          </CommandPanel>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}

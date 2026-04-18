/**
 * SidebarSearchPalette - Command-style palette for sidebar actions, threads, and projects.
 *
 * Keeps the sidebar search UX aligned with the shared command primitives so
 * keyboard navigation and shortcut labels behave like the rest of the app.
 */
import { SearchIcon, SettingsIcon, SquarePenIcon } from "~/lib/icons";
import { type ProviderKind } from "@t3tools/contracts";
import { BsChat } from "react-icons/bs";
import { HiOutlineFolderOpen } from "react-icons/hi2";
import { LuArrowDownToLine, LuArrowLeft } from "react-icons/lu";
import { type ComponentType, useEffect, useMemo, useState } from "react";
import { FolderClosed } from "./FolderClosed";
import { ClaudeAI, Gemini, OpenAI } from "./Icons";
import { formatRelativeTime } from "./Sidebar";

import {
  type SidebarSearchAction,
  type SidebarSearchProject,
  type SidebarSearchThread,
  hasSidebarSearchResults,
  matchSidebarSearchActions,
  matchSidebarSearchProjects,
  matchSidebarSearchThreads,
} from "./SidebarSearchPalette.logic";
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
  CommandSeparator,
} from "./ui/command";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ShortcutKbd } from "./ui/shortcut-kbd";

interface SidebarSearchPaletteProps {
  open: boolean;
  mode: "search" | "import";
  onModeChange: (mode: "search" | "import") => void;
  onOpenChange: (open: boolean) => void;
  actions: readonly SidebarSearchAction[];
  projects: readonly SidebarSearchProject[];
  threads: readonly SidebarSearchThread[];
  onCreateChat: () => void;
  onCreateThread: () => void;
  onAddProject: () => void;
  onOpenSettings: () => void;
  onOpenProject: (projectId: string) => void;
  onOpenThread: (threadId: string) => void;
  onImportThread: (provider: "codex" | "claudeAgent", externalId: string) => Promise<void>;
}

type ImportProviderKind = "codex" | "claudeAgent";

function actionHandler(
  actionId: string,
  props: Omit<
    SidebarSearchPaletteProps,
    "open" | "onOpenChange" | "actions" | "projects" | "threads"
  >,
): (() => void) | null {
  switch (actionId) {
    case "new-chat":
      return props.onCreateChat;
    case "new-thread":
      return props.onCreateThread;
    case "add-project":
      return props.onAddProject;
    case "settings":
      return props.onOpenSettings;
    default:
      return null;
  }
}

type IconComponent = ComponentType<{ className?: string }>;

const ACTION_ICONS: Record<string, IconComponent> = {
  "new-chat": BsChat,
  "new-thread": SquarePenIcon,
  "add-project": FolderClosed,
  "import-thread": LuArrowDownToLine,
  settings: SettingsIcon,
};

function PaletteIcon(props: { icon: IconComponent }) {
  const Icon = props.icon;
  return (
    <div className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
      <Icon className="size-[15px]" />
    </div>
  );
}

function ProviderIcon(props: { provider: "codex" | "claudeAgent" | "gemini" }) {
  return (
    <div className="flex size-5 shrink-0 items-center justify-center">
      {props.provider === "claudeAgent" ? (
        <ClaudeAI aria-hidden="true" className="size-[15px] text-foreground" />
      ) : props.provider === "gemini" ? (
        <Gemini aria-hidden="true" className="size-[15px] text-foreground" />
      ) : (
        <OpenAI aria-hidden="true" className="size-[15px] text-muted-foreground/60" />
      )}
    </div>
  );
}

function threadMatchLabel(input: {
  matchKind: "message" | "project" | "title";
  messageMatchCount: number;
}): string | null {
  if (input.matchKind === "message") {
    return input.messageMatchCount > 1 ? `${input.messageMatchCount} chat hits` : "Chat match";
  }
  if (input.matchKind === "project") {
    return "Project match";
  }
  return null;
}

function tokenizeHighlightQuery(query: string): string[] {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .filter((token, index, allTokens) => allTokens.indexOf(token) === index);
  return tokens.toSorted((left, right) => right.length - left.length);
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function HighlightedText(props: { text: string; query: string; className?: string }) {
  const segments = useMemo(() => {
    const tokens = tokenizeHighlightQuery(props.query);
    if (tokens.length === 0) {
      return [{ key: "full", text: props.text, highlighted: false }];
    }

    const pattern = new RegExp(`(${tokens.map(escapeRegExp).join("|")})`, "gi");
    const parts = props.text.split(pattern).filter((part) => part.length > 0);
    let offset = 0;
    return parts.map((part) => {
      const segment = {
        key: `${offset}-${part.length}`,
        text: part,
        highlighted: tokens.some((token) => token === part.toLowerCase()),
      };
      offset += part.length;
      return segment;
    });
  }, [props.query, props.text]);

  return (
    <span className={props.className}>
      {segments.map((segment) =>
        segment.highlighted ? (
          <mark
            key={segment.key}
            className="rounded-[3px] bg-amber-200/80 px-[1px] text-current dark:bg-amber-300/25"
          >
            {segment.text}
          </mark>
        ) : (
          <span key={segment.key}>{segment.text}</span>
        ),
      )}
    </span>
  );
}

export function SidebarSearchPalette(props: SidebarSearchPaletteProps) {
  const [query, setQuery] = useState("");
  const [importProvider, setImportProvider] = useState<ImportProviderKind>("codex");
  const [importId, setImportId] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);

  useEffect(() => {
    if (!props.open) {
      setQuery("");
      setImportProvider("codex");
      setImportId("");
      setImportError(null);
      setIsImporting(false);
    }
  }, [props.open]);

  const matchedActions = useMemo(
    () => matchSidebarSearchActions(props.actions, query),
    [props.actions, query],
  );
  const matchedProjects = useMemo(
    () => matchSidebarSearchProjects(props.projects, query),
    [props.projects, query],
  );
  const matchedThreads = useMemo(
    () => matchSidebarSearchThreads(props.threads, query),
    [props.threads, query],
  );
  const hasResults = hasSidebarSearchResults({
    actions: matchedActions,
    projects: matchedProjects,
    threads: matchedThreads,
  });
  const importFieldLabel = importProvider === "claudeAgent" ? "Session ID" : "Thread ID";
  const importPlaceholder =
    importProvider === "claudeAgent" ? "Paste a Claude session id" : "Paste a Codex thread id";

  const submitImport = async () => {
    const normalizedImportId = importId.trim();
    if (!normalizedImportId || isImporting) {
      return;
    }
    setImportError(null);
    setIsImporting(true);
    try {
      await props.onImportThread(importProvider, normalizedImportId);
      props.onOpenChange(false);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Failed to import thread.");
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <CommandDialog open={props.open} onOpenChange={props.onOpenChange}>
      <CommandDialogPopup className="max-w-2xl">
        {props.mode === "import" ? (
          <div className="flex flex-col overflow-hidden">
            <div className="border-b border-border/70 px-4 py-3">
              <div className="flex items-start gap-3">
                <Button
                  size="icon"
                  variant="ghost"
                  className="-ml-1 mt-[-2px] size-8 shrink-0"
                  onClick={() => {
                    setImportError(null);
                    props.onModeChange("search");
                  }}
                >
                  <LuArrowLeft className="size-4" />
                </Button>
                <div>
                  <p className="text-sm font-medium text-foreground">Import thread from provider</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Create a local app thread and resume it from an existing provider id.
                  </p>
                </div>
              </div>
            </div>
            <div className="space-y-4 px-4 py-4">
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  Provider
                </p>
                <div className="flex gap-2">
                  <Button
                    className={
                      importProvider === "codex"
                        ? "flex-1 justify-start border-border bg-muted text-foreground hover:bg-muted/80"
                        : "flex-1 justify-start"
                    }
                    variant="outline"
                    onClick={() => setImportProvider("codex")}
                  >
                    <ProviderIcon provider="codex" />
                    Codex
                  </Button>
                  <Button
                    className={
                      importProvider === "claudeAgent"
                        ? "flex-1 justify-start border-border bg-muted text-foreground hover:bg-muted/80"
                        : "flex-1 justify-start"
                    }
                    variant="outline"
                    onClick={() => setImportProvider("claudeAgent")}
                  >
                    <ProviderIcon provider="claudeAgent" />
                    Claude
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  {importFieldLabel}
                </p>
                <Input
                  autoFocus
                  nativeInput
                  placeholder={importPlaceholder}
                  value={importId}
                  onChange={(event) => setImportId(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void submitImport();
                    }
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {importProvider === "claudeAgent"
                    ? "Claude resumes a persisted session by session id."
                    : "Codex resumes a persisted thread by thread id."}
                </p>
              </div>
              {importError ? (
                <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  {importError}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setImportError(null);
                    props.onOpenChange(false);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  disabled={importId.trim().length === 0 || isImporting}
                  onClick={submitImport}
                >
                  {isImporting ? "Importing..." : "Import"}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Let the first ArrowDown land on the first visible result instead of pre-highlighting it. */}
            <Command autoHighlight={false} mode="none">
              <CommandPanel className="overflow-hidden">
                <CommandInput
                  placeholder="Search projects, threads, and actions"
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  startAddon={<SearchIcon className="text-muted-foreground" />}
                />
                <CommandList className="max-h-[min(24rem,60vh)] not-empty:px-1.5 not-empty:pt-0 not-empty:pb-1.5">
                  {matchedActions.length > 0 ? (
                    <CommandGroup>
                      <CommandGroupLabel className="pt-0 pb-1.5 pl-3">Suggested</CommandGroupLabel>
                      {matchedActions.map((action) => {
                        const onSelect = actionHandler(action.id, props);
                        const Icon = ACTION_ICONS[action.id];
                        return (
                          <CommandItem
                            key={action.id}
                            value={`action:${action.id}`}
                            className="cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5"
                            onMouseDown={(event) => {
                              event.preventDefault();
                            }}
                            onClick={() => {
                              if (action.id === "import-thread") {
                                setImportError(null);
                                setImportId("");
                                setImportProvider("codex");
                                props.onModeChange("import");
                                return;
                              }
                              if (!onSelect) return;
                              props.onOpenChange(false);
                              onSelect();
                            }}
                          >
                            {Icon ? <PaletteIcon icon={Icon} /> : null}
                            <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                              {action.label}
                            </span>
                            {action.shortcutLabel ? (
                              <ShortcutKbd
                                shortcutLabel={action.shortcutLabel}
                                groupClassName="shrink-0"
                              />
                            ) : null}
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  ) : null}

                  {matchedActions.length > 0 &&
                  (matchedThreads.length > 0 || matchedProjects.length > 0) ? (
                    <CommandSeparator />
                  ) : null}

                  {matchedThreads.length > 0 ? (
                    <CommandGroup>
                      <CommandGroupLabel className="py-1.5 pl-3">
                        {query ? "Threads" : "Recent"}
                      </CommandGroupLabel>
                      {matchedThreads.map(
                        ({ id, matchKind, messageMatchCount, snippet, thread }) => (
                          <CommandItem
                            key={id}
                            value={id}
                            className="cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2"
                            onMouseDown={(event) => {
                              event.preventDefault();
                            }}
                            onClick={() => {
                              props.onOpenChange(false);
                              props.onOpenThread(thread.id);
                            }}
                          >
                            <ProviderIcon provider={thread.provider} />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-baseline gap-3">
                                <div className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui,12px)] text-foreground">
                                  <HighlightedText
                                    text={thread.title || "Untitled thread"}
                                    query={query}
                                  />
                                </div>
                                <span className="w-24 shrink-0 truncate text-right text-[length:var(--app-font-size-ui-meta,10px)] text-muted-foreground/72">
                                  {thread.projectName}
                                </span>
                                {thread.updatedAt || thread.createdAt ? (
                                  <span className="w-10 shrink-0 text-right text-[length:var(--app-font-size-ui-timestamp,10px)] text-muted-foreground/72">
                                    {formatRelativeTime(thread.updatedAt ?? thread.createdAt)}
                                  </span>
                                ) : (
                                  <span className="w-10 shrink-0" />
                                )}
                              </div>
                              {snippet ? (
                                <div className="mt-0.5 flex items-start gap-3">
                                  <div className="min-w-0 flex-1 line-clamp-1 text-[length:var(--app-font-size-ui-meta,10px)] leading-5 text-muted-foreground/78">
                                    <HighlightedText text={snippet} query={query} />
                                  </div>
                                  <div className="flex w-[8.5rem] shrink-0 justify-end">
                                    {threadMatchLabel({ matchKind, messageMatchCount }) ? (
                                      <span className="truncate text-[length:var(--app-font-size-ui-meta,10px)] text-muted-foreground/58">
                                        {threadMatchLabel({ matchKind, messageMatchCount })}
                                      </span>
                                    ) : null}
                                  </div>
                                </div>
                              ) : threadMatchLabel({ matchKind, messageMatchCount }) ? (
                                <div className="mt-0.5 text-[length:var(--app-font-size-ui-meta,10px)] text-muted-foreground/58">
                                  {threadMatchLabel({ matchKind, messageMatchCount })}
                                </div>
                              ) : null}
                            </div>
                          </CommandItem>
                        ),
                      )}
                    </CommandGroup>
                  ) : null}

                  {matchedThreads.length > 0 && matchedProjects.length > 0 ? (
                    <CommandSeparator />
                  ) : null}

                  {matchedProjects.length > 0 ? (
                    <CommandGroup>
                      <CommandGroupLabel className="py-1.5 pl-3">Projects</CommandGroupLabel>
                      {matchedProjects.map(({ id, project }) => (
                        <CommandItem
                          key={id}
                          value={id}
                          className="cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5"
                          onMouseDown={(event) => {
                            event.preventDefault();
                          }}
                          onClick={() => {
                            props.onOpenChange(false);
                            props.onOpenProject(project.id);
                          }}
                        >
                          <PaletteIcon icon={HiOutlineFolderOpen} />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[length:var(--app-font-size-ui,12px)] text-foreground">
                              {project.name || "Untitled project"}
                            </div>
                            <div className="truncate text-[length:var(--app-font-size-ui-meta,10px)] text-muted-foreground/72">
                              {project.localName
                                ? `${project.folderName} · ${project.cwd}`
                                : project.cwd}
                            </div>
                          </div>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  ) : null}

                  {!hasResults ? (
                    <CommandEmpty className="py-10">
                      <div className="flex flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground/72">
                        <SearchIcon className="size-4 opacity-70" />
                        <div>No matches.</div>
                      </div>
                    </CommandEmpty>
                  ) : null}
                </CommandList>
                <div className="h-1.5" />
              </CommandPanel>
              <CommandFooter>
                <span>Jump to threads, projects, and sidebar actions.</span>
                <span>Enter to open</span>
              </CommandFooter>
            </Command>
          </>
        )}
      </CommandDialogPopup>
    </CommandDialog>
  );
}

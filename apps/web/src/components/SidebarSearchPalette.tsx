/**
 * SidebarSearchPalette - Command-style palette for sidebar actions, threads, and projects.
 *
 * Keeps the sidebar search UX aligned with the shared command primitives so
 * keyboard navigation and shortcut labels behave like the rest of the app.
 */
import { SearchIcon, SettingsIcon, SquarePenIcon } from "~/lib/icons";
import { HiOutlineFolderOpen } from "react-icons/hi2";
import { type ComponentType, useEffect, useMemo, useState } from "react";
import { ClaudeAI, OpenAI } from "./Icons";
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
import { ShortcutKbd } from "./ui/shortcut-kbd";

interface SidebarSearchPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: readonly SidebarSearchAction[];
  projects: readonly SidebarSearchProject[];
  threads: readonly SidebarSearchThread[];
  onCreateThread: () => void;
  onAddProject: () => void;
  onOpenSettings: () => void;
  onOpenProject: (projectId: string) => void;
  onOpenThread: (threadId: string) => void;
}

function actionHandler(
  actionId: string,
  props: Omit<
    SidebarSearchPaletteProps,
    "open" | "onOpenChange" | "actions" | "projects" | "threads"
  >,
): (() => void) | null {
  switch (actionId) {
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
  "new-thread": SquarePenIcon,
  "add-project": HiOutlineFolderOpen,
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

function ProviderIcon(props: { provider: "codex" | "claudeAgent" }) {
  return (
    <div className="flex size-5 shrink-0 items-center justify-center">
      {props.provider === "claudeAgent" ? (
        <ClaudeAI aria-hidden="true" className="size-[15px] text-foreground" />
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
      return [{ text: props.text, highlighted: false }];
    }

    const pattern = new RegExp(`(${tokens.map(escapeRegExp).join("|")})`, "gi");
    const parts = props.text.split(pattern).filter((part) => part.length > 0);
    return parts.map((part) => ({
      text: part,
      highlighted: tokens.some((token) => token === part.toLowerCase()),
    }));
  }, [props.query, props.text]);

  return (
    <span className={props.className}>
      {segments.map((segment, index) =>
        segment.highlighted ? (
          <mark
            key={`${segment.text}-${index}`}
            className="rounded-[3px] bg-amber-200/80 px-[1px] text-current dark:bg-amber-300/25"
          >
            {segment.text}
          </mark>
        ) : (
          <span key={`${segment.text}-${index}`}>{segment.text}</span>
        ),
      )}
    </span>
  );
}

export function SidebarSearchPalette(props: SidebarSearchPaletteProps) {
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!props.open) {
      setQuery("");
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

  return (
    <CommandDialog open={props.open} onOpenChange={props.onOpenChange}>
      <CommandDialogPopup className="max-w-2xl">
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
                    if (!onSelect) return null;
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
                  {matchedThreads.map(({ id, matchKind, messageMatchCount, snippet, thread }) => (
                    <CommandItem
                      key={id}
                      value={id}
                      className="cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2"
                      onMouseDown={(event) => {
                        event.preventDefault();
                      }}
                      onClick={() => {
                        props.onOpenChange(false);
                        props.onOpenThread(thread.id);
                      }}
                    >
                      <div className="pt-0.5">
                        <ProviderIcon provider={thread.provider} />
                      </div>
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
                  ))}
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
      </CommandDialogPopup>
    </CommandDialog>
  );
}

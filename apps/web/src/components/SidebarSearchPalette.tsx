/**
 * SidebarSearchPalette - Command-style palette for sidebar actions, threads, and projects.
 *
 * Keeps the sidebar search UX aligned with the shared command primitives so
 * keyboard navigation and shortcut labels behave like the rest of the app.
 */
import {
  type LucideIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
} from "~/lib/icons";
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
  onOpenPlugins: () => void;
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
        <ClaudeAI aria-hidden="true" className="size-[15px] text-[#d97757]" />
      ) : (
        <OpenAI aria-hidden="true" className="size-[15px] text-muted-foreground/60" />
      )}
    </div>
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
        <Command mode="none">
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
                  <CommandGroupLabel className="py-1.5 pl-3">{query ? "Threads" : "Recent"}</CommandGroupLabel>
                  {matchedThreads.map(({ id, thread }) => (
                    <CommandItem
                      key={id}
                      value={id}
                      className="cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5"
                      onMouseDown={(event) => {
                        event.preventDefault();
                      }}
                      onClick={() => {
                        props.onOpenChange(false);
                        props.onOpenThread(thread.id);
                      }}
                    >
                      <ProviderIcon provider={thread.provider} />
                      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                        {thread.title || "Untitled thread"}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground/72">
                        {thread.projectName}
                      </span>
                      {thread.updatedAt || thread.createdAt ? (
                        <span className="w-8 shrink-0 text-right text-xs text-muted-foreground/72">
                          {formatRelativeTime(thread.updatedAt ?? thread.createdAt)}
                        </span>
                      ) : null}
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
                        <div className="truncate text-sm text-foreground">
                          {project.name || "Untitled project"}
                        </div>
                        <div className="truncate text-xs text-muted-foreground/72">
                          {project.cwd}
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

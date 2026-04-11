import {
  type ProjectEntry,
  type ModelSlug,
  type ProviderNativeCommandDescriptor,
  type ProviderMentionReference,
  type ProviderKind,
  type ProviderPluginDescriptor,
  type ProviderSkillDescriptor,
} from "@t3tools/contracts";
import { memo, useEffect, useMemo, useRef } from "react";
import { type ComposerTriggerKind } from "../../composer-logic";
import { type ComposerSlashCommand } from "../../composerSlashCommands";
import { ListTodoIcon, PlugIcon } from "~/lib/icons";
import {
  TbEraser,
  TbBrain,
  TbBolt,
  TbDeviceLaptop,
  TbMessage,
  TbBug,
  TbChartBar,
  TbUsers,
  TbGitFork,
  TbGitCompare,
  TbTerminal2,
} from "react-icons/tb";
import { formatSkillScope } from "~/lib/providerDiscovery";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import {
  Command,
  CommandGroup,
  CommandGroupLabel,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "../ui/command";
import { VscodeEntryIcon } from "./VscodeEntryIcon";

function humanizeProviderCommandName(command: string): string {
  return command
    .split(/[-_]/g)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function commandMenuTitle(
  item: Extract<ComposerCommandItem, { type: "slash-command" | "provider-native-command" }>,
): string {
  switch (item.command) {
    case "clear":
      return "Clear";
    case "model":
      return "Model";
    case "fast":
      return "Fast Mode";
    case "plan":
      return "Plan Mode";
    case "default":
      return "Default Mode";
    case "review":
      return "Code Review";
    case "fork":
      return "Fork";
    case "status":
      return "Status";
    case "subagents":
      return "Subagents";
    default:
      return humanizeProviderCommandName(item.command);
  }
}

export type ComposerCommandItem =
  | {
      id: string;
      type: "path";
      path: string;
      pathKind: ProjectEntry["kind"];
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "slash-command";
      command: ComposerSlashCommand;
      label: string;
      description: string;
      source: "app" | "shared";
    }
  | {
      id: string;
      type: "provider-native-command";
      provider: ProviderKind;
      command: ProviderNativeCommandDescriptor["name"];
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "fork-target";
      target: "local" | "worktree";
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "review-target";
      target: "changes" | "base-branch";
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "model";
      provider: ProviderKind;
      model: ModelSlug;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "plugin";
      plugin: ProviderPluginDescriptor;
      mention: ProviderMentionReference;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "skill";
      skill: ProviderSkillDescriptor;
      label: string;
      description: string;
    };

type ComposerCommandGroupModel = {
  id: string;
  label: string | null;
  items: ComposerCommandItem[];
};

function groupCommandItems(
  items: ComposerCommandItem[],
  triggerKind: ComposerTriggerKind | null,
  groupSlashCommandSections: boolean,
): ComposerCommandGroupModel[] {
  if (triggerKind !== "slash-command" || !groupSlashCommandSections) {
    return [{ id: "default", label: null, items }];
  }

  const builtInItems = items.filter((item) => item.type === "slash-command");
  const providerItems = items.filter((item) => item.type === "provider-native-command");
  const otherItems = items.filter(
    (item) => item.type !== "slash-command" && item.type !== "provider-native-command",
  );

  const groups: ComposerCommandGroupModel[] = [];
  if (builtInItems.length > 0) {
    groups.push({ id: "built-in", label: "Built-in", items: builtInItems });
  }
  if (providerItems.length > 0) {
    groups.push({ id: "provider", label: "Provider", items: providerItems });
  }
  if (otherItems.length > 0) {
    groups.push({ id: "other", label: null, items: otherItems });
  }
  return groups;
}

export const ComposerCommandMenu = memo(function ComposerCommandMenu(props: {
  items: ComposerCommandItem[];
  resolvedTheme: "light" | "dark";
  isLoading: boolean;
  triggerKind: ComposerTriggerKind | null;
  groupSlashCommandSections?: boolean;
  emptyStateText?: string;
  activeItemId: string | null;
  onHighlightedItemChange: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const itemRefs = useRef<Record<string, HTMLElement | null>>({});
  const groups = useMemo(
    () =>
      groupCommandItems(props.items, props.triggerKind, props.groupSlashCommandSections ?? true),
    [props.groupSlashCommandSections, props.items, props.triggerKind],
  );

  useEffect(() => {
    if (!props.activeItemId) {
      return;
    }

    itemRefs.current[props.activeItemId]?.scrollIntoView({
      block: "nearest",
    });
  }, [props.activeItemId]);

  return (
    <Command
      autoHighlight={false}
      mode="none"
      onItemHighlighted={(highlightedValue) => {
        props.onHighlightedItemChange(
          typeof highlightedValue === "string" ? highlightedValue : null,
        );
      }}
    >
      <div className="relative overflow-hidden rounded-xl border border-border/60 bg-card shadow-[0_0_0_1px_rgba(255,255,255,0.04)_inset]">
        <CommandList className="max-h-72 py-1">
          {groups.map((group, groupIndex) => (
            <div key={group.id}>
              {groupIndex > 0 ? <CommandSeparator className="my-0.5" /> : null}
              <CommandGroup>
                {group.label ? (
                  <CommandGroupLabel className="px-2.5 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/55">
                    {group.label}
                  </CommandGroupLabel>
                ) : null}
                {group.items.map((item) => (
                  <ComposerCommandMenuItem
                    key={item.id}
                    item={item}
                    resolvedTheme={props.resolvedTheme}
                    isActive={props.activeItemId === item.id}
                    itemRef={(node) => {
                      itemRefs.current[item.id] = node;
                    }}
                    onHighlight={props.onHighlightedItemChange}
                    onSelect={props.onSelect}
                  />
                ))}
              </CommandGroup>
            </div>
          ))}
        </CommandList>
        {props.items.length === 0 && (
          <p className="px-2.5 py-1.5 text-muted-foreground/50 text-[11px]">
            {props.isLoading
              ? props.triggerKind === "mention"
                ? "Searching workspace files..."
                : "Loading commands..."
              : (props.emptyStateText ??
                (props.triggerKind === "mention"
                  ? "No matching plugin or file."
                  : props.triggerKind === "skill"
                    ? "No matching skill."
                    : "No matching command."))}
          </p>
        )}
      </div>
    </Command>
  );
});

const ComposerCommandMenuItem = memo(function ComposerCommandMenuItem(props: {
  item: ComposerCommandItem;
  resolvedTheme: "light" | "dark";
  isActive: boolean;
  itemRef: (node: HTMLElement | null) => void;
  onHighlight: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  if (props.item.type === "plugin" || props.item.type === "skill") {
    return (
      <CommandItem
        ref={props.itemRef}
        value={props.item.id}
        className={cn(
          "cursor-pointer rounded-lg px-2.5 py-1 transition-colors hover:bg-accent/40 data-highlighted:bg-accent/40 data-highlighted:text-accent-foreground",
          props.isActive && "bg-accent/40 text-accent-foreground",
        )}
        onMouseMove={() => {
          if (!props.isActive) props.onHighlight(props.item.id);
        }}
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        onClick={() => {
          props.onSelect(props.item);
        }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <div
            className={cn(
              "flex size-3.5 shrink-0 items-center justify-center text-muted-foreground/50",
              props.isActive && "text-foreground/60",
            )}
          >
            <PlugIcon className="size-3" />
          </div>
          <div className="min-w-0 flex flex-1 items-center gap-1.5">
            <span className="truncate font-semibold text-[11px] leading-none text-foreground/80">
              {props.item.label}
            </span>
            <span className="min-w-0 flex-1 truncate text-[10.5px] leading-none text-muted-foreground/45">
              {props.item.description}
            </span>
          </div>
          <div className="shrink-0 pl-2 text-[10px] leading-none text-muted-foreground/35">
            {props.item.type === "skill" ? formatSkillScope(props.item.skill.scope) : "Plugin"}
          </div>
        </div>
      </CommandItem>
    );
  }

  return (
    <CommandItem
      ref={props.itemRef}
      value={props.item.id}
      className={cn(
        "cursor-pointer select-none gap-2 rounded-lg px-2.5 py-1 transition-colors hover:bg-accent/40 data-highlighted:bg-accent/40 data-highlighted:text-accent-foreground",
        props.isActive && "bg-accent/40 text-accent-foreground",
      )}
      onMouseMove={() => {
        if (!props.isActive) props.onHighlight(props.item.id);
      }}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onSelect(props.item);
      }}
    >
      {props.item.type === "path" ? (
        <VscodeEntryIcon
          pathValue={props.item.path}
          kind={props.item.pathKind}
          theme={props.resolvedTheme}
        />
      ) : null}
      {props.item.type === "fork-target" ? (
        props.item.target === "local" ? (
          <TbDeviceLaptop className="size-3.5 text-muted-foreground/60" />
        ) : (
          <TbGitFork className="size-3.5 text-muted-foreground/60" />
        )
      ) : null}
      {props.item.type === "review-target" ? (
        props.item.target === "changes" ? (
          <TbBug className="size-3.5 text-muted-foreground/60" />
        ) : (
          <TbGitCompare className="size-3.5 text-muted-foreground/60" />
        )
      ) : null}
      {props.item.type === "slash-command" || props.item.type === "provider-native-command"
        ? (() => {
            const cls = "size-3.5 text-muted-foreground/60";
            switch (props.item.command) {
              case "clear":
                return <TbEraser className={cls} />;
              case "model":
                return <TbBrain className={cls} />;
              case "fast":
                return <TbBolt className={cls} />;
              case "plan":
                return <ListTodoIcon className={cls} />;
              case "default":
                return <TbMessage className={cls} />;
              case "review":
                return <TbBug className={cls} />;
              case "status":
                return <TbChartBar className={cls} />;
              case "subagents":
                return <TbUsers className={cls} />;
              case "fork":
                return <TbGitFork className={cls} />;
              default:
                return <TbTerminal2 className={cls} />;
            }
          })()
        : null}
      {props.item.type === "model" ? (
        <Badge variant="outline" className="px-1 py-0 text-[9px]">
          model
        </Badge>
      ) : null}
      <div className="min-w-0 flex flex-1 items-center gap-2">
        <div className="min-w-0 flex flex-1 items-center gap-1.5 overflow-hidden">
          <span className="shrink-0 text-[11.5px] font-medium text-foreground/80">
            {props.item.type === "slash-command" || props.item.type === "provider-native-command"
              ? commandMenuTitle(props.item)
              : props.item.label}
          </span>
          <span className="truncate text-[11px] text-muted-foreground/55">
            {props.item.description}
          </span>
        </div>
        {(props.item.type === "slash-command" || props.item.type === "provider-native-command") && (
          <span className="shrink-0 text-[10.5px] text-muted-foreground/45">
            /{props.item.command}
          </span>
        )}
      </div>
    </CommandItem>
  );
});

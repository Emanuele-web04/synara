import {
  type ProjectEntry,
  type ModelSlug,
  type ProviderKind,
  type ProviderSkillDescriptor,
} from "@t3tools/contracts";
import { memo } from "react";
import { type ComposerSlashCommand, type ComposerTriggerKind } from "../../composer-logic";
import { BotIcon, HammerIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Command, CommandItem, CommandList } from "../ui/command";
import { VscodeEntryIcon } from "./VscodeEntryIcon";

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
      type: "skill";
      skill: ProviderSkillDescriptor;
      label: string;
      description: string;
    };

export const ComposerCommandMenu = memo(function ComposerCommandMenu(props: {
  items: ComposerCommandItem[];
  resolvedTheme: "light" | "dark";
  isLoading: boolean;
  triggerKind: ComposerTriggerKind | null;
  activeItemId: string | null;
  onHighlightedItemChange: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  return (
    <Command
      mode="none"
      onItemHighlighted={(highlightedValue) => {
        props.onHighlightedItemChange(
          typeof highlightedValue === "string" ? highlightedValue : null,
        );
      }}
    >
      <div className="relative overflow-hidden rounded-xl border border-border/50 bg-popover shadow-sm">
        <CommandList className="max-h-72">
          {props.items.map((item) => (
            <ComposerCommandMenuItem
              key={item.id}
              item={item}
              resolvedTheme={props.resolvedTheme}
              isActive={props.activeItemId === item.id}
              onSelect={props.onSelect}
            />
          ))}
        </CommandList>
        {props.items.length === 0 && (
          <p className="px-3 py-2 text-muted-foreground/50 text-[11px]">
            {props.isLoading
              ? "Searching workspace files..."
              : props.triggerKind === "path"
                ? "No matching files or folders."
                : props.triggerKind === "skill"
                  ? "No matching skill."
                  : "No matching command."}
          </p>
        )}
      </div>
    </Command>
  );
});

function formatSkillScope(scope: string | undefined): string {
  if (!scope) return "Personal";
  const normalized = scope.trim();
  if (normalized.length === 0) return "Personal";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

const ComposerCommandMenuItem = memo(function ComposerCommandMenuItem(props: {
  item: ComposerCommandItem;
  resolvedTheme: "light" | "dark";
  isActive: boolean;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  if (props.item.type === "skill") {
    return (
      <CommandItem
        value={props.item.id}
        className={cn(
          "cursor-pointer rounded-lg px-3 py-2",
          props.isActive && "bg-accent/30 text-accent-foreground",
        )}
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        onClick={() => {
          props.onSelect(props.item);
        }}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <div
            className={cn(
              "flex size-4 shrink-0 items-center justify-center text-muted-foreground/60",
              props.isActive && "text-foreground/70",
            )}
          >
            <HammerIcon className="size-3.5" />
          </div>
          <div className="min-w-0 flex flex-1 items-center gap-2">
            <span className="truncate font-medium text-[11.5px] leading-none text-foreground/80">
              {props.item.label}
            </span>
            <span className="min-w-0 flex-1 truncate text-[11px] leading-none text-muted-foreground/55">
              {props.item.description}
            </span>
          </div>
          <div className="shrink-0 pl-2 text-[10.5px] leading-none text-muted-foreground/45">
            {formatSkillScope(props.item.skill.scope)}
          </div>
        </div>
      </CommandItem>
    );
  }

  return (
    <CommandItem
      value={props.item.id}
      className={cn(
        "cursor-pointer select-none gap-2 rounded-lg px-3 py-2",
        props.isActive && "bg-accent/30 text-accent-foreground",
      )}
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
      {props.item.type === "slash-command" ? (
        <BotIcon className="size-3.5 text-muted-foreground/60" />
      ) : null}
      {props.item.type === "model" ? (
        <Badge variant="outline" className="px-1 py-0 text-[9px]">
          model
        </Badge>
      ) : null}
      <span className="flex min-w-0 items-center gap-1.5 truncate text-[11.5px] font-medium text-foreground/80">
        <span className="truncate">{props.item.label}</span>
      </span>
      <span className="truncate text-muted-foreground/55 text-[11px]">
        {props.item.description}
      </span>
    </CommandItem>
  );
});

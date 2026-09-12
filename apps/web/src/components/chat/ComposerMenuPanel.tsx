// FILE: ComposerMenuPanel.tsx
// Purpose: Shared floating panel chrome + row layout for every composer menu (slash/mention
//   command menu, the `+` extras panel) so all composer menus read as one surface.
// Layer: Chat composer presentation
// Depends on: Command primitives and the shared composer picker style tokens.

import { memo, useEffect, useRef, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import {
  Command,
  CommandGroup,
  CommandGroupLabel,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "../ui/command";
import {
  COMPOSER_COMMAND_MENU_ITEM_ACTIVE_CLASS_NAME,
  COMPOSER_COMMAND_MENU_ITEM_CLASS_NAME,
  COMPOSER_COMMAND_MENU_SURFACE_CLASS_NAME,
} from "./composerPickerStyles";

export const COMPOSER_MENU_PANEL_GROUP_LABEL_CLASS_NAME =
  "px-2 pt-1.5 pb-1 text-[11px] font-normal text-muted-foreground/60";

/** Glyph size shared by every panel row icon, whatever the menu. */
export const COMPOSER_MENU_PANEL_GLYPH_CLASS_NAME = "size-3.5";

// Single icon column shared by every menu row. Rows differ only by the glyph,
// its color, and the name — slot geometry stays constant so files, folders,
// skills, plugins, commands, and agents line up identically.
const COMPOSER_MENU_PANEL_ICON_SLOT_CLASS_NAME =
  "flex size-4 shrink-0 items-center justify-center text-muted-foreground/60";

export type ComposerMenuPanelRow = {
  id: string;
  icon?: ReactNode;
  title: string;
  /** Dimmed text trailing the title on the same line. */
  secondary?: string | null;
  /** Right-aligned metadata (path, scope, shortcut, chevron, check). */
  trailing?: ReactNode;
  disabled?: boolean;
};

export type ComposerMenuPanelGroup = {
  id: string;
  label?: string | null;
  rows: ComposerMenuPanelRow[];
};

export function ComposerMenuPanel(props: {
  groups: ComposerMenuPanelGroup[];
  activeRowId: string | null;
  onHighlightRow: (rowId: string | null) => void;
  onSelectRow: (rowId: string) => void;
  /** Non-selectable content rendered under the last group inside the list. */
  footer?: ReactNode;
  /** Loading / empty copy rendered as a sibling of the list. */
  status?: ReactNode;
  listClassName?: string;
  surfaceClassName?: string;
}) {
  const rowRefs = useRef<Record<string, HTMLElement | null>>({});
  const hasRows = props.groups.some((group) => group.rows.length > 0);
  const activeRowId = props.activeRowId;

  useEffect(() => {
    if (!activeRowId) {
      return;
    }

    rowRefs.current[activeRowId]?.scrollIntoView({ block: "nearest" });
  }, [activeRowId]);

  return (
    <Command
      autoHighlight={false}
      mode="none"
      onItemHighlighted={(highlightedValue) => {
        props.onHighlightRow(typeof highlightedValue === "string" ? highlightedValue : null);
      }}
    >
      <div className={cn(COMPOSER_COMMAND_MENU_SURFACE_CLASS_NAME, props.surfaceClassName)}>
        {hasRows || props.footer ? (
          <CommandList className={cn("max-h-72 scroll-py-1 p-1", props.listClassName)}>
            {props.groups.map((group, groupIndex) => (
              <div key={group.id}>
                {groupIndex > 0 ? <CommandSeparator className="my-0.5" /> : null}
                <CommandGroup>
                  {group.label ? (
                    <CommandGroupLabel className={COMPOSER_MENU_PANEL_GROUP_LABEL_CLASS_NAME}>
                      {group.label}
                    </CommandGroupLabel>
                  ) : null}
                  {group.rows.map((row) => (
                    <ComposerMenuPanelItem
                      key={row.id}
                      row={row}
                      isActive={props.activeRowId === row.id}
                      rowRef={(node) => {
                        rowRefs.current[row.id] = node;
                      }}
                      onHighlight={props.onHighlightRow}
                      onSelect={props.onSelectRow}
                    />
                  ))}
                </CommandGroup>
              </div>
            ))}
            {props.footer}
          </CommandList>
        ) : null}
        {props.status}
      </div>
    </Command>
  );
}

// Props are destructured rather than read off a `props` object: `rowRef` lands on a JSX `ref`,
// which makes React Compiler treat it as a ref — and through `props.rowRef` that verdict spreads
// to the whole `props` object, so every later `props.x` read looks like a ref access during render
// and the component bails out of compilation entirely. Separate bindings keep the verdict on
// `rowRef` alone. Do not collapse these back into a `props` parameter.
const ComposerMenuPanelItem = memo(function ComposerMenuPanelItem({
  row,
  isActive,
  rowRef,
  onHighlight,
  onSelect,
}: {
  row: ComposerMenuPanelRow;
  isActive: boolean;
  rowRef: (node: HTMLElement | null) => void;
  onHighlight: (rowId: string | null) => void;
  onSelect: (rowId: string) => void;
}) {
  return (
    <CommandItem
      ref={rowRef}
      value={row.id}
      disabled={row.disabled ?? false}
      className={cn(
        COMPOSER_COMMAND_MENU_ITEM_CLASS_NAME,
        isActive && COMPOSER_COMMAND_MENU_ITEM_ACTIVE_CLASS_NAME,
        row.disabled && "cursor-default opacity-70 hover:bg-transparent",
      )}
      onMouseMove={() => {
        if (!isActive && !row.disabled) onHighlight(row.id);
      }}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        if (row.disabled) return;
        onSelect(row.id);
      }}
    >
      {row.icon === undefined ? null : (
        <span
          className={cn(COMPOSER_MENU_PANEL_ICON_SLOT_CLASS_NAME, isActive && "text-foreground/70")}
        >
          {row.icon}
        </span>
      )}
      <div className="min-w-0 flex flex-1 items-center gap-3">
        <div className="min-w-0 flex flex-1 items-center gap-1.5 overflow-hidden">
          <span className="shrink-0 text-[11.5px] font-medium text-foreground/80">{row.title}</span>
          {row.secondary ? (
            <span className="truncate text-[11px] text-muted-foreground/55">{row.secondary}</span>
          ) : null}
        </div>
        {row.trailing === undefined || row.trailing === null ? null : (
          <span className="shrink-0 flex items-center pl-2 text-right text-[10.5px] text-muted-foreground/42">
            {row.trailing}
          </span>
        )}
      </div>
    </CommandItem>
  );
});

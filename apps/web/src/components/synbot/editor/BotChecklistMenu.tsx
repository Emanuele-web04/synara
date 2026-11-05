// FILE: BotChecklistMenu.tsx
// Purpose: The bot editor's multi-select: a picker menu of checkbox rows (projects, skills) and
//          the chips of what is chosen, each removable. Built on the app's picker menu.
// Layer: SynBot editor UI
// Exports: BotChecklistMenu, BotChecklistChips, BotChecklistItem

import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Menu, MenuCheckboxItem, MenuItem, MenuTrigger } from "~/components/ui/menu";
import { ChevronDownIcon, XIcon } from "~/lib/icons";

export interface BotChecklistItem {
  readonly id: string;
  readonly label: string;
  /** A muted second line (a path). */
  readonly detail?: string;
}

export function BotChecklistMenu(props: {
  readonly triggerLabel: string;
  readonly ariaLabel: string;
  readonly items: readonly BotChecklistItem[];
  readonly selectedIds: ReadonlySet<string>;
  readonly onToggle: (id: string) => void;
  /** Shown as a disabled row when there is nothing to pick. */
  readonly emptyLabel: string;
  readonly disabled?: boolean;
  /** At the limit: unchecked rows are disabled. */
  readonly full?: boolean;
}) {
  return (
    <Menu>
      <MenuTrigger
        disabled={props.disabled}
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={props.ariaLabel}
            className="w-full justify-between sm:w-auto"
          />
        }
      >
        <span className="truncate">{props.triggerLabel}</span>
        <ChevronDownIcon aria-hidden className="size-3.5" />
      </MenuTrigger>
      <ComposerPickerMenuPopup align="end" className="max-h-80 min-w-56 max-w-96 overflow-y-auto">
        {props.items.length === 0 ? (
          <MenuItem disabled>{props.emptyLabel}</MenuItem>
        ) : (
          props.items.map((item) => {
            const checked = props.selectedIds.has(item.id);
            return (
              <MenuCheckboxItem
                key={item.id}
                variant="checkbox"
                checked={checked}
                disabled={!checked && props.full === true}
                onCheckedChange={() => props.onToggle(item.id)}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{item.label}</span>
                  {item.detail ? (
                    <span className="truncate text-ui-sm text-muted-foreground">{item.detail}</span>
                  ) : null}
                </span>
              </MenuCheckboxItem>
            );
          })
        )}
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

export function BotChecklistChips(props: {
  readonly items: readonly BotChecklistItem[];
  readonly removeLabel: (item: BotChecklistItem) => string;
  readonly onRemove: (id: string) => void;
  readonly disabled?: boolean;
}) {
  if (props.items.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5 pt-2">
      {props.items.map((item) => (
        <li key={item.id} className="min-w-0">
          <Badge
            variant="outline"
            size="lg"
            className="max-w-64 gap-0.5 rounded-full ps-2 pe-0.5 font-normal"
            title={item.detail}
          >
            <span className="truncate">{item.label}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="size-4 rounded-full text-muted-foreground hover:text-foreground"
              disabled={props.disabled}
              aria-label={props.removeLabel(item)}
              onClick={() => props.onRemove(item.id)}
            >
              <XIcon className="size-3" />
            </Button>
          </Badge>
        </li>
      ))}
    </ul>
  );
}

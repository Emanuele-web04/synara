// FILE: Menu.tsx
// Purpose: HoloBot's popover menu (ported from packages/ui Menu.tsx) on Synara's ui/menu:
//          anchored to its trigger (the top bar's More, the composer's "+"), items in sections,
//          a check on the chosen one. It opens over everything, dialogs included, and flips or
//          shrinks to stay on screen. Closes on a pick, Escape or a click outside; arrow keys
//          and typing move between items. Right-click menus use Synara's own context menu.
// Layer: SynBot kit
// Exports: MenuEntry, Menu

import type { ReactElement, ReactNode } from "react";

import {
  Menu as MenuRoot,
  MenuItem,
  MenuPopupBase,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";

import { Icon, type IconName } from "./Icon";

export type MenuEntry =
  | { readonly section: string }
  | { readonly rule: true }
  | {
      readonly id: string;
      readonly label: string;
      readonly icon?: IconName;
      /** A glyph of its own in place of `icon` (a provider logo, a project's icon). */
      readonly glyph?: ReactNode;
      readonly detail?: string;
      readonly checked?: boolean;
      readonly disabled?: boolean;
      readonly danger?: boolean;
      /** A checklist item: picking it leaves the menu open. */
      readonly keepOpen?: boolean;
      readonly onSelect: () => void;
    };

/** Where the panel opens, as ui/menu's side and alignment. */
const PLACES = {
  "below-end": { side: "bottom", align: "end" },
  "below-start": { side: "bottom", align: "start" },
  "above-start": { side: "top", align: "start" },
} as const;

/** The gap between the trigger and the panel (`--hb-gap-sm`). */
const PANEL_OFFSET = 6;

function Items({ items }: { readonly items: readonly MenuEntry[] }) {
  return items.map((item, index) =>
    "section" in item ? (
      // oxlint-disable-next-line react/no-array-index-key -- static, positional entries
      <div key={`s${index}`} className="hb-menu__section" role="presentation">
        {item.section}
      </div>
    ) : "rule" in item ? (
      // oxlint-disable-next-line react/no-array-index-key -- static, positional entries
      <MenuSeparator key={`r${index}`} className="hb-menu__rule" />
    ) : (
      <MenuItem
        key={item.id}
        className="hb-menu__item"
        variant={item.danger ? "destructive" : "default"}
        role={item.checked === undefined ? "menuitem" : "menuitemradio"}
        aria-checked={item.checked}
        disabled={item.disabled}
        closeOnClick={!item.keepOpen}
        onClick={item.onSelect}
      >
        {item.glyph || item.icon ? (
          <span className="hb-menu__icon">
            {item.glyph ?? (item.icon ? <Icon name={item.icon} size="sm" /> : null)}
          </span>
        ) : null}
        <span className="hb-menu__label">
          {item.label}
          {item.detail ? <span className="hb-menu__detail">{item.detail}</span> : null}
        </span>
        {item.checked ? <Icon name="check" size="sm" /> : null}
      </MenuItem>
    ),
  );
}

export function Menu({
  trigger,
  items,
  label,
  place = "below-end",
  onOpenChange,
}: {
  /** The button that opens it (a kit button or a plain <button>; it takes the menu's props). */
  readonly trigger: ReactElement;
  readonly items: readonly MenuEntry[];
  readonly label: string;
  /** Where the panel opens. */
  readonly place?: keyof typeof PLACES;
  readonly onOpenChange?: (open: boolean) => void;
}) {
  return (
    <MenuRoot onOpenChange={(open) => onOpenChange?.(open)}>
      <MenuTrigger render={trigger} />
      <MenuPopupBase
        surface="bare"
        className="hb hb-menu__panel"
        side={PLACES[place].side}
        align={PLACES[place].align}
        sideOffset={PANEL_OFFSET}
        aria-label={label}
      >
        <Items items={items} />
      </MenuPopupBase>
    </MenuRoot>
  );
}

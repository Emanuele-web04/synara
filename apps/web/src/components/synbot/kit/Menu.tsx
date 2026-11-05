// FILE: Menu.tsx
// Purpose: HoloBot's popover menu (ported from packages/ui Menu.tsx): anchored to its trigger
//          (the top bar's More, the composer's "+"), items in sections, a check on the chosen
//          one. Opens on click, closes on a pick, Escape or a click outside; arrow keys move
//          between items. Right-click menus use Synara's own context menu (native on desktop).
// Layer: SynBot kit
// Exports: MenuEntry, Menu

import {
  cloneElement,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type RefObject,
} from "react";

import { Icon, type IconName } from "./Icon";

export type MenuEntry =
  | { readonly section: string }
  | { readonly rule: true }
  | {
      readonly id: string;
      readonly label: string;
      readonly icon?: IconName;
      readonly detail?: string;
      readonly checked?: boolean;
      readonly disabled?: boolean;
      readonly danger?: boolean;
      /** A checklist item: picking it leaves the menu open. */
      readonly keepOpen?: boolean;
      readonly onSelect: () => void;
    };

type TriggerProps = {
  onClick?: () => void;
  "aria-expanded"?: boolean;
  "aria-haspopup"?: "menu";
};

/** Closes on a click outside `inside` and focuses the first (or checked) item while `open`. */
function useOpenPanel(
  open: boolean,
  close: () => void,
  inside: RefObject<HTMLElement | null>,
  panel: RefObject<HTMLDivElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!inside.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", outside);
    const first = panel.current?.querySelector<HTMLButtonElement>(
      '[aria-checked="true"]:not(:disabled), button:not(:disabled)',
    );
    first?.focus();
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, close, inside, panel]);
}

/** Escape closes; the arrow keys move between items. */
function keys(panel: RefObject<HTMLDivElement | null>, close: () => void) {
  return (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const buttons = [
      ...(panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []),
    ];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? at + 1 : at - 1;
    buttons[(next + buttons.length) % buttons.length]?.focus();
  };
}

function Items({
  items,
  close,
}: {
  readonly items: readonly MenuEntry[];
  readonly close: () => void;
}) {
  return items.map((item, index) =>
    "section" in item ? (
      // oxlint-disable-next-line react/no-array-index-key -- static, positional entries
      <div key={`s${index}`} className="hb-menu__section" role="presentation">
        {item.section}
      </div>
    ) : "rule" in item ? (
      // oxlint-disable-next-line react/no-array-index-key -- static, positional entries
      <div key={`r${index}`} className="hb-menu__rule" role="separator" />
    ) : (
      <button
        key={item.id}
        type="button"
        className={`hb-menu__item${item.danger ? " hb-menu__item--danger" : ""}`}
        role={item.checked === undefined ? "menuitem" : "menuitemradio"}
        aria-checked={item.checked}
        disabled={item.disabled}
        onClick={() => {
          if (!item.keepOpen) close();
          item.onSelect();
        }}
      >
        {item.icon ? (
          <span className="hb-menu__icon">
            <Icon name={item.icon} size="sm" />
          </span>
        ) : null}
        <span className="hb-menu__label">
          {item.label}
          {item.detail ? <span className="hb-menu__detail">{item.detail}</span> : null}
        </span>
        {item.checked ? <Icon name="check" size="sm" /> : null}
      </button>
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
  /** The button that opens it (its onClick is taken over). */
  readonly trigger: ReactElement<TriggerProps>;
  readonly items: readonly MenuEntry[];
  readonly label: string;
  /** Where the panel opens. */
  readonly place?: "below-end" | "below-start" | "above-start";
  readonly onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  });
  const [close] = useState(() => () => {
    setOpen(false);
    onOpenChangeRef.current?.(false);
  });
  useOpenPanel(open, close, root, panel);

  return (
    <span className="hb-menu" ref={root} onKeyDown={keys(panel, close)}>
      {cloneElement(trigger, {
        onClick: () => {
          const next = !open;
          setOpen(next);
          onOpenChange?.(next);
        },
        "aria-expanded": open,
        "aria-haspopup": "menu",
      })}
      {open ? (
        <div
          className={`hb-menu__panel hb-menu__panel--${place}`}
          ref={panel}
          role="menu"
          aria-label={label}
        >
          <Items items={items} close={close} />
        </div>
      ) : null}
    </span>
  );
}

// FILE: RecentViewSwitcher.tsx
// Purpose: Render the transient Ctrl+Tab recent-view overlay.
// Layer: UI component
// Exports: RecentViewSwitcher plus item shape used by the chat route shell.

import type { KeybindingShortcut } from "@synara/contracts";

import { formatShortcutLabel } from "../keybindings";
import {
  MessageCircleIcon,
  PanelLeftIcon,
  PinFilledIcon,
  PluginIcon,
  SettingsIcon,
  WindowIcon,
} from "../lib/icons";
import { cn } from "../lib/utils";
import type { RecentViewDisplayEntry } from "../recentViews.logic";
import { ProviderIcon } from "./ProviderIcon";
import TerminalIdentityIcon from "./terminal/TerminalIdentityIcon";
import { Kbd } from "./ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

// Keycap hints rendered in the switcher footer. These mirror the real bindings:
// the switcher cycles on literal Ctrl+Tab / Ctrl+Shift+Tab (see keybindings.ts —
// literal Ctrl on macOS too, matching Arc/Helium), commits on Enter, cancels on Esc.
const NO_MODIFIERS = {
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  modKey: false,
} as const;

const SWITCHER_FOOTER_SHORTCUTS: ReadonlyArray<KeybindingShortcut> = [
  { ...NO_MODIFIERS, key: "Tab", ctrlKey: true },
  { ...NO_MODIFIERS, key: "Tab", ctrlKey: true, shiftKey: true },
  { ...NO_MODIFIERS, key: "Enter" },
  { ...NO_MODIFIERS, key: "escape" },
];

// Swap the spelled-out non-modifier keys for their universal keycap glyphs (the
// tab "arrow to bar" and the return arrow). Modifiers stay as whatever
// `formatShortcutLabel` produced so they remain platform-correct: ⌃/⇧ on macOS,
// "Ctrl"/"Shift" text on Windows/Linux. Each shortcut renders as a SINGLE keycap
// (e.g. ⌃⇥, ⌃⇧⇥) — never split into separate modifier chips, which would repeat
// ⌃/⇥ across the Tab chords and read as duplicates.
const FOOTER_KEY_GLYPHS: Readonly<Record<string, string>> = {
  Tab: "⇥",
  Enter: "↵",
};

function footerKeyLabel(shortcut: KeybindingShortcut): string {
  let label = formatShortcutLabel(shortcut);
  for (const [name, glyph] of Object.entries(FOOTER_KEY_GLYPHS)) {
    label = label.replace(name, glyph);
  }
  return label;
}

// Plain-text explanation shown on hover. The keycap shows platform glyphs (⌃⇥);
// this spells the chord out in words ("Ctrl + Tab") so the glyphs are never
// ambiguous. Force the non-mac text form so it reads as words on every platform.
function footerTooltipLabel(shortcut: KeybindingShortcut): string {
  return formatShortcutLabel(shortcut, "Win32").split("+").join(" + ");
}

function EntryIcon(props: { entry: RecentViewDisplayEntry }) {
  const className = "size-[18px]";

  switch (props.entry.icon.kind) {
    case "terminal":
      return <TerminalIdentityIcon className={className} iconKey={props.entry.icon.iconKey} />;
    case "provider":
      return <ProviderIcon provider={props.entry.icon.provider} className={className} />;
    case "chat":
      return <MessageCircleIcon className={className} aria-hidden="true" />;
    case "workspace":
      return <WindowIcon className={className} aria-hidden="true" />;
    case "settings":
      return <SettingsIcon className={className} aria-hidden="true" />;
    case "plugins":
      return <PluginIcon className={className} aria-hidden="true" />;
  }
}

export function RecentViewSwitcher(props: {
  entries: ReadonlyArray<RecentViewDisplayEntry>;
  selectedIndex: number;
}) {
  if (props.entries.length === 0) {
    return null;
  }

  const selectedIndex =
    props.selectedIndex >= 0 && props.selectedIndex < props.entries.length
      ? props.selectedIndex
      : 0;

  return (
    <div className="pointer-events-none fixed inset-0 z-[90] flex items-start justify-center pt-[14vh]">
      <div
        role="listbox"
        aria-label="Recent views"
        aria-activedescendant={`recent-view-switcher-${selectedIndex}`}
        className="w-[min(34rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border/70 bg-popover/95 text-popover-foreground shadow-2xl shadow-black/30 backdrop-blur-xl"
      >
        <div className="flex flex-col gap-0.5 p-1.5">
          {props.entries.map((entry, index) => {
            const selected = index === selectedIndex;
            return (
              <div
                key={entry.key}
                id={`recent-view-switcher-${index}`}
                role="option"
                aria-selected={selected}
                className={cn(
                  "flex h-14 items-center gap-3 rounded-lg px-2.5 transition-colors",
                  selected
                    ? "bg-[var(--color-background-button-secondary-hover)] text-[var(--color-text-foreground)]"
                    : "text-foreground/80",
                )}
              >
                <div className="flex size-7 shrink-0 items-center justify-center text-muted-foreground">
                  <EntryIcon entry={entry} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium leading-5">{entry.title}</span>
                    {entry.isCurrent ? (
                      <span className="shrink-0 rounded-full border border-border/60 bg-muted/70 px-1.5 py-px text-[10px] font-medium leading-4 text-muted-foreground">
                        Current
                      </span>
                    ) : null}
                  </div>
                  <div className="truncate text-xs leading-4 text-muted-foreground">
                    {entry.subtitle}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                  {entry.isSplit ? (
                    <PanelLeftIcon className="size-3.5" aria-label="Split view" />
                  ) : null}
                  {entry.isPinned ? (
                    <PinFilledIcon className="size-3.5" aria-label="Pinned" />
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-border/60 px-3 py-2 text-[11px] text-muted-foreground">
          <span className="shrink-0">
            {props.entries.length} recent {props.entries.length === 1 ? "view" : "views"}
          </span>
          <div className="pointer-events-auto flex items-center gap-2">
            {SWITCHER_FOOTER_SHORTCUTS.map((shortcut) => (
              <Tooltip key={`${shortcut.key}-${shortcut.shiftKey}`}>
                <TooltipTrigger
                  render={
                    <span className="pointer-events-auto inline-flex cursor-default">
                      <Kbd>{footerKeyLabel(shortcut)}</Kbd>
                    </span>
                  }
                />
                <TooltipPopup side="top">{footerTooltipLabel(shortcut)}</TooltipPopup>
              </Tooltip>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

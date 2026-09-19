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
  const className = "size-3.5";

  switch (props.entry.icon.kind) {
    case "terminal":
      return <TerminalIdentityIcon className={className} iconKey={props.entry.icon.iconKey} />;
    case "provider":
      return <ProviderIcon provider={props.entry.icon.provider} className={className} />;
    case "chat":
      return <MessageCircleIcon className={className} aria-hidden="true" />;
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
        // Same skin as the ⌘K / ⌘P palettes (ui/command popup): squircle 2xl surface,
        // settings-scale type, 30px single-line rows with the zinc highlight.
        className="palette-surface w-[min(32rem,calc(100vw-2rem))] overflow-hidden rounded-3xl border border-[color:var(--color-border-light)] bg-[var(--color-background-surface-under)] text-[var(--color-text-foreground)] shadow-2xl shadow-black/30 backdrop-blur-xl"
      >
        <div className="flex flex-col p-1.5">
          <div className="px-2.5 pt-1.5 pb-1 text-ui-xs text-muted-foreground/70">Recent views</div>
          {props.entries.map((entry, index) => {
            const selected = index === selectedIndex;
            return (
              <div
                key={entry.key}
                id={`recent-view-switcher-${index}`}
                role="option"
                aria-selected={selected}
                className={cn(
                  "palette-row flex min-h-[30px] items-center gap-3 rounded-[20px] px-2.5 transition-colors",
                  selected
                    ? "bg-zinc-500/8 text-foreground dark:bg-zinc-400/10"
                    : "text-foreground",
                )}
              >
                <div className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
                  <EntryIcon entry={entry} />
                </div>
                <span className="min-w-0 flex-1 truncate text-ui">{entry.title}</span>
                {entry.subtitle ? (
                  <span className="max-w-[40%] shrink-0 truncate text-ui-meta text-muted-foreground/70">
                    {entry.subtitle}
                  </span>
                ) : null}
                {entry.isCurrent ? (
                  <span className="shrink-0 rounded-full bg-muted px-1.5 text-ui-2xs leading-4 text-muted-foreground">
                    Current
                  </span>
                ) : null}
                {entry.isSplit || entry.isPinned ? (
                  <div className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                    {entry.isSplit ? (
                      <PanelLeftIcon className="size-3.5" aria-label="Split view" />
                    ) : null}
                    {entry.isPinned ? (
                      <PinFilledIcon className="size-3.5" aria-label="Pinned" />
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-3 px-3.5 pt-0.5 pb-2 text-ui-xs text-muted-foreground/70">
          <span className="shrink-0">
            {props.entries.length} recent {props.entries.length === 1 ? "view" : "views"}
          </span>
          <div className="pointer-events-auto flex items-center gap-2">
            {SWITCHER_FOOTER_SHORTCUTS.map((shortcut) => (
              <Tooltip key={`${shortcut.key}-${shortcut.shiftKey}`}>
                <TooltipTrigger
                  render={
                    <span className="pointer-events-auto inline-flex cursor-default">
                      <Kbd className="h-[17px] rounded-md px-1.5 text-ui-xs text-muted-foreground/80">
                        {footerKeyLabel(shortcut)}
                      </Kbd>
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

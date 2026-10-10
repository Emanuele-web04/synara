import type * as React from "react";

import { splitShortcutLabel } from "~/keybindings";
import { cn, isMacNavigatorPlatform } from "~/lib/utils";

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center gap-1 rounded bg-muted px-1 font-medium font-sans text-muted-foreground text-ui leading-snug [&_svg:not([class*='size-'])]:size-3",
        className,
      )}
      data-slot="kbd"
      {...props}
    />
  );
}

function KbdGroup({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn("inline-flex items-center gap-1", className)}
      data-slot="kbd-group"
      {...props}
    />
  );
}

/**
 * A shortcut chord in one capsule: the look of the Settings keybinding list. Every place that
 * shows a keybinding (sidebar hints, menus, palettes, tooltips, dialogs) renders it through
 * here, so the style cannot drift. Size and tone overrides go in `className`.
 */
function ShortcutKbd({
  shortcutLabel,
  className,
  groupClassName,
  ...props
}: Omit<React.ComponentProps<"kbd">, "children"> & {
  shortcutLabel: string;
  groupClassName?: string;
}) {
  const parts = splitShortcutLabel(shortcutLabel);
  // Symbol labels ("⇧⌘K") get a hair of space between keys so a word key ("⇧⌘Right") stays
  // legible, and truncate from the modifiers while the key stays visible. Anything the split
  // does not reproduce exactly ("Ctrl+Shift+K", or a chord on the plus key) already reads as
  // one chord and is shown as written.
  const symbols = parts.join("") === shortcutLabel;
  return (
    <Kbd
      aria-label={shortcutLabel}
      {...props}
      className={cn(
        "h-5 gap-0.5 rounded-full bg-foreground/5 px-2 text-foreground/80 dark:bg-foreground/12",
        groupClassName,
        className,
      )}
    >
      {symbols ? (
        parts.map((part, index) => (
          <span key={part} className={index === parts.length - 1 ? "shrink-0" : "min-w-0 truncate"}>
            {part}
          </span>
        ))
      ) : (
        <span className="truncate">{shortcutLabel}</span>
      )}
    </Kbd>
  );
}

/** The "submit this dialog" chord, spelled for the host platform. */
export function getSubmitShortcutKeyShortcuts(): string {
  return isMacNavigatorPlatform() ? "Meta+Enter" : "Control+Enter";
}

function SubmitShortcutKbd({ className }: { className?: string }) {
  return (
    <ShortcutKbd
      shortcutLabel={isMacNavigatorPlatform() ? "⌘↵" : "Ctrl ↵"}
      {...(className ? { className } : {})}
    />
  );
}

export { Kbd, KbdGroup, ShortcutKbd, SubmitShortcutKbd };

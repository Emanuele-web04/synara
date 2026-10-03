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

function KbdGroup({
  className,
  shortcutLabel,
  children,
  ...props
}: React.ComponentProps<"kbd"> & { shortcutLabel?: string | null }) {
  const shortcutParts = shortcutLabel ? splitShortcutLabel(shortcutLabel) : null;
  return (
    <kbd
      className={cn("inline-flex items-center gap-1", shortcutLabel && "min-w-0", className)}
      data-slot="kbd-group"
      aria-label={shortcutLabel ?? undefined}
      title={shortcutLabel ?? undefined}
      {...props}
    >
      {shortcutParts
        ? shortcutParts.map((part, index) => (
            <Kbd key={part} className={index === shortcutParts.length - 1 ? "shrink-0" : "min-w-0"}>
              <span className="truncate">{part}</span>
            </Kbd>
          ))
        : children}
    </kbd>
  );
}

/** The "submit this dialog" chord, spelled for the host platform. */
function SubmitShortcutKbd({ className }: { className?: string }) {
  return <Kbd className={className}>{isMacNavigatorPlatform() ? "⌘↵" : "Ctrl ↵"}</Kbd>;
}

export { Kbd, KbdGroup, SubmitShortcutKbd };

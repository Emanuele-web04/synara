import { Kbd, KbdGroup } from "./kbd";
import { splitShortcutLabel } from "../../keybindings";
import { cn } from "~/lib/utils";

/**
 * A shortcut as key pills, one per key. `joined` draws the whole chord in a single
 * capsule instead, for lists where each shortcut has to read as one unit.
 */
export function ShortcutKbd(props: {
  shortcutLabel: string;
  joined?: boolean;
  className?: string;
  groupClassName?: string;
}) {
  const parts = splitShortcutLabel(props.shortcutLabel);

  if (props.joined) {
    // Symbol labels ("⇧⌘K") get a hair of space between keys so a word key ("⇧⌘Right")
    // stays legible. Anything the split does not reproduce exactly ("Ctrl+Shift+K", or
    // a chord on the plus key) already reads as one chord and is shown as written.
    const symbols = parts.join("") === props.shortcutLabel;
    return (
      <Kbd
        className={cn(
          "h-6 gap-0.5 rounded-full bg-foreground/8 px-2.5 text-foreground/80",
          props.groupClassName,
          props.className,
        )}
      >
        {symbols ? parts.map((part) => <span key={part}>{part}</span>) : props.shortcutLabel}
      </Kbd>
    );
  }

  return (
    <KbdGroup className={cn("gap-1", props.groupClassName)}>
      {parts.map((part) => (
        <Kbd key={part} className={props.className}>
          {part}
        </Kbd>
      ))}
    </KbdGroup>
  );
}

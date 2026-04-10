import { Kbd, KbdGroup } from "./kbd";
import { cn } from "~/lib/utils";

const MODIFIER_SYMBOLS = new Set(["⌘", "⌥", "⌃", "⇧"]);

function splitShortcutLabel(shortcutLabel: string): string[] {
  if (shortcutLabel.includes("+")) {
    return shortcutLabel
      .split("+")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }

  if ([...shortcutLabel].some((char) => MODIFIER_SYMBOLS.has(char))) {
    const parts = [...shortcutLabel];
    const key = parts
      .filter((char) => !MODIFIER_SYMBOLS.has(char))
      .join("")
      .trim();
    const modifiers = parts.filter((char) => MODIFIER_SYMBOLS.has(char));
    return key.length > 0 ? [...modifiers, key] : modifiers;
  }

  return [shortcutLabel];
}

export function ShortcutKbd(props: {
  shortcutLabel: string;
  className?: string;
  groupClassName?: string;
}) {
  const parts = splitShortcutLabel(props.shortcutLabel);

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

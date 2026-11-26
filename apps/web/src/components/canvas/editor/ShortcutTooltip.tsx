// FILE: ShortcutTooltip.tsx
// Purpose: A canvas control's tooltip content: its name, then its shortcut in the app's key
//          cap when it has one (the floating toolbar, the inspector's buttons).
// Layer: Canvas editor UI
// Exports: ShortcutTooltip

import { ShortcutKbd } from "../../ui/kbd";

export function ShortcutTooltip({
  label,
  shortcut,
}: {
  label: string;
  shortcut?: string | null | undefined;
}) {
  return (
    <span className="flex items-center gap-2">
      {label}
      {shortcut ? (
        <ShortcutKbd shortcutLabel={shortcut} className="h-4 min-w-4 px-1 text-ui-2xs" />
      ) : null}
    </span>
  );
}

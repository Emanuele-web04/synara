// FILE: keycap.tsx
// Purpose: A shortcut key drawn as the key you press: a raised cap on a darker skirt.
// Layer: Shared UI primitive
// Exports: Keycap

import { cn } from "~/lib/utils";

/**
 * One large keycap. `pressed` sits the cap down on its skirt, as while the key is held;
 * `pending` draws it faintly, for a slot still waiting for its key.
 */
export function Keycap({
  label,
  pressed,
  pending,
  className,
}: {
  label: string;
  pressed?: boolean;
  pending?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn("relative inline-flex pb-[3px]", pending && "opacity-45", className)}
      data-slot="keycap"
    >
      <span className="absolute inset-x-0 top-[3px] bottom-0 rounded-[9px] bg-[color-mix(in_srgb,var(--color-foreground)_24%,var(--color-popover))] dark:bg-black/60" />
      <span
        className={cn(
          "relative inline-flex h-12 min-w-12 items-center justify-center rounded-[9px] border border-black/10 bg-linear-to-b from-popover to-[color-mix(in_srgb,var(--color-foreground)_5%,var(--color-popover))] font-medium text-foreground text-ui-lg leading-none transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] motion-reduce:transition-none dark:border-white/10 dark:from-[color-mix(in_srgb,var(--color-foreground)_27%,var(--color-popover))] dark:to-[color-mix(in_srgb,var(--color-foreground)_19%,var(--color-popover))]",
          // Words (Ctrl, Space, 1–9) need side padding.
          [...label].length > 1 && "px-3.5",
          pressed && "translate-y-[3px] duration-75 ease-in motion-reduce:translate-y-0",
        )}
      >
        {label}
      </span>
    </span>
  );
}

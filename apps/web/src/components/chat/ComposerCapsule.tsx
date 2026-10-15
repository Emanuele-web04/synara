// FILE: ComposerCapsule.tsx
// Purpose: Floating capsules above the composer input. Activity that used to stack as
// w-14/15 strips (live changes, tasks, workflow, goal, tips, background agents,
// reconnecting) collapses into one compact pill each, in a wrapping row that floats over
// the transcript. A capsule can act on click, carry trailing actions, or open its full
// panel in a popover above it. Queued follow-ups stay a stacked panel.
// Layer: Chat composer UI
// Exports: ComposerCapsuleRow, ComposerCapsule, ComposerCapsulePopover,
// COMPOSER_CAPSULE_ACTION_CLASS_NAME

import { useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  COMPOSER_INLINE_ACTION_PILL_CLASS_NAME,
  COMPOSER_SURFACE_SHADOW_CLASS_NAME,
  RAISED_SURFACE_BORDER_CLASS_NAME,
} from "./composerPickerStyles";

/** Pill chrome: the composer's own glass material, so a capsule reads as a chip of the
 *  input below it. The radius goes through `--composer-radius` because
 *  `.chat-composer-surface` sets `border-radius` in unlayered CSS. */
const COMPOSER_CAPSULE_CLASS_NAME = [
  "chat-composer-surface pointer-events-auto inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 border px-2.5 text-ui text-foreground/85 [--composer-radius:9999px]",
  RAISED_SURFACE_BORDER_CLASS_NAME,
  COMPOSER_SURFACE_SHADOW_CLASS_NAME,
].join(" ");

/** Hover/open wash for clickable capsules, drawn on ::after: the glass fill is unlayered
 *  CSS, so a Tailwind `hover:bg-*` on the capsule itself would never win. */
const COMPOSER_CAPSULE_INTERACTIVE_CLASS_NAME =
  "cursor-pointer outline-none after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:transition-colors hover:text-foreground hover:after:bg-[var(--color-background-button-secondary-hover)] focus-visible:ring-1 focus-visible:ring-ring/60 data-popup-open:text-foreground data-popup-open:after:bg-[var(--color-background-button-secondary-hover)]";

/** Text action inside a capsule (tip "Turn on", "Use Medium"). */
export const COMPOSER_CAPSULE_ACTION_CLASS_NAME = cn(
  COMPOSER_INLINE_ACTION_PILL_CLASS_NAME,
  "rounded-full px-2 py-0 text-ui-sm leading-5",
);

const COMPOSER_CAPSULE_ROW_SELECTOR = "[data-composer-capsule-row]";

export function ComposerCapsuleRow({ children }: { children: ReactNode }) {
  return (
    <div
      data-composer-capsule-row=""
      // Clicks between capsules fall through to the transcript under the overlay; the row
      // disappears (with its gap) when every capsule renders null.
      className="pointer-events-none flex min-w-0 flex-wrap items-center gap-1.5 pb-2 empty:hidden"
    >
      {children}
    </div>
  );
}

interface ComposerCapsuleProps {
  icon?: ReactNode;
  children: ReactNode;
  /** Makes the whole capsule a button. Ignored when `actions` are present. */
  onClick?: (() => void) | undefined;
  /** Trailing controls (tip action, dismiss) beside the label. */
  actions?: ReactNode;
  title?: string | undefined;
  role?: string;
  testId?: string;
}

export function ComposerCapsule({
  icon,
  children,
  onClick,
  actions,
  title,
  role,
  testId,
}: ComposerCapsuleProps) {
  const label = (
    <>
      {icon}
      <span className="min-w-0 truncate">{children}</span>
    </>
  );
  if (onClick && !actions) {
    return (
      <button
        type="button"
        className={cn(COMPOSER_CAPSULE_CLASS_NAME, COMPOSER_CAPSULE_INTERACTIVE_CLASS_NAME)}
        title={title}
        data-testid={testId}
        onClick={onClick}
      >
        {label}
      </button>
    );
  }
  return (
    <div
      className={cn(COMPOSER_CAPSULE_CLASS_NAME, actions ? "pr-0.5" : null)}
      title={title}
      role={role}
      data-testid={testId}
    >
      {label}
      {actions ? <span className="flex shrink-0 items-center gap-0.5">{actions}</span> : null}
    </div>
  );
}

interface ComposerCapsulePopoverProps {
  icon?: ReactNode;
  label: ReactNode;
  title?: string | undefined;
  testId?: string;
  popupTestId?: string;
  /** The full panel. A function receives `close` for actions that hand focus back. */
  children: ReactNode | ((close: () => void) => ReactNode);
}

/** Capsule that opens its full panel in a popover above it (tasks, workflow, goal). The
 *  popover anchors to the capsule row, so it spans the composer width wherever the capsule sits. */
export function ComposerCapsulePopover({
  icon,
  label,
  title,
  testId,
  popupTestId,
  children,
}: ComposerCapsulePopoverProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        ref={triggerRef}
        type="button"
        className={cn(COMPOSER_CAPSULE_CLASS_NAME, COMPOSER_CAPSULE_INTERACTIVE_CLASS_NAME)}
        title={title}
        data-testid={testId}
      >
        {icon}
        <span className="min-w-0 truncate">{label}</span>
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="start"
        sideOffset={8}
        anchor={() =>
          triggerRef.current?.closest(COMPOSER_CAPSULE_ROW_SELECTOR) ?? triggerRef.current
        }
        className="w-(--anchor-width) [&_[data-slot=popover-viewport]]:p-1"
        data-testid={popupTestId}
      >
        {typeof children === "function" ? children(close) : children}
      </PopoverPopup>
    </Popover>
  );
}

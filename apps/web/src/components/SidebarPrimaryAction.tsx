// FILE: SidebarPrimaryAction.tsx
// Purpose: The sidebar's primary action row ("New thread", "New automation", nav rows):
//          leading glyph, label, and a trailing badge or hover shortcut.
// Layer: Sidebar UI primitive (shared by the thread sidebar and the rail layout's panels)

import type { ComponentType } from "react";

import { cn } from "~/lib/utils";
import {
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
} from "~/sidebarRowStyles";
import type { SidebarActionBadge } from "./Sidebar.logic";
import { SidebarGlyph } from "./sidebarGlyphs";
import { SidebarLeadingIcon } from "./SidebarLeadingIcon";
import { ShortcutKbd } from "./ui/kbd";
import { SidebarMenuButton, SidebarMenuItem } from "./ui/sidebar";

export function SidebarPrimaryAction({
  icon: Icon,
  iconClassName,
  label,
  onClick,
  onMouseEnter,
  onFocus,
  active: activeProp,
  disabled: disabledProp,
  shortcutLabel,
  badge,
}: {
  // Accepts both Lucide adapters and raw react-icons glyphs (rendered via SidebarGlyph).
  icon: ComponentType<{ className?: string }>;
  /** Optional optical correction for glyphs whose artwork fills more of its view box. */
  iconClassName?: string;
  label: string;
  onClick?: () => void;
  onMouseEnter?: () => void;
  onFocus?: () => void;
  active?: boolean;
  disabled?: boolean;
  shortcutLabel?: string | null;
  badge?: SidebarActionBadge | null;
}) {
  // Defaults live in the body, not the destructuring pattern: an AssignmentPattern in
  // the parameter list makes React Compiler bail out on the whole component.
  const active = activeProp ?? false;
  const disabled = disabledProp ?? false;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="sm"
        data-active={active}
        aria-current={active ? "page" : undefined}
        aria-label={label}
        className={cn(
          "group/sidebar-primary-action",
          SIDEBAR_HEADER_ROW_CLASS_NAME,
          active
            ? SIDEBAR_ROW_ACTIVE_CLASS_NAME
            : cn(SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME),
        )}
        aria-disabled={disabled || undefined}
        disabled={disabled}
        onClick={onClick}
        onMouseEnter={onMouseEnter}
        onFocus={onFocus}
      >
        <SidebarLeadingIcon size="sm" tone="text-inherit">
          <SidebarGlyph
            icon={Icon}
            variant="leading"
            {...(iconClassName ? { className: iconClassName } : {})}
          />
        </SidebarLeadingIcon>
        <span className="truncate">{label}</span>
        {badge ? (
          <span
            className="ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-md bg-muted px-1 text-ui-xs font-medium text-muted-foreground"
            aria-label={badge.accessibleLabel}
            title={badge.accessibleLabel}
          >
            {badge.text}
          </span>
        ) : shortcutLabel ? (
          <span className="ml-auto opacity-0 transition-opacity group-hover/sidebar-primary-action:opacity-100 group-focus-visible/sidebar-primary-action:opacity-100">
            <ShortcutKbd shortcutLabel={shortcutLabel} />
          </span>
        ) : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

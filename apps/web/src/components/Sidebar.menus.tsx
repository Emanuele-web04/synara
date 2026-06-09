// FILE: Sidebar.menus.tsx
// Purpose: Sidebar sort menus and the primary-action menu row.
// Layer: Sidebar UI (props-only, no store/hooks).
// Exports: ProjectSortMenu, ThreadSortMenuItems, ChatSortMenu, SidebarPrimaryAction

import { IoFilter } from "react-icons/io5";
import type { LucideIcon } from "~/lib/icons";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "../appSettings";
import { splitShortcutLabel } from "../keybindings";
import { SidebarIconButton } from "./SidebarIconButton";
import { SidebarLeadingIcon } from "./SidebarLeadingIcon";
import { SidebarGlyph } from "./sidebarGlyphs";
import { Kbd, KbdGroup } from "./ui/kbd";
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "./ui/menu";
import { SidebarMenuButton, SidebarMenuItem } from "./ui/sidebar";

const SIDEBAR_SORT_LABELS: Record<SidebarProjectSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
  manual: "Manual",
};
const SIDEBAR_THREAD_SORT_LABELS: Record<SidebarThreadSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
};

export function ProjectSortMenu({
  projectSortOrder,
  threadSortOrder,
  onProjectSortOrderChange,
  onThreadSortOrderChange,
}: {
  projectSortOrder: SidebarProjectSortOrder;
  threadSortOrder: SidebarThreadSortOrder;
  onProjectSortOrderChange: (sortOrder: SidebarProjectSortOrder) => void;
  onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
}) {
  return (
    <Menu>
      <SidebarIconButton
        render={<MenuTrigger />}
        icon={IoFilter}
        label="Sort projects"
        tooltip="Sort projects"
        tooltipSide="right"
      />
      <MenuPopup
        align="end"
        side="bottom"
        className="min-w-44 rounded-lg border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] shadow-lg"
      >
        <MenuGroup>
          <div className="px-2 py-1 sm:text-xs font-medium text-muted-foreground">
            Sort projects
          </div>
          <MenuRadioGroup
            value={projectSortOrder}
            onValueChange={(value) => {
              onProjectSortOrderChange(value as SidebarProjectSortOrder);
            }}
          >
            {(Object.entries(SIDEBAR_SORT_LABELS) as Array<[SidebarProjectSortOrder, string]>).map(
              ([value, label]) => (
                <MenuRadioItem key={value} value={value} className="min-h-7 py-1 sm:text-xs">
                  {label}
                </MenuRadioItem>
              ),
            )}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuGroup>
          <div className="px-2 pt-2 pb-1 sm:text-xs font-medium text-muted-foreground">
            Sort threads
          </div>
          <ThreadSortMenuItems
            threadSortOrder={threadSortOrder}
            onThreadSortOrderChange={onThreadSortOrderChange}
          />
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

export function ThreadSortMenuItems({
  threadSortOrder,
  onThreadSortOrderChange,
}: {
  threadSortOrder: SidebarThreadSortOrder;
  onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
}) {
  return (
    <MenuRadioGroup
      value={threadSortOrder}
      onValueChange={(value) => {
        onThreadSortOrderChange(value as SidebarThreadSortOrder);
      }}
    >
      {(Object.entries(SIDEBAR_THREAD_SORT_LABELS) as Array<[SidebarThreadSortOrder, string]>).map(
        ([value, label]) => (
          <MenuRadioItem key={value} value={value} className="min-h-7 py-1 sm:text-xs">
            {label}
          </MenuRadioItem>
        ),
      )}
    </MenuRadioGroup>
  );
}

export function ChatSortMenu({
  threadSortOrder,
  onThreadSortOrderChange,
}: {
  threadSortOrder: SidebarThreadSortOrder;
  onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
}) {
  return (
    <Menu>
      <SidebarIconButton
        render={<MenuTrigger />}
        icon={IoFilter}
        label="Sort chats"
        tooltip="Sort chats"
        tooltipSide="top"
      />
      <MenuPopup
        align="end"
        side="bottom"
        className="min-w-44 rounded-lg border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] shadow-lg"
      >
        <MenuGroup>
          <div className="px-2 py-1 sm:text-xs font-medium text-muted-foreground">Sort chats</div>
          <ThreadSortMenuItems
            threadSortOrder={threadSortOrder}
            onThreadSortOrderChange={onThreadSortOrderChange}
          />
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

export function SidebarPrimaryAction({
  icon: Icon,
  label,
  onClick,
  active = false,
  disabled = false,
  shortcutLabel,
}: {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  shortcutLabel?: string | null;
}) {
  const shortcutParts = shortcutLabel ? splitShortcutLabel(shortcutLabel) : [];

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="default"
        data-active={active}
        aria-current={active ? "page" : undefined}
        className="group/sidebar-primary-action h-9! gap-2.5 rounded-lg px-2 font-system-ui text-[length:var(--app-font-size-ui,12px)] font-normal leading-none text-foreground/89 transition-colors hover:bg-[var(--sidebar-accent)] data-[active=true]:bg-[var(--sidebar-accent-active)] data-[active=true]:text-[var(--sidebar-accent-foreground)]"
        aria-disabled={disabled || undefined}
        disabled={disabled}
        onClick={onClick}
      >
        <SidebarLeadingIcon size="md">
          <SidebarGlyph icon={Icon} variant="leading" />
        </SidebarLeadingIcon>
        <span className="truncate">{label}</span>
        {shortcutParts.length > 0 ? (
          <span className="ml-auto opacity-0 transition-opacity group-hover/sidebar-primary-action:opacity-100 group-focus-visible/sidebar-primary-action:opacity-100">
            <KbdGroup>
              {shortcutParts.map((part) => (
                <Kbd key={part}>{part}</Kbd>
              ))}
            </KbdGroup>
          </span>
        ) : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

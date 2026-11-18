// FILE: SidebarThreadSectionPicker.tsx
// Purpose: Pinned Projects and Chats navigation using the sidebar's own row primitives.
// Layer: Sidebar presentation; selection and canonical activity state belong to Sidebar.

import { useRadioGroupKeyboardNav } from "~/hooks/useRadioGroupKeyboardNav";
import { useTranslation } from "~/i18n";
import { ChatBubbleIcon, FolderIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import {
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
} from "~/sidebarRowStyles";
import { SidebarGlyph } from "./sidebarGlyphs";
import { SidebarLeadingIcon } from "./SidebarLeadingIcon";
import type { SidebarThreadSection } from "./Sidebar.uiState";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "./ui/sidebar";

const SECTIONS = ["projects", "chats"] as const;
const PRESENTATION = {
  projects: { labelKey: "workspace:sections_projects", icon: FolderIcon },
  chats: { labelKey: "workspace:general_chats", icon: ChatBubbleIcon },
} as const;

export function SidebarThreadSectionPicker({
  value,
  attention,
  onValueChange,
}: {
  value: SidebarThreadSection | null;
  attention: Readonly<Record<SidebarThreadSection, boolean>>;
  onValueChange: (value: SidebarThreadSection) => void;
}) {
  const { t } = useTranslation();
  const radioItemProps = useRadioGroupKeyboardNav({
    values: SECTIONS,
    value,
    onValueChange,
  });

  return (
    <div className="px-1.5 pt-0.5 pb-2" data-slot="sidebar-list-navigation">
      <SidebarMenu
        role="radiogroup"
        aria-label={t("workspace:sidebarThreadLists")}
        className="gap-0.5"
      >
        {SECTIONS.map((section) => {
          const { labelKey, icon } = PRESENTATION[section];
          const active = value === section;
          const label = t(labelKey);
          const description = attention[section]
            ? t("workspace:sectionNeedsAttention", { value0: label })
            : label;
          return (
            <SidebarMenuItem key={section} role="none">
              <SidebarMenuButton
                type="button"
                size="sm"
                role="radio"
                aria-checked={active}
                aria-label={description}
                title={description}
                isActive={active}
                className={cn(
                  SIDEBAR_HEADER_ROW_CLASS_NAME,
                  active
                    ? SIDEBAR_ROW_ACTIVE_CLASS_NAME
                    : cn(SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME),
                  "sidebar-list-destination h-auto py-1.5 focus-visible:ring-2 motion-reduce:transition-none",
                )}
                onClick={() => onValueChange(section)}
                {...radioItemProps(section)}
              >
                <SidebarLeadingIcon size="sm" tone="text-[var(--color-text-accent)]" aria-hidden>
                  <SidebarGlyph icon={icon} variant="leading" />
                </SidebarLeadingIcon>
                <span data-slot="sidebar-list-label" className="min-w-0 flex-1 truncate">
                  {label}
                </span>
                <span
                  aria-hidden
                  className="flex size-4 shrink-0 items-center justify-center"
                  data-slot="sidebar-list-attention"
                >
                  {attention[section] ? (
                    <span className="size-1.5 rounded-full bg-[var(--color-text-accent)] forced-colors:bg-[Highlight]" />
                  ) : null}
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </div>
  );
}

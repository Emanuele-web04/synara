// FILE: SettingsSidebarNav.tsx
// Purpose: Settings section sidebar navigation with central icons and reference-style pill rows.
// Layer: UI component
// Exports: SettingsSidebarNav

import { CentralIcon } from "~/lib/central-icons";
import { cn } from "~/lib/utils";
import { SidebarLeadingIcon } from "./SidebarLeadingIcon";
import {
  SETTINGS_NAV_GROUPS,
  SETTINGS_NAV_ITEMS,
  type SettingsSectionId,
} from "../settingsNavigation";
import {
  SETTINGS_SIDEBAR_ICON_CLASS_NAME,
  SETTINGS_SIDEBAR_ITEM_CLASS_NAME,
  SETTINGS_SIDEBAR_ITEM_LABEL_CLASS_NAME,
  SETTINGS_SIDEBAR_LIST_GAP_CLASS_NAME,
  SETTINGS_SIDEBAR_ROW_FILL_ACTIVE_CLASS_NAME,
  SETTINGS_SIDEBAR_ROW_FILL_HOVER_CLASS_NAME,
  SETTINGS_SIDEBAR_SECTION_CLASS_NAME,
  SETTINGS_SIDEBAR_SECTION_LABEL_CLASS_NAME,
} from "../settingsSidebarNavStyles";

export function SettingsSidebarNav(props: {
  activeSection: SettingsSectionId;
  onBack: () => void;
  onSelectSection: (section: SettingsSectionId) => void;
}) {
  return (
    <div className="px-1.5 py-1.5">
      <button
        type="button"
        className={cn(SETTINGS_SIDEBAR_ITEM_CLASS_NAME, SETTINGS_SIDEBAR_ROW_FILL_HOVER_CLASS_NAME)}
        onClick={props.onBack}
      >
        <SidebarLeadingIcon size="sm">
          <CentralIcon name="arrow-left" className={SETTINGS_SIDEBAR_ICON_CLASS_NAME} />
        </SidebarLeadingIcon>
        <span className={SETTINGS_SIDEBAR_ITEM_LABEL_CLASS_NAME}>Back to app</span>
      </button>

      <div className="-mx-1.5 my-1.5 h-px bg-border/70" />

      <nav aria-label="Settings sections" className="flex flex-col pt-1">
        {SETTINGS_NAV_GROUPS.map((group) => {
          const items = SETTINGS_NAV_ITEMS.filter((item) => item.group === group.id);
          if (items.length === 0) {
            return null;
          }

          return (
            <section
              key={group.id}
              aria-labelledby={`settings-nav-${group.id}`}
              className={SETTINGS_SIDEBAR_SECTION_CLASS_NAME}
            >
              <h2
                id={`settings-nav-${group.id}`}
                className={SETTINGS_SIDEBAR_SECTION_LABEL_CLASS_NAME}
              >
                {group.label}
              </h2>
              <ul className={cn("flex flex-col", SETTINGS_SIDEBAR_LIST_GAP_CLASS_NAME)}>
                {items.map((item) => {
                  const isActive = item.id === props.activeSection;
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        aria-current={isActive ? "page" : undefined}
                        className={cn(
                          SETTINGS_SIDEBAR_ITEM_CLASS_NAME,
                          isActive
                            ? SETTINGS_SIDEBAR_ROW_FILL_ACTIVE_CLASS_NAME
                            : SETTINGS_SIDEBAR_ROW_FILL_HOVER_CLASS_NAME,
                        )}
                        onClick={() => props.onSelectSection(item.id)}
                      >
                        <SidebarLeadingIcon size="sm">
                          <CentralIcon
                            name={item.icon}
                            className={SETTINGS_SIDEBAR_ICON_CLASS_NAME}
                          />
                        </SidebarLeadingIcon>
                        <span className={SETTINGS_SIDEBAR_ITEM_LABEL_CLASS_NAME}>{item.label}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </nav>
    </div>
  );
}

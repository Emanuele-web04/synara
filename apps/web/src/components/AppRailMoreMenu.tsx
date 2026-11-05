// FILE: AppRailMoreMenu.tsx
// Purpose: The rail's "…" menu (as in Codex): open Studio, choose which Spaces and single
//          projects sit in the rail as their own shortcuts, and open the rail's Customize
//          editor (order and visibility of every rail item).
// Layer: App shell component (rendered by ThreadSidebar into the rail)

import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import { APP_RAIL_GLYPH_CLASS_NAME, appRailButtonClassName, RAIL_MORE_GLYPHS } from "./AppRail";
import { SidebarIconButton } from "./SidebarIconButton";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import { useTranslation } from "~/i18n";

export type AppRailMoreMenuEntry = {
  /** Shortcut key ("space:…" / "project:…"). */
  readonly key: string;
  readonly label: string;
};

export function AppRailMoreMenu({
  spaces,
  projects,
  pinnedKeys,
  onToggleShortcut,
  onOpenStudio,
  onCustomize,
  active,
}: {
  readonly spaces: ReadonlyArray<AppRailMoreMenuEntry>;
  readonly projects: ReadonlyArray<AppRailMoreMenuEntry>;
  readonly pinnedKeys: ReadonlySet<string>;
  readonly onToggleShortcut: (key: string) => void;
  /** Null when the Studio section is hidden in Settings. */
  readonly onOpenStudio: (() => void) | null;
  /** Opens the Customize popover beside the rail. */
  readonly onCustomize: () => void;
  /** Studio has no rail button of its own, so "…" stands for it while it is open. */
  readonly active: boolean;
}) {
  const { t } = useTranslation();

  return (
    <Menu>
      <SidebarIconButton
        render={<MenuTrigger />}
        icon={active ? RAIL_MORE_GLYPHS.active : RAIL_MORE_GLYPHS.idle}
        iconClassName={APP_RAIL_GLYPH_CLASS_NAME}
        label={t("common:more")}
        tooltip={t("common:more")}
        tooltipSide="right"
        aria-current={active ? "page" : undefined}
        className={appRailButtonClassName(active)}
      />
      <ComposerPickerMenuPopup
        align="start"
        side="right"
        className="max-h-[min(36rem,80vh)] w-64 min-w-64 overflow-y-auto"
      >
        {onOpenStudio ? (
          <>
            <MenuGroup>
              <MenuItem onClick={onOpenStudio}>{t("common:hubs")}</MenuItem>
            </MenuGroup>
            <MenuSeparator />
          </>
        ) : null}
        <MenuGroup>
          <MenuGroupLabel>{t("common:spacesInTheRail")}</MenuGroupLabel>
          {spaces.map((entry) => (
            <MenuCheckboxItem
              key={entry.key}
              checked={pinnedKeys.has(entry.key)}
              onCheckedChange={() => onToggleShortcut(entry.key)}
            >
              <span className="min-w-0 truncate">{entry.label}</span>
            </MenuCheckboxItem>
          ))}
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>{t("common:projectsInTheRail")}</MenuGroupLabel>
          {projects.length === 0 ? (
            <div className="px-2.5 py-1 text-ui text-muted-foreground">
              {t("common:emptyStates_noProjects")}
            </div>
          ) : (
            projects.map((entry) => (
              <MenuCheckboxItem
                key={entry.key}
                checked={pinnedKeys.has(entry.key)}
                onCheckedChange={() => onToggleShortcut(entry.key)}
              >
                <span className="min-w-0 truncate">{entry.label}</span>
              </MenuCheckboxItem>
            ))
          )}
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuItem onClick={onCustomize}>{t("common:customize")}</MenuItem>
        </MenuGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

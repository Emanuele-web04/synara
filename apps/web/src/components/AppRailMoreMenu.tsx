// FILE: AppRailMoreMenu.tsx
// Purpose: The rail's "…" menu (as in Codex): open Studio, and choose which Spaces and single
//          projects sit in the rail as their own shortcuts.
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
  active,
}: {
  readonly spaces: ReadonlyArray<AppRailMoreMenuEntry>;
  readonly projects: ReadonlyArray<AppRailMoreMenuEntry>;
  readonly pinnedKeys: ReadonlySet<string>;
  readonly onToggleShortcut: (key: string) => void;
  /** Null when the Studio section is hidden in Settings. */
  readonly onOpenStudio: (() => void) | null;
  /** Studio has no rail button of its own, so "…" stands for it while it is open. */
  readonly active: boolean;
}) {
  return (
    <Menu>
      <SidebarIconButton
        render={<MenuTrigger />}
        icon={active ? RAIL_MORE_GLYPHS.active : RAIL_MORE_GLYPHS.idle}
        iconClassName={APP_RAIL_GLYPH_CLASS_NAME}
        label="More"
        tooltip="More"
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
              <MenuItem onClick={onOpenStudio}>Studio</MenuItem>
            </MenuGroup>
            <MenuSeparator />
          </>
        ) : null}
        <MenuGroup>
          <MenuGroupLabel>Spaces in the rail</MenuGroupLabel>
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
          <MenuGroupLabel>Projects in the rail</MenuGroupLabel>
          {projects.length === 0 ? (
            <div className="px-2.5 py-1 text-ui text-muted-foreground">No projects yet</div>
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
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

// FILE: WorktreeDefaultsSection.tsx
// Purpose: Settings › Worktrees › Defaults, above the managed worktree list. A preference of
//          the controlling app, so a computer's own settings frame does not show it.
// Layer: Settings view
// Exports: WorktreeDefaultsSection

import type { AppSettingsBinding } from "~/appSettings";
import { BooleanSettingRow } from "~/components/settings/BooleanSettingRow";
import { SettingsSection } from "~/components/settings/SettingsPanelPrimitives";

export function WorktreeDefaultsSection(binding: AppSettingsBinding) {
  return (
    <SettingsSection title="settings:worktrees_defaults">
      <BooleanSettingRow
        {...binding}
        id="setting-delete-worktree-on-archive"
        settingKey="archiveDeletesOrphanedWorktree"
        title="settings:deleteWorktreeOnArchive"
        description="settings:afterArchiveSUndoPeriodRemoveACleanWorktree"
        resetLabel="settings:deleteWorktreeOnArchive2"
        ariaLabel="settings:deleteWorktreeOnArchive"
      />
    </SettingsSection>
  );
}

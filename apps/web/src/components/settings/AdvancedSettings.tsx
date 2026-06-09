// FILE: AdvancedSettings.tsx
// Purpose: Advanced settings panel (keybindings editor, recovery/repair tools, version and release history).
// Layer: Settings UI components
// Exports: AdvancedSettings

import { type ReactNode, useState } from "react";
import { Button } from "../ui/button";
import { ChevronDownIcon } from "../../lib/icons";
import { SETTINGS_INSET_LIST_CLASS_NAME } from "../../settingsPanelStyles";
import { cn } from "../../lib/utils";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

export function AdvancedSettings({
  keybindingsConfigPath,
  keybindingsError,
  isOpeningKeybindings,
  onOpenKeybindings,
  shouldOfferRecoveryTools,
  isRepairingLocalState,
  onRepairLocalState,
  appVersion,
  onReleaseHistoryOpen,
}: {
  keybindingsConfigPath: string | null;
  keybindingsError: string | null;
  isOpeningKeybindings: boolean;
  onOpenKeybindings: () => void;
  shouldOfferRecoveryTools: boolean;
  isRepairingLocalState: boolean;
  onRepairLocalState: () => void;
  appVersion: ReactNode;
  onReleaseHistoryOpen: () => void;
}) {
  const [showRecoveryTools, setShowRecoveryTools] = useState(false);

  return (
    <div className="space-y-6">
      <SettingsSection title="Developer tools">
        <SettingsRow
          title="Keybindings"
          description="Open the persisted `keybindings.json` file to edit advanced bindings directly."
          status={
            <>
              <span className="block break-all font-mono text-[11px] text-foreground">
                {keybindingsConfigPath ?? "Resolving keybindings path..."}
              </span>
              {keybindingsError ? (
                <span className="mt-1 block text-destructive">{keybindingsError}</span>
              ) : (
                <span className="mt-1 block">Opens in your preferred editor.</span>
              )}
            </>
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!keybindingsConfigPath || isOpeningKeybindings}
              onClick={onOpenKeybindings}
            >
              {isOpeningKeybindings ? "Opening..." : "Open file"}
            </Button>
          }
        />

        <SettingsRow
          title="Recovery tools"
          description="Rebuild local project indexes without clearing existing chats when the local state gets out of sync."
          status={
            shouldOfferRecoveryTools
              ? "Visible because projects exist but no chat history is currently available."
              : "Shown automatically only when recovery actions are relevant."
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!shouldOfferRecoveryTools || isRepairingLocalState}
              onClick={onRepairLocalState}
            >
              {isRepairingLocalState ? "Repairing..." : "Repair state"}
            </Button>
          }
        >
          {shouldOfferRecoveryTools ? (
            <div className="mt-3 border-t border-border/70 pt-3">
              <button
                type="button"
                className="flex w-full items-center justify-between text-left"
                onClick={() => setShowRecoveryTools((current) => !current)}
              >
                <span className="text-xs font-medium text-muted-foreground">What this does</span>
                <ChevronDownIcon
                  className={cn(
                    "size-4 shrink-0 text-muted-foreground transition-transform",
                    showRecoveryTools && "rotate-180",
                  )}
                />
              </button>
              {showRecoveryTools ? (
                <div
                  className={cn(
                    "mt-3 px-3 py-3 text-xs text-muted-foreground",
                    SETTINGS_INSET_LIST_CLASS_NAME,
                  )}
                >
                  Rebuilds local project indexes and refreshes project snapshots. Existing chats
                  stay in place.
                </div>
              ) : null}
            </div>
          ) : null}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="About">
        <SettingsRow
          title="Version"
          description="Current application version."
          control={<code className="text-xs font-medium text-muted-foreground">{appVersion}</code>}
        />
        <SettingsRow
          title="Release history"
          description="A running log of every update, newest first. Same notes the post-update dialog shows, kept here so you can revisit them any time."
          control={
            <Button size="sm" variant="outline" onClick={onReleaseHistoryOpen}>
              View release history
            </Button>
          }
        />
      </SettingsSection>
    </div>
  );
}

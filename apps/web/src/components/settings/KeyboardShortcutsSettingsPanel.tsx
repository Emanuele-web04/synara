// FILE: KeyboardShortcutsSettingsPanel.tsx
// Purpose: Read-only keyboard-shortcuts reference for the settings screen — the same content
//          the Mod+/ sheet shows, presented as a searchable Command / Keybinding table.
// Layer: Settings UI components
// Depends on: shared shortcut-sheet builder/filter, server keybindings config, and the Kbd pill.

import type { ResolvedKeybindingsConfig } from "@synara/contracts";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Input } from "~/components/ui/input";
import { ShortcutKbd } from "~/components/ui/shortcut-kbd";
import { CentralIcon } from "~/lib/central-icons";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import {
  buildShortcutSheetSections,
  filterShortcutSheetSections,
  type ShortcutSheetContext,
} from "~/shortcutsSheet";
import {
  SETTINGS_CARD_CLASS_NAME,
  SETTINGS_CARD_ROW_CLASS_NAME,
  SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME,
  SETTINGS_CARD_ROW_TITLE_CLASS_NAME,
  SETTINGS_EMPTY_STATE_CLASS_NAME,
} from "~/settingsPanelStyles";

// Stable empty reference so the section memo doesn't re-run on every render while the
// server config query is still loading (`?? []` would allocate a fresh array each time).
const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

// The settings reference is intentionally context-free: it lists the chat/sidebar bindings
// as "available now" plus the workspace-mode set, independent of the live terminal state, so
// the page reads the same no matter which thread is focused.
const SETTINGS_SHORTCUT_CONTEXT: ShortcutSheetContext = {
  terminalFocus: false,
  terminalOpen: false,
  terminalWorkspaceOpen: false,
};

export function KeyboardShortcutsSettingsPanel() {
  const [query, setQuery] = useState("");
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const keybindings = serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;

  const sections = useMemo(
    () =>
      buildShortcutSheetSections({
        keybindings,
        // Project scripts are per-project and live only in the chat context; the settings
        // reference stays project-agnostic, so the contextual Mod+/ sheet still owns them.
        projectScripts: [],
        platform,
        context: SETTINGS_SHORTCUT_CONTEXT,
      }),
    [keybindings, platform],
  );

  const filteredSections = useMemo(
    () => filterShortcutSheetSections(sections, query),
    [sections, query],
  );

  return (
    <div className="space-y-4">
      <div className="relative w-full">
        <Input
          type="search"
          size="sm"
          variant="soft"
          nativeInput
          placeholder="Search shortcuts..."
          value={query}
          aria-label="Search shortcuts"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query.length > 0) {
              event.preventDefault();
              event.stopPropagation();
              setQuery("");
            }
          }}
          className="[&>[data-slot=input]]:pr-9"
        />
        <CentralIcon
          name="cmd-box"
          className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/70"
        />
      </div>

      {filteredSections.length > 0 ? (
        <div
          className={cn(SETTINGS_CARD_CLASS_NAME, "divide-y divide-[color:var(--color-border)]")}
        >
          <div className="flex items-center justify-between gap-4 px-3 py-2 text-[11px] font-medium text-muted-foreground">
            <span>Command</span>
            <span>Keybinding</span>
          </div>
          {filteredSections.flatMap((section) => {
            const muted = section.tone === "muted";
            return section.entries.map((entry) => (
              <div
                key={`${section.id}:${entry.id}`}
                className={cn(
                  SETTINGS_CARD_ROW_CLASS_NAME,
                  "flex items-center justify-between gap-4",
                  muted && "opacity-75",
                )}
              >
                <div className="min-w-0 space-y-0.5">
                  <div className={cn(SETTINGS_CARD_ROW_TITLE_CLASS_NAME, "truncate")}>
                    {entry.label}
                  </div>
                  <div className={cn(SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME, "truncate")}>
                    {entry.description}
                  </div>
                </div>
                <ShortcutKbd shortcutLabel={entry.shortcutLabel} groupClassName="shrink-0" />
              </div>
            ));
          })}
        </div>
      ) : (
        <div
          className={cn(
            SETTINGS_EMPTY_STATE_CLASS_NAME,
            "px-4 py-10 text-center text-sm text-muted-foreground",
          )}
        >
          No shortcuts match &ldquo;{query}&rdquo;.
        </div>
      )}
    </div>
  );
}

// The computer whose host-owned settings the main window shows. Null is this computer.
// It lives in the main window only; frames change it by navigating with `?computer=`.

import { useEffect } from "react";
import { appHistory } from "../../appNavigation";
import { isHostSettingsSection, type SettingsSectionId } from "../../settingsNavigation";
import { readWorkspaceFrame, workspaceRoute } from "./workspaceFrame";
import { useWorkspaceSessions } from "./workspaceSessions";

let selectedEnvironmentId: string | null = null;

const FORWARDED_SEARCH_KEYS = ["section", "target", "provider"] as const;

function settingsPath(search: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const key of FORWARDED_SEARCH_KEYS) {
    const value = search[key];
    if (typeof value === "string" && value) params.set(key, value);
  }
  const query = params.toString();
  return query ? `/settings?${query}` : "/settings";
}

/**
 * Host-owned sections open in the selected computer's frame. Every other section opens
 * in the main window, because it belongs to this computer. The selection survives moving
 * between sections, so returning to a host-owned section reopens the same computer.
 */
export function useSettingsComputerRoute(
  section: SettingsSectionId,
  search: Record<string, unknown>,
): void {
  const sessions = useWorkspaceSessions();
  const hostOwned = isHostSettingsSection(section);
  const computer = typeof search.computer === "string" ? search.computer : null;
  const path = settingsPath(search);

  useEffect(() => {
    const frame = readWorkspaceFrame();
    if (frame) {
      if (!hostOwned) frame.controller.navigate(path);
      return;
    }
    if (computer !== null) selectedEnvironmentId = computer === "local" ? null : computer;
    const selected = selectedEnvironmentId;
    const session = sessions.find((item) => item.host.executionScope.environmentId === selected);
    if (selected !== null && !session) selectedEnvironmentId = null;
    if (hostOwned && selected !== null && session) {
      appHistory.replace(workspaceRoute(selected, path));
      return;
    }
    if (computer !== null) appHistory.replace(path);
  }, [computer, hostOwned, path, sessions]);
}

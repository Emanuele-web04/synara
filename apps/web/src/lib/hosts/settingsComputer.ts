// Routes host settings to their execution frame and remembers the last live host.
// The controlling window owns selection and redirects to its own settings sections.

import { useRouter } from "@tanstack/react-router";
import { useLayoutEffect } from "react";
import {
  isHostSettingsSection,
  normalizeSettingsSection,
  type SettingsSectionId,
} from "../../settingsNavigation";
import { readExecutionContext } from "./executionContext";
import { readWorkspaceFrame, workspaceRoute } from "./workspaceFrame";
import { useWorkspaceSessions, type WorkspaceSession } from "./workspaceSessions";

let selectedHost: WorkspaceSession["host"] | null = null;

const FORWARDED_SEARCH_KEYS = ["section", "target", "provider", "account"] as const;

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
 * Keep the settings body unmounted until its owning execution is selected.
 * An explicit remote destination that disconnects uses the existing remote error route.
 */
export function useSettingsComputerRoute(
  section: SettingsSectionId,
  search: Record<string, unknown>,
): boolean {
  const { history } = useRouter();
  const sessions = useWorkspaceSessions();
  const frame = readWorkspaceFrame();
  const remoteEnabled = readExecutionContext()?.controller.capabilities.remoteConnections === true;
  const hostOwned = isHostSettingsSection(section);
  const computer = typeof search.computer === "string" ? search.computer : null;
  const host = sessions.find(({ host }) =>
    computer === null ? host === selectedHost : host.executionScope.environmentId === computer,
  )?.host;
  const environmentId =
    computer === "local" ? null : (computer ?? host?.executionScope.environmentId ?? null);
  const path = settingsPath(search);
  const remotePath =
    !frame && remoteEnabled && hostOwned && environmentId
      ? workspaceRoute(environmentId, path)
      : null;

  useLayoutEffect(() => {
    if (frame) return;
    selectedHost = remoteEnabled && computer !== "local" ? (host ?? null) : null;
    if (remotePath) history.replace(remotePath);
    else if (computer !== null) history.replace(path);
  }, [computer, frame, history, host, path, remoteEnabled, remotePath]);

  return frame ? !hostOwned : remotePath !== null;
}

/** Only the active outer route can redirect an execution frame to controller settings. */
export function useRemoteSettingsComputerRoute(
  path: string,
  host: WorkspaceSession["host"] | undefined,
): boolean {
  const { history } = useRouter();
  const controller =
    !readWorkspaceFrame() &&
    readExecutionContext()?.controller.capabilities.remoteConnections === true;
  const settings = controller && (path === "/settings" || path.startsWith("/settings?"));
  const search = settings
    ? Object.fromEntries(new URLSearchParams(path.slice("/settings?".length)))
    : null;
  const localPath =
    search && !isHostSettingsSection(normalizeSettingsSection(search.section))
      ? settingsPath(search)
      : null;

  useLayoutEffect(() => {
    if (!settings) return;
    // Back and Forward can select a frame without going through the picker.
    selectedHost = host ?? null;
    if (localPath) history.replace(localPath);
  }, [history, host, localPath, settings]);

  return localPath !== null;
}

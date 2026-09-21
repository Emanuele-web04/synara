import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  type ServerConfig,
  type ServerSettingsView,
} from "@synara/contracts";

import { PROJECT_IMPORT_ANNOUNCEMENT_STORAGE_KEY } from "../projectImport/useProjectImportAnnouncement";

export function createBrowserTestServerConfig(checkedAt: string): ServerConfig {
  return {
    cwd: "/repo/project",
    worktreesDir: "/repo/.codex/worktrees",
    keybindingsConfigPath: "/repo/project/.synara-keybindings.json",
    keybindings: [],
    issues: [],
    providers: [
      {
        provider: "codex",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        supportsAutoRuntimeMode: true,
        checkedAt,
      },
    ],
    availableEditors: [],
  };
}

/** onboarding marker set so the first-run welcome tour doesn't open over the surface under test */
export function createBrowserTestServerSettings(completedAt: string): ServerSettingsView {
  return { ...DEFAULT_SERVER_SETTINGS_VIEW, onboardingCompletedAt: completedAt };
}

/** marks the import announcement seen for this fixture — call after any localStorage.clear() */
export function acknowledgeProjectImportAnnouncementForTest(config: ServerConfig): void {
  localStorage.setItem(
    PROJECT_IMPORT_ANNOUNCEMENT_STORAGE_KEY,
    JSON.stringify([config.worktreesDir]),
  );
}

export function createFullscreenTestHost(): HTMLDivElement {
  const host = document.createElement("div");
  Object.assign(host.style, {
    position: "fixed",
    inset: "0",
    width: "100vw",
    height: "100vh",
    display: "grid",
    overflow: "hidden",
  });
  document.body.append(host);
  return host;
}

import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  type ServerConfig,
  type ServerSettingsView,
} from "@synara/contracts";

import { TASKS_COACHMARK } from "../components/OneTimeCoachmark";
import { FEATURE_TOUR_STORAGE_KEY } from "../featureTour/store";
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
        instanceId: "codex",
        driver: "codex",
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

/**
 * Marks startup announcements and coachmarks as seen for this established fixture's
 * installation, so they do not cover the surface under test; each has its own coverage.
 * Call after any `localStorage.clear()`.
 */
export function acknowledgeStartupAnnouncementsForTest(config: ServerConfig): void {
  localStorage.setItem(FEATURE_TOUR_STORAGE_KEY, JSON.stringify([config.worktreesDir]));
  localStorage.setItem(
    PROJECT_IMPORT_ANNOUNCEMENT_STORAGE_KEY,
    JSON.stringify([config.worktreesDir]),
  );
  localStorage.setItem(TASKS_COACHMARK.storageKey, "seen");
  localStorage.setItem("synara:activity-onboarding:v1", "seen");
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

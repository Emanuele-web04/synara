// FILE: main.constants.ts
// Purpose: Literal constants for the desktop main process (IPC channel names, updater timing, menu zoom bounds).
// Layer: Desktop main process
// Exports: IPC channel name constants, auto-update timing constants, menu zoom constants, scheme/commit-hash constants.

export const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
export const SAVE_FILE_CHANNEL = "desktop:save-file";
export const CONFIRM_CHANNEL = "desktop:confirm";
export const SET_THEME_CHANNEL = "desktop:set-theme";
export const CONTEXT_MENU_CHANNEL = "desktop:context-menu";
export const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
export const SHOW_IN_FOLDER_CHANNEL = "desktop:show-in-folder";
export const MENU_ACTION_CHANNEL = "desktop:menu-action";
export const UPDATE_STATE_CHANNEL = "desktop:update-state";
export const UPDATE_GET_STATE_CHANNEL = "desktop:update-get-state";
export const UPDATE_CHECK_CHANNEL = "desktop:update-check";
export const UPDATE_DOWNLOAD_CHANNEL = "desktop:update-download";
export const UPDATE_INSTALL_CHANNEL = "desktop:update-install";
export const NOTIFICATIONS_IS_SUPPORTED_CHANNEL = "desktop:notifications-is-supported";
export const NOTIFICATIONS_SHOW_CHANNEL = "desktop:notifications-show";

export const DESKTOP_SCHEME = "t3";
export const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;
export const COMMIT_HASH_DISPLAY_LENGTH = 12;
export const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const LOG_FILE_MAX_FILES = 10;

export const AUTO_UPDATE_STARTUP_DELAY_MS = 15_000;
export const AUTO_UPDATE_POLL_INTERVAL_MS = 4 * 60 * 60 * 1000;
export const AUTO_UPDATE_FOREGROUND_RECHECK_MIN_INTERVAL_MS = 5 * 60 * 1000;
export const AUTO_UPDATE_FOREGROUND_RECHECK_MIN_BACKGROUND_MS = 30 * 1000;
export const AUTO_UPDATE_CHECK_TIMEOUT_MS = 45 * 1000;
export const AUTO_UPDATE_DOWNLOAD_STALL_TIMEOUT_MS = 90 * 1000;
// Upper bound on how long we wait for electron-updater to release a cancelled
// download before allowing a retry, so a wedged updater promise can't block updates.
export const AUTO_UPDATE_DOWNLOAD_SETTLE_TIMEOUT_MS = 30 * 1000;
export const AUTO_UPDATE_STALLED_DOWNLOAD_CANCELLATION_SUPPRESSION_MS = 2 * 60 * 1000;
export const AUTO_UPDATE_FEED_CACHE_TTL_MS = 30 * 60 * 1000;
export const AUTO_UPDATE_FEED_REFRESH_TIMEOUT_MS = 10 * 1000;
export const BACKEND_FORCE_KILL_DELAY_MS = 8_000;
export const BACKEND_SHUTDOWN_TIMEOUT_MS = 10_000;
export const DESKTOP_UPDATE_CHANNEL = "latest";
export const DESKTOP_UPDATE_ALLOW_PRERELEASE = false;
export const BROWSER_PERF_SAMPLE_INTERVAL_MS = 5_000;
export const DESKTOP_MENU_ZOOM_FACTOR_STEP = 1.1;
export const DESKTOP_MENU_MIN_ZOOM_FACTOR = 0.25;
export const DESKTOP_MENU_MAX_ZOOM_FACTOR = 5;
export const SYNARA_BROWSER_LABEL = "Synara browser";

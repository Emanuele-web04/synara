// FILE: betaChannel.ts
// Purpose: Shared constants and types for the Stable ↔ Synara Beta handoff flow.
// Layer: Shared contracts (consumed by desktop main, server, and web settings UI)

import { Schema } from "effect";

/** Beta's data home; stable writes the import marker here, the beta server consumes it. */
export const SYNARA_BETA_HOME_DIR_NAME = ".synara-beta";
export const BETA_IMPORT_REQUEST_FILE_NAME = "import-requested.json";
export const BETA_IMPORT_RESULT_FILE_NAME = "import-result.json";

/**
 * electron-builder NSIS `guid` for beta builds. The uninstall registry key is
 * the raw GUID (no braces — see app-builder-lib NsisTarget / multiUser.nsh).
 */
export const SYNARA_BETA_WINDOWS_INSTALLER_GUID = "a8e63b48-d4f3-4db5-9e12-368107afe65d";

/** Public release listing; the newest `v*-beta.N` prerelease is the current beta build. */
export const SYNARA_BETA_RELEASES_URL =
  "https://github.com/Emanuele-web04/synara/releases?q=prerelease%3Atrue";

/** Latest stable release, offered from beta when stable Synara is not installed. */
export const SYNARA_STABLE_RELEASES_URL =
  "https://github.com/Emanuele-web04/synara/releases/latest";

/** electron-builder NSIS `guid` for stable (production) builds. */
export const SYNARA_STABLE_WINDOWS_INSTALLER_GUID = "368107a8-afe6-5db5-ab3b-d4f331684868";

/** GitHub API releases endpoint probed for the newest `v*-beta.N` tag. */
export const SYNARA_BETA_RELEASES_API_URL =
  "https://api.github.com/repos/Emanuele-web04/synara/releases?per_page=30";

/**
 * Environment overrides for the beta install flow. `SYNARA_BETA_HOME` moves the
 * beta data home everywhere it is resolved (stable's import marker, beta's own
 * base dir, the running-probe). `SYNARA_BETA_FEED_URL` points at a base URL
 * serving `beta-mac.yml` plus the files it lists; `SYNARA_BETA_INSTALL_DIR` and
 * `SYNARA_BETA_USER_DATA` relocate the app bundle and its Electron profile.
 */
export const SYNARA_BETA_HOME_ENV = "SYNARA_BETA_HOME";
export const SYNARA_BETA_FEED_URL_ENV = "SYNARA_BETA_FEED_URL";
export const SYNARA_BETA_INSTALL_DIR_ENV = "SYNARA_BETA_INSTALL_DIR";
export const SYNARA_BETA_USER_DATA_ENV = "SYNARA_BETA_USER_DATA";

/**
 * Set by stable when it launches beta, so "Switch back to Synara" reopens that
 * exact stable app with its own data home instead of guessing install paths.
 */
export const SYNARA_STABLE_EXECUTABLE_ENV = "SYNARA_STABLE_EXECUTABLE";
export const SYNARA_STABLE_HOME_ENV = "SYNARA_STABLE_HOME";

/** Tag shape of a beta release: `v<version>-beta.<N>`. */
export const BETA_RELEASE_TAG_PATTERN = /^v\d+\.\d+\.\d+-beta\.\d+$/;

export const BetaImportRequest = Schema.Struct({
  version: Schema.Literal(1),
  requestedAt: Schema.String,
  /** Absolute path of the requesting install's Synara home (e.g. `~/.synara`). */
  sourceHomeDir: Schema.String,
});
export type BetaImportRequest = typeof BetaImportRequest.Type;

export const BetaImportResult = Schema.Struct({
  version: Schema.Literal(1),
  completedAt: Schema.String,
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String),
});
export type BetaImportResult = typeof BetaImportResult.Type;

export const decodeBetaImportRequest = Schema.decodeUnknownSync(BetaImportRequest);
export const decodeBetaImportResult = Schema.decodeUnknownSync(BetaImportResult);

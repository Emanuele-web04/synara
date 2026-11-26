/**
 * The macOS privacy grants desktop control needs, in the words the user reads.
 *
 * Three surfaces have to agree on this copy — the server backend's availability
 * message, the desktop app's send-time preflight, and the web card and settings
 * panel — and they used to spell it out separately, which is how "Screen
 * Recording and Accessibility" and "Accessibility and Screen Recording" ended up
 * describing the same state in the same session. One ordering, one label per
 * grant, one place that knows what to say about a stale ad-hoc grant.
 *
 * @module computerGrants
 */
import type {
  ComputerBuildSignature,
  ComputerPermission,
  DesktopAppSnapPermissionKind,
  DesktopAppSnapSettingsPane,
  DesktopAppSnapState,
} from "@synara/contracts";

/**
 * Fixed setup order, shared with the native permission guide.
 */
export const COMPUTER_PERMISSIONS: readonly ComputerPermission[] = [
  "accessibility",
  "screenRecording",
  "inputMonitoring",
];

/**
 * The same grant set in the AppSnap helper's vocabulary. One definition keeps
 * the desktop host, the composer's setup entry, and the settings panel asking
 * for exactly these grants. Computer uses Input Monitoring for physical Escape
 * and human takeover; it does not enable AppSnap's picker chord.
 *
 * Kept as an alias, not a second list: the desktop shell and the web settings
 * import this AppSnap vocabulary directly and live outside this slice, so the
 * alias stays until those callers move to COMPUTER_PERMISSIONS.
 */
export const COMPUTER_PERMISSION_KINDS: readonly DesktopAppSnapPermissionKind[] =
  COMPUTER_PERMISSIONS;

/** A grant snapshot is evidence; an idle backend's connectivity is not. */
export function missingComputerAppSnapPermissions(
  state: Pick<
    DesktopAppSnapState,
    "accessibilityPermission" | "screenRecordingPermission" | "inputMonitoringPermission"
  >,
): readonly ComputerPermission[] {
  const grants = {
    accessibility: state.accessibilityPermission,
    screenRecording: state.screenRecordingPermission,
    inputMonitoring: state.inputMonitoringPermission,
  };
  return COMPUTER_PERMISSIONS.filter((permission) => grants[permission] !== "granted");
}

/**
 * The grants without which the desktop cannot be driven at all.
 *
 * The distinction is the difference between "stop and wait for the user" and
 * "carry on with one hand tied": Accessibility gates every synthetic event and
 * every accessibility read. Input Monitoring is required for interruptible
 * control. Screen Recording only takes away images; semantic reads remain
 * available without it.
 *
 * Retained for existing callers; the canonical check is inline in
 * computerGrantsBlockControl below.
 */
export const COMPUTER_BLOCKING_PERMISSIONS: readonly ComputerPermission[] = [
  "accessibility",
  "inputMonitoring",
];

/** Whether any of these missing grants stops the desktop being driven at all. */
export function computerGrantsBlockControl(permissions: readonly ComputerPermission[]): boolean {
  return COMPUTER_BLOCKING_PERMISSIONS.some((permission) => permissions.includes(permission));
}

/** Which page holds a grant on a macOS; the i18n key for its name is `settings:<key>`. */
export type ComputerPermissionPaneKey =
  | "accessibility"
  | "deviceControlAndDataAccess"
  | "screenRecording"
  | "screenAndSystemAudioRecording"
  | "inputMonitoring";

/** The grant's own name, which macOS has not renamed even where it renamed the page. */
const COMPUTER_PERMISSION_GRANT_LABELS: Readonly<Record<ComputerPermission, string>> = {
  accessibility: "Accessibility",
  screenRecording: "Screen Recording",
  inputMonitoring: "Input Monitoring",
};

/**
 * The macOS a version string names, or null when the string is not one.
 *
 * `process.getSystemVersion()` is the only source that answers: the Chromium
 * user agent a renderer sees is frozen at 10.15.7. The minor version is kept
 * because pages have been renamed between minors — 27.3 splits the one 27.0
 * calls a single page.
 */
function macOsVersion(version: string | null | undefined): { major: number; minor: number } | null {
  const match = /^(\d+)(?:\.(\d+))?(?:\.\d+)*$/.exec(version?.trim() ?? "");
  if (!match) return null;
  const major = Number.parseInt(match[1]!, 10);
  const minor = Number.parseInt(match[2] ?? "0", 10);
  // macOS 11 was the first versioned 11; anything below it is either the frozen
  // "10.15.7" a Chromium user agent reports or not a macOS at all, and reading
  // it as a real version would name a modern Mac's pages with 2019's names.
  if (!Number.isSafeInteger(major) || major < 11 || !Number.isSafeInteger(minor)) return null;
  return { major, minor };
}

/**
 * Which page holds a grant on this macOS, so a surface can name the page the
 * user has to open instead of the page an older version had.
 *
 * Thresholds come from the pages and from Apple's notes: macOS 27.0.1 opens
 * "Device Control and Data Access" for `Privacy_Accessibility`, and the
 * November 2026 notes say 27.3 splits that page into "System & App Protection
 * Override" and "Accessibility" — the latter is the grant's own name, and it is
 * the one this answers with from 27.3 on because a deep link opens one pane;
 * `computerPermissionSplitPaneMessageKey` names the sibling. Sequoia renamed
 * screen recording; input monitoring has never moved. A null version keeps the
 * pre-rename names, the only fallback that is a real page on some supported
 * macOS.
 */
export function computerPermissionPaneKey(
  permission: ComputerPermission,
  osVersion?: string | null,
): ComputerPermissionPaneKey {
  const version = macOsVersion(osVersion) ?? { major: 0, minor: 0 };
  switch (permission) {
    case "accessibility":
      return version.major === 27 && version.minor < 3
        ? "deviceControlAndDataAccess"
        : "accessibility";
    case "screenRecording":
      return version.major >= 15 ? "screenAndSystemAudioRecording" : "screenRecording";
    case "inputMonitoring":
      return "inputMonitoring";
  }
}

/**
 * The second page a split leaves the same grant on, or null where one page holds
 * it. macOS 27.3 splits Device Control and Data Access into "System & App
 * Protection Override" and "Accessibility", and Apple's November 2026 note does
 * not say which half files a given app, so copy that names one page for 27.3 on
 * has to name the other as well. Both titles come from that announcement: no
 * 27.3 build was available to read them off a window.
 */
export function computerPermissionSplitPaneMessageKey(
  permission: ComputerPermission,
  osVersion?: string | null,
): string | null {
  const version = macOsVersion(osVersion);
  if (permission !== "accessibility" || version === null) return null;
  const split = version.major > 27 || (version.major === 27 && version.minor >= 3);
  return split ? "settings:systemAndAppProtectionOverride" : null;
}

/** The `settings:` message a page's name is translated by; `settings:<key>`. */
export function computerPermissionPaneMessageKey(
  permission: ComputerPermission,
  osVersion?: string | null,
): string {
  return `settings:${computerPermissionPaneKey(permission, osVersion)}`;
}

/**
 * The grant a System Settings pane holds, for surfaces that hold a pane id —
 * the settings rows and the guide — rather than a grant.
 */
export function computerPermissionForPane(pane: DesktopAppSnapSettingsPane): ComputerPermission {
  switch (pane) {
    case "accessibility":
      return "accessibility";
    case "input-monitoring":
      return "inputMonitoring";
    case "screen-recording":
      return "screenRecording";
  }
}

/**
 * The service name `tccutil` files each grant under, which is not the label:
 * Screen Recording is `ScreenCapture` on the command line, and a user who types
 * the label instead gets an error rather than a reset.
 *
 * Exported because the macOS backend resets the app's own stale ad-hoc rows
 * before asking for a grant, and it has to name the services the same way this
 * copy does — two spellings of `ScreenCapture` is exactly the class of bug this
 * module exists to prevent.
 */
export const TCC_SERVICE_NAMES: Readonly<Record<ComputerPermission, string>> = {
  accessibility: "Accessibility",
  screenRecording: "ScreenCapture",
  inputMonitoring: "ListenEvent",
};

/** The missing grants in `COMPUTER_PERMISSIONS` order, deduplicated. */
export function sortComputerPermissions(
  permissions: readonly ComputerPermission[],
): readonly ComputerPermission[] {
  return COMPUTER_PERMISSIONS.filter((permission) => permissions.includes(permission));
}

/**
 * "Accessibility", or "Accessibility and Screen Recording" — the grant as macOS
 * files it, for prose about the grant itself. Copy that names a page asks
 * `computerPermissionPaneMessageKey`, because pages get renamed and grants
 * do not.
 */
export function listComputerPermissions(permissions: readonly ComputerPermission[]): string {
  const labels = sortComputerPermissions(permissions).map(
    (permission) => COMPUTER_PERMISSION_GRANT_LABELS[permission],
  );
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0]!;
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

/**
 * What to tell a user whose System Settings already shows Synara switched on
 * while the helper still reports the grant missing — or null when that cannot be
 * what happened.
 *
 * macOS pins an ad-hoc signature's grant to the binary's cdhash, so a local
 * rebuild invalidates it without changing anything the user can see. A
 * Developer ID signature keys on identifier plus team and survives rebuilds, so
 * this advice would be a red herring on a release build and is withheld there.
 * The grant is filed against the app, not the helper bundle it spawns, which is
 * why the reset names the app's identifier.
 *
 * The application does not reset grants automatically. The user can remove
 * and re-add this specific build in System Settings, or reset its own bundle
 * explicitly when the responsible identity is known.
 *
 * `bundleId` is the *responsible* app's identifier — the Synara the grant is
 * actually filed against, which `.dev` and `.canary` builds do not share with a
 * released one. It is optional because nothing can derive it: a server started
 * outside the desktop shell has no app behind it, and the desktop tells the
 * backend which flavor it is through
 * `SYNARA_DESKTOP_BUNDLE_ID_ENV`. When it is unknown the whole `tccutil`
 * sentence is withheld rather than printed with a guess, because the guess a
 * user would paste into Terminal resets a *different* Synara's grants — the one
 * they have installed — and leaves this one exactly as broken as before.
 */
export function computerStaleGrantAdvice(
  permissions: readonly ComputerPermission[],
  buildSignature: ComputerBuildSignature,
  bundleId?: string | undefined,
): string | null {
  if (buildSignature !== "adhoc") return null;
  const sorted = sortComputerPermissions(permissions);
  if (sorted.length === 0) return null;
  const base =
    "This is a locally built copy of Synara, so macOS may already list it with the switch on from " +
    "an earlier build. Remove this app from the permission list, add the current build again, " +
    "then fully quit and reopen it.";
  const responsibleBundleId = bundleId?.trim();
  if (!responsibleBundleId) return base;
  const commands = sorted
    .map((permission) => `tccutil reset ${TCC_SERVICE_NAMES[permission]} ${responsibleBundleId}`)
    .join(", then ");
  return `${base} To clear only this app's old grant, run \`${commands}\` in Terminal and grant access again.`;
}

/**
 * The whole user-facing explanation for a missing grant: what is needed, where
 * to give it, and — on an ad-hoc build only — why the switch may already look on.
 */
export function computerPermissionSetupMessage(
  permissions: readonly ComputerPermission[],
  buildSignature: ComputerBuildSignature,
  bundleId?: string | undefined,
): string {
  // No sub-path: this string is built where the reader's macOS is unknown, and
  // the page names differ by version.
  const labels = listComputerPermissions(permissions);
  const base =
    labels.length > 0
      ? `Synara needs ${labels} to control this Mac. Turn Synara on in System Settings › Privacy & Security, then try again.`
      : "Synara needs a macOS privacy permission to control this Mac. Grant it in System Settings › Privacy & Security, then try again.";
  const advice = computerStaleGrantAdvice(permissions, buildSignature, bundleId);
  return advice ? `${base} ${advice}` : base;
}

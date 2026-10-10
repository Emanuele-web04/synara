import { basename } from "node:path";

import { ComputerTargetError } from "./uiTreeTargeting.ts";

/**
 * Surfaces computer control refuses to drive or inspect in this build:
 * password managers and OS security UI. An agent that can click, type, or read
 * the accessibility tree of one of these can reach credentials and privacy
 * grants nothing else on the desktop protects, so the refusal has no override —
 * no consent flow, no per-app allowlist, no tool flag. The user's own pane
 * input is exempt the same way it is exempt from the agent lease: the person
 * at the keyboard is not a competing agent.
 *
 * Matching covers the identities the desktop actually reports. `list_apps`
 * answers bundle ids on macOS (`com.1password.1password`) and bare process
 * names elsewhere; `list_windows` answers an app name and a pid, which the
 * manager resolves back to the running app's bundle id when a name alone does
 * not match. A raw bundle id, an app name, an executable path, and a
 * `pid <n>` placeholder all feed the same matcher so a refused surface cannot
 * be laundered through a different spelling of itself.
 *
 * `computer_list_windows` still enumerates denied windows — presence is what
 * lets a caller see the surface exists without being handed its contents —
 * while every scoped read (state, element tree, zoomed capture, verify) and
 * every input path refuses with `computer_denylist_refused`.
 */
const COMPUTER_DENYLIST_BUNDLE_IDS: ReadonlySet<string> = new Set([
  "com.1password.1password",
  "com.agilebits.onepassword",
  "com.apple.keychainaccess",
  "com.apple.passwords",
  "com.apple.systempreferences",
  "com.apple.securityagent",
  "com.apple.security.authorization",
  "com.lastpass.lastpass",
  "com.bitwarden.desktop",
]);

/** Bundle-id prefixes matched verbatim, so every Dashlane variant is covered. */
const COMPUTER_DENYLIST_BUNDLE_PREFIXES: readonly string[] = [
  "com.agilebits.onepassword",
  "com.dashlane.",
];

/**
 * Application and helper process names, matched after normalization
 * (lowercased, `.app` suffix and containing directories stripped). A name
 * followed by a version or edition suffix — `1Password 8`, `1Password mini` —
 * still matches, so renaming the edition cannot launder the surface.
 */
const COMPUTER_DENYLIST_APP_NAMES: ReadonlySet<string> = new Set([
  "1password",
  "keychain access",
  "passwords",
  "system settings",
  "system preferences",
  "securityagent",
  "securityagenthelper",
  "bitwarden",
  "dashlane",
  "lastpass",
]);

/** What an identity matched, so the refusal can say which rule refused it. */
export interface ComputerDenylistMatch {
  /** The displayable identity that matched — the app name the caller sees. */
  readonly app: string;
  /** Which rule matched, e.g. `bundle id com.1password.1password`. */
  readonly matched: string;
}

function normalizeComputerAppName(raw: string): string {
  let name = raw.trim();
  // A path names the executable or the .app bundle; both reduce to the app.
  if (name.includes("/")) name = basename(name);
  if (name.toLowerCase().endsWith(".app")) name = name.slice(0, -4);
  return name.toLowerCase().replace(/\s+/g, " ");
}

function matchesComputerDenylistString(raw: string): string | undefined {
  const name = normalizeComputerAppName(raw);
  for (const denied of COMPUTER_DENYLIST_APP_NAMES) {
    if (name === denied || name.startsWith(`${denied} `)) return `app name ${denied}`;
  }
  // The same string is also tried as a bundle id: launch targets and reported
  // identities arrive in both spellings, and a name like
  // `com.dashlane.dashlanephonefinal` is only caught this way.
  const bundleId = name.replace(/\s+/g, "");
  if (COMPUTER_DENYLIST_BUNDLE_IDS.has(bundleId)) return `bundle id ${bundleId}`;
  for (const prefix of COMPUTER_DENYLIST_BUNDLE_PREFIXES) {
    if (bundleId.startsWith(prefix)) return `bundle id ${prefix}*`;
  }
  return undefined;
}

/**
 * Answer how an app identity matches the denylist, or `undefined`. Every field
 * is optional because each surface reports a different subset: a launch arg
 * may be only a name, a window row carries a name and never a bundle id.
 */
export function computerDenylistMatch(identity: {
  readonly name?: string | undefined;
  readonly bundleId?: string | undefined;
}): ComputerDenylistMatch | undefined {
  const fromName =
    identity.name === undefined ? undefined : matchesComputerDenylistString(identity.name);
  if (fromName !== undefined) {
    return { app: identity.name ?? "the target app", matched: fromName };
  }
  const fromBundle =
    identity.bundleId === undefined ? undefined : matchesComputerDenylistString(identity.bundleId);
  if (fromBundle !== undefined) {
    return { app: identity.name ?? identity.bundleId ?? "the target app", matched: fromBundle };
  }
  return undefined;
}

/**
 * The typed refusal every denylisted access shares. It extends
 * `ComputerTargetError` so the gateway's existing target-error branch keeps
 * the code on the wire; `app` names the refused surface for the audit record
 * and the message without the caller re-deriving it.
 */
export class ComputerDenylistError extends ComputerTargetError {
  /** The displayable identity that was refused — name or bundle id. */
  readonly app: string;

  constructor(app: string, matched: string) {
    super({
      code: "computer_denylist_refused",
      message:
        `${app} is on the computer-control denylist (${matched}): password managers ` +
        "and OS security surfaces are refused, with no override in this build.",
    });
    this.name = "ComputerDenylistError";
    this.app = app;
  }
}

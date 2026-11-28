import { execFileSync } from "node:child_process";

/** Only the top-level app, with its own explicit Developer ID profile, receives the group. */
export function stageMacWebAuthnProfile(input: {
  profile: string;
  entitlements: string;
  bundleId: string;
  team: string | undefined;
}): string {
  const { team, bundleId } = input;
  if (!team || !/^[A-Z0-9]{10}$/.test(team)) throw new Error("Invalid macOS signing team.");
  const profile = execFileSync("/usr/bin/security", ["cms", "-D", "-i", input.profile]);
  const field = (name: string, format: string) =>
    execFileSync("/usr/bin/plutil", ["-extract", name, format, "-o", "-", "-"], {
      input: profile,
      encoding: "utf8",
    }).trim();
  const claims = JSON.parse(field("Entitlements", "json")) as Record<string, unknown>;
  const applicationId = claims["com.apple.application-identifier"];
  const prefix = typeof applicationId === "string" ? applicationId.split(".")[0] : undefined;
  const expiry = Date.parse(field("ExpirationDate", "raw"));
  if (
    field("ProvisionsAllDevices", "raw") !== "true" ||
    !(expiry > Date.now()) ||
    claims["com.apple.developer.team-identifier"] !== team ||
    !prefix ||
    !/^[A-Z0-9]{10}$/.test(prefix) ||
    applicationId !== `${prefix}.${bundleId}`
  )
    throw new Error(
      "The passkey profile must be an unexpired Developer ID profile for this team and app.",
    );
  const group = `${applicationId}.webauthn`;
  const groups = claims["keychain-access-groups"];
  if (
    !Array.isArray(groups) ||
    !groups.some(
      (grant) =>
        typeof grant === "string" &&
        (grant === group || (grant.endsWith("*") && group.startsWith(grant.slice(0, -1)))),
    )
  )
    throw new Error("The macOS provisioning profile does not authorize this app's passkey group.");
  // plutil treats dots in key paths as separators; use PlistBuddy's literal keys.
  for (const command of [
    `Add :com.apple.application-identifier string ${applicationId}`,
    `Add :com.apple.developer.team-identifier string ${team}`,
    "Add :keychain-access-groups array",
    `Add :keychain-access-groups:0 string ${group}`,
  ])
    execFileSync("/usr/libexec/PlistBuddy", ["-c", command, input.entitlements]);
  return group;
}

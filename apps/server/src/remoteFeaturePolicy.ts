import { existsSync } from "node:fs";
import { join } from "node:path";
import { desktopFlavorFromBundleId, isBetaFeatureEnabled } from "@synara/shared/betaFeatures";

export const REMOTE_IMPORT_SUSPENSION_FILE = "remote-suspended-after-import.json";

/** TLS/owner-pairing component and packaged Electron gates passed; release qualification is separate. */
const REMOTE_V2_QUALIFIED = true;

export function remoteConnectionsUnavailableReason(stateDir?: string): string | undefined {
  const flavor = desktopFlavorFromBundleId(process.env.SYNARA_DESKTOP_BUNDLE_ID);
  if (!isBetaFeatureEnabled("remoteConnections", flavor))
    return "Remote connections are unavailable in Stable.";
  if (process.versions.bun || Number(process.versions.node.split(".")[0]) !== 24)
    return "Remote connections require the Node 24 server runtime.";
  if (flavor === "unknown" && process.env.SYNARA_REMOTE_CONNECTIONS !== "1")
    return "Set SYNARA_REMOTE_CONNECTIONS=1 to opt in to remote connections.";
  if (stateDir && existsSync(join(stateDir, REMOTE_IMPORT_SUSPENSION_FILE)))
    return "Reconnect this installation after the data import.";
  if (!REMOTE_V2_QUALIFIED)
    return "Remote protocol v2 and owner pairing are not qualified in this build.";
  return undefined;
}

export function requireRemoteConnections(stateDir?: string): void {
  const reason = remoteConnectionsUnavailableReason(stateDir);
  if (reason) throw new Error(reason);
}

export function accountProfileSyncUnavailableReason(): string | undefined {
  const flavor = desktopFlavorFromBundleId(process.env.SYNARA_DESKTOP_BUNDLE_ID);
  if (!isBetaFeatureEnabled("accountProfileSync", flavor))
    return "Account profile sync is unavailable in Stable.";
  if (process.env.SYNARA_ACCOUNT_PROFILE_SYNC !== "1")
    return "Account profile sync is unavailable until SYNARA_ACCOUNT_PROFILE_SYNC=1 is set.";
  return undefined;
}

export function requireAccountProfileSync(): void {
  const reason = accountProfileSyncUnavailableReason();
  if (reason) throw new Error(reason);
}

export function requireHostSecretsSync(): void {
  throw new Error("Host secrets sync is unavailable in this build.");
}

/**
 * sandboxCredentialMapping - the one place that maps remote-sandbox settings and
 * stored secrets to the env-var names the provider credential resolvers read.
 *
 * `ServerSettings.sandboxes.<provider>` holds the non-secret fields (apiUrl,
 * teamId, runtime, ...) in plaintext; the secret-bearing fields (apiKey, token,
 * tokenSecret, bridgeToken) belong in `ServerSecretStore`, keyed by
 * `runtime/<provider>/<field>`. Both sides — the credential resolver that builds
 * the env overlay and the `updateSettings` path that persists secrets — read this
 * table so the names stay in sync.
 *
 * @module sandboxCredentialMapping
 */
import type { SandboxSettings } from "@t3tools/contracts";

import type { CredentialedRuntimeProvider } from "./Services/RuntimeProviderCredentials.ts";

/** A sandbox setting field mapped to the provider env var it overlays. */
interface SandboxFieldMapping {
  /** Key under `ServerSettings.sandboxes.<provider>`. */
  readonly field: string;
  /** Env var the provider resolver reads. */
  readonly env: string;
  /**
   * Secret-bearing fields are stored in `ServerSecretStore` under
   * `runtime/<provider>/<field>`, never in settings.json. Non-secret fields are
   * read straight from settings.
   */
  readonly secret: boolean;
}

interface SandboxProviderMapping {
  /** Key under `ServerSettings.sandboxes`. */
  readonly settingsKey: keyof Pick<SandboxSettings, "daytona" | "vercel" | "modal" | "cloudflare">;
  readonly fields: ReadonlyArray<SandboxFieldMapping>;
}

export const SANDBOX_CREDENTIAL_MAPPING: Record<
  CredentialedRuntimeProvider,
  SandboxProviderMapping
> = {
  daytona: {
    settingsKey: "daytona",
    fields: [
      { field: "apiKey", env: "DAYTONA_API_KEY", secret: true },
      { field: "apiUrl", env: "DAYTONA_API_URL", secret: false },
      { field: "organizationId", env: "DAYTONA_ORGANIZATION_ID", secret: false },
      { field: "target", env: "DAYTONA_TARGET", secret: false },
      { field: "snapshot", env: "DAYTONA_SNAPSHOT", secret: false },
    ],
  },
  "vercel-sandbox": {
    settingsKey: "vercel",
    fields: [
      { field: "token", env: "VERCEL_TOKEN", secret: true },
      { field: "teamId", env: "VERCEL_TEAM_ID", secret: false },
      { field: "projectId", env: "VERCEL_PROJECT_ID", secret: false },
      { field: "runtime", env: "VERCEL_SANDBOX_RUNTIME", secret: false },
    ],
  },
  modal: {
    settingsKey: "modal",
    fields: [
      { field: "tokenId", env: "MODAL_TOKEN_ID", secret: true },
      { field: "tokenSecret", env: "MODAL_TOKEN_SECRET", secret: true },
      { field: "environment", env: "MODAL_ENVIRONMENT", secret: false },
    ],
  },
  cloudflare: {
    settingsKey: "cloudflare",
    fields: [
      { field: "bridgeUrl", env: "SYNARA_CLOUDFLARE_BRIDGE_URL", secret: false },
      { field: "bridgeToken", env: "SYNARA_CLOUDFLARE_BRIDGE_TOKEN", secret: true },
    ],
  },
};

/** The secret-store name for a provider's secret field (`runtime/<provider>/<field>`). */
export const sandboxSecretName = (provider: CredentialedRuntimeProvider, field: string): string =>
  `runtime/${provider}/${field}`;

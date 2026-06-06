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

import { resolveDaytonaCredentials } from "./providers/daytona/DaytonaConfig.ts";
import { resolveModalCredentials } from "./providers/modal/ModalCredentials.ts";
import { resolveVercelSandboxCredentials } from "./providers/vercelSandbox/Layers/VercelSandboxConfig.ts";
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
  /**
   * Whether the resolved env carries real credentials for this provider — the
   * same gate the provider's runtime layer uses to pick real-vs-fake. The
   * credential service runs this to answer `credentialsConfigured`, so the
   * missing-creds preflight stays in sync with what actually selects the real
   * client.
   */
  readonly credentialsConfigured: (env: Record<string, string | undefined>) => boolean;
}

// Cloudflare gates on the bridge URL + token both being present (the real
// connection's required pair). It has no `null`-returning resolver of its own, so
// the gate is inlined here to keep all four provider gates in one table.
const cloudflareCredentialsConfigured = (env: Record<string, string | undefined>): boolean =>
  typeof env.SYNARA_CLOUDFLARE_BRIDGE_URL === "string" &&
  env.SYNARA_CLOUDFLARE_BRIDGE_URL.trim().length > 0 &&
  typeof env.SYNARA_CLOUDFLARE_BRIDGE_TOKEN === "string" &&
  env.SYNARA_CLOUDFLARE_BRIDGE_TOKEN.trim().length > 0;

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
    credentialsConfigured: (env) => resolveDaytonaCredentials(env) !== null,
  },
  "vercel-sandbox": {
    settingsKey: "vercel",
    fields: [
      { field: "token", env: "VERCEL_TOKEN", secret: true },
      { field: "teamId", env: "VERCEL_TEAM_ID", secret: false },
      { field: "projectId", env: "VERCEL_PROJECT_ID", secret: false },
      { field: "runtime", env: "VERCEL_SANDBOX_RUNTIME", secret: false },
    ],
    credentialsConfigured: (env) => resolveVercelSandboxCredentials(env) !== null,
  },
  modal: {
    settingsKey: "modal",
    fields: [
      { field: "tokenId", env: "MODAL_TOKEN_ID", secret: true },
      { field: "tokenSecret", env: "MODAL_TOKEN_SECRET", secret: true },
      { field: "environment", env: "MODAL_ENVIRONMENT", secret: false },
    ],
    credentialsConfigured: (env) => resolveModalCredentials(env) !== null,
  },
  cloudflare: {
    settingsKey: "cloudflare",
    fields: [
      { field: "bridgeUrl", env: "SYNARA_CLOUDFLARE_BRIDGE_URL", secret: false },
      { field: "bridgeToken", env: "SYNARA_CLOUDFLARE_BRIDGE_TOKEN", secret: true },
    ],
    credentialsConfigured: cloudflareCredentialsConfigured,
  },
};

/** The secret-store name for a provider's secret field (`runtime/<provider>/<field>`). */
export const sandboxSecretName = (provider: CredentialedRuntimeProvider, field: string): string =>
  `runtime/${provider}/${field}`;

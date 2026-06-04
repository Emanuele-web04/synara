/**
 * RuntimeProviderCredentials - resolves the credential env map a runtime provider
 * uses to pick its real-vs-fake client.
 *
 * The provider credential resolvers (`resolveDaytonaCredentials`,
 * `resolveVercelSandboxCredentials`, `resolveModalCredentials`, and the Cloudflare
 * bridge gate) read an injectable env map defaulting to `process.env`. This
 * service produces that map for a given provider by overlaying configured values
 * onto `process.env`:
 *
 *   1. start from `process.env` (the legacy fallback — keeps behavior identical
 *      when nothing is configured),
 *   2. overlay the non-secret fields persisted in `ServerSettings.sandboxes.*`,
 *   3. overlay the secret-bearing fields read from `ServerSecretStore` by name
 *      (`runtime/<provider>/<key>`), which is where the raw tokens actually live.
 *
 * Configured values win; env is the fallback. A field left blank in settings does
 * not clobber an env var of the same name, so a credentialed shell still resolves
 * the real client when settings are empty. The raw secret never round-trips to the
 * client and is never logged: only the resolver reads it, here, to build the env
 * map the provider client consumes.
 *
 * @module RuntimeProviderCredentials
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ServerSettingsError } from "@t3tools/contracts";

import type { SecretStoreError } from "../../auth/Services/ServerSecretStore.ts";

/** The runtime providers whose credentials this service resolves. */
export type CredentialedRuntimeProvider = "daytona" | "vercel-sandbox" | "modal" | "cloudflare";

export interface RuntimeProviderCredentialsShape {
  /**
   * The credential env map for a provider: `process.env` with the provider's
   * configured non-secret settings and stored secrets overlaid on top. Feed it to
   * the provider's `resolve*Credentials(env)` so a Settings change selects the
   * real client on the next read, with `process.env` as the fallback.
   */
  readonly envFor: (
    provider: CredentialedRuntimeProvider,
  ) => Effect.Effect<Record<string, string | undefined>, ServerSettingsError | SecretStoreError>;
}

export class RuntimeProviderCredentials extends ServiceMap.Service<
  RuntimeProviderCredentials,
  RuntimeProviderCredentialsShape
>()("t3/executionRuntime/Services/RuntimeProviderCredentials") {}

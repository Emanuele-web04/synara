/**
 * RuntimeProviderCredentialsLive - builds each provider's credential env map by
 * overlaying configured settings + stored secrets onto `process.env`.
 *
 * Reads `ServerSettingsService.getSettings` live, so a Settings change is picked
 * up on the next provision a provider resolves credentials for (no env capture at
 * layer build). The secret-bearing fields come from `ServerSecretStore` by name,
 * decoded UTF-8 only long enough to place into the env map the provider client
 * consumes — the raw token is never logged and never returned to a client.
 *
 * Precedence: a configured field (non-empty settings value or present secret)
 * overrides the matching env var; a blank/absent field leaves the env var
 * untouched, so a credentialed shell still resolves the real client when nothing
 * is configured. That preserves today's env-or-fake behavior exactly.
 *
 * @module RuntimeProviderCredentialsLive
 */
import { Effect, Layer } from "effect";

import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { SANDBOX_CREDENTIAL_MAPPING, sandboxSecretName } from "../sandboxCredentialMapping.ts";
import {
  RuntimeProviderCredentials,
  type CredentialedRuntimeProvider,
  type RuntimeProviderCredentialsShape,
} from "../Services/RuntimeProviderCredentials.ts";

const decoder = new TextDecoder();

const trimToUndefined = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

const makeRuntimeProviderCredentials = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  const secretStore = yield* ServerSecretStore;

  const envFor: RuntimeProviderCredentialsShape["envFor"] = (
    provider: CredentialedRuntimeProvider,
  ) =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      const mapping = SANDBOX_CREDENTIAL_MAPPING[provider];
      const providerSettings = settings.sandboxes[mapping.settingsKey] as Record<
        string,
        string | undefined
      >;
      // Start from process.env so an unconfigured field falls through to the
      // existing env path; only configured fields overlay on top.
      const env: Record<string, string | undefined> = { ...process.env };
      for (const { field, env: envVar, secret } of mapping.fields) {
        const configured = secret
          ? trimToUndefined(
              yield* secretStore
                .get(sandboxSecretName(provider, field))
                .pipe(Effect.map((bytes) => (bytes === null ? undefined : decoder.decode(bytes)))),
            )
          : trimToUndefined(providerSettings[field]);
        if (configured !== undefined) {
          env[envVar] = configured;
        }
      }
      return env;
    });

  const credentialsConfigured: RuntimeProviderCredentialsShape["credentialsConfigured"] = (
    provider: CredentialedRuntimeProvider,
  ) =>
    envFor(provider).pipe(
      Effect.map((env) => SANDBOX_CREDENTIAL_MAPPING[provider].credentialsConfigured(env)),
    );

  return { envFor, credentialsConfigured } satisfies RuntimeProviderCredentialsShape;
});

export const RuntimeProviderCredentialsLive = Layer.effect(
  RuntimeProviderCredentials,
  makeRuntimeProviderCredentials,
);

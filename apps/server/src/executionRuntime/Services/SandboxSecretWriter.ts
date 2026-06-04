/**
 * SandboxSecretWriter - routes secret-bearing remote-sandbox settings into
 * `ServerSecretStore` and strips them from the patch persisted to settings.json.
 *
 * The remote-sandbox settings schema carries both non-secret fields (apiUrl,
 * teamId, runtime, ...) and secret-bearing fields (apiKey, token, tokenSecret,
 * bridgeToken). The non-secret fields belong in `ServerSettings`; the raw tokens
 * must NOT — `settings.json` is plaintext and round-trips to every web client on
 * `getSettings`. This writer intercepts an incoming `ServerSettingsPatch`, writes
 * each present secret field to `ServerSecretStore` by name
 * (`runtime/<provider>/<field>`), and returns a patch with those fields removed so
 * only non-secret values reach the settings file. The token is never echoed back.
 *
 * @module SandboxSecretWriter
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ServerSettingsPatch } from "@t3tools/contracts";

import type { SecretStoreError } from "../../auth/Services/ServerSecretStore.ts";

export interface SandboxSecretWriterShape {
  /**
   * Persist any secret-bearing sandbox fields in `patch` to `ServerSecretStore`
   * and return the patch with those fields stripped, ready to hand to
   * `ServerSettingsService.updateSettings`. A patch that touches no sandbox
   * secrets is returned unchanged.
   */
  readonly persistSecrets: (
    patch: ServerSettingsPatch,
  ) => Effect.Effect<ServerSettingsPatch, SecretStoreError>;
}

export class SandboxSecretWriter extends ServiceMap.Service<
  SandboxSecretWriter,
  SandboxSecretWriterShape
>()("t3/executionRuntime/Services/SandboxSecretWriter") {}

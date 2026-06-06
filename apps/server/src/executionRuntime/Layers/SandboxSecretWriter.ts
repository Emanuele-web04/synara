/**
 * SandboxSecretWriterLive - writes secret-bearing sandbox settings to
 * `ServerSecretStore` and strips them from the persisted patch.
 *
 * For each provider in the sandbox patch, the present secret-bearing fields
 * (named by {@link SANDBOX_CREDENTIAL_MAPPING}) are written to `ServerSecretStore`
 * under `runtime/<provider>/<field>` and removed from the patch so they never
 * reach `settings.json`. A field the UI sends as `""` clears the stored secret
 * (the resolver then treats it as absent and falls back to env-or-fake). The raw
 * value is never logged. Non-secret fields pass through untouched.
 *
 * @module SandboxSecretWriterLive
 */
import { Effect, Layer } from "effect";

import type { ServerSettingsPatch } from "@t3tools/contracts";

import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { SANDBOX_CREDENTIAL_MAPPING, sandboxSecretName } from "../sandboxCredentialMapping.ts";
import type { CredentialedRuntimeProvider } from "../Services/RuntimeProviderCredentials.ts";
import {
  SandboxSecretWriter,
  type SandboxSecretWriterShape,
} from "../Services/SandboxSecretWriter.ts";

const encoder = new TextEncoder();

type SandboxesPatch = NonNullable<ServerSettingsPatch["sandboxes"]>;

const PROVIDERS = Object.keys(
  SANDBOX_CREDENTIAL_MAPPING,
) as ReadonlyArray<CredentialedRuntimeProvider>;

const makeSandboxSecretWriter = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore;

  const persistSecrets: SandboxSecretWriterShape["persistSecrets"] = (patch) =>
    Effect.gen(function* () {
      const sandboxes = patch.sandboxes;
      if (sandboxes === undefined) {
        return patch;
      }

      // Clone the sandbox sub-patches so stripping secrets does not mutate the
      // caller's object.
      const nextSandboxes: Record<string, unknown> = { ...sandboxes };
      let mutated = false;

      for (const provider of PROVIDERS) {
        const mapping = SANDBOX_CREDENTIAL_MAPPING[provider];
        const providerPatch = (sandboxes as Record<keyof SandboxesPatch, unknown>)[
          mapping.settingsKey
        ];
        if (providerPatch === undefined || providerPatch === null) {
          continue;
        }
        const fields = providerPatch as Record<string, string | undefined>;
        const strippedFields: Record<string, string | undefined> = { ...fields };
        let strippedAny = false;

        for (const { field, secret } of mapping.fields) {
          if (!secret) {
            continue;
          }
          const value = fields[field];
          if (value === undefined) {
            continue;
          }
          yield* secretStore.set(sandboxSecretName(provider, field), encoder.encode(value.trim()));
          delete strippedFields[field];
          strippedAny = true;
        }

        if (strippedAny) {
          nextSandboxes[mapping.settingsKey] = strippedFields;
          mutated = true;
        }
      }

      if (!mutated) {
        return patch;
      }
      return { ...patch, sandboxes: nextSandboxes } as ServerSettingsPatch;
    });

  return { persistSecrets } satisfies SandboxSecretWriterShape;
});

export const SandboxSecretWriterLive = Layer.effect(SandboxSecretWriter, makeSandboxSecretWriter);

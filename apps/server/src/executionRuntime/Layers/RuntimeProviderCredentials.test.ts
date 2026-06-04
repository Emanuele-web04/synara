/**
 * RuntimeProviderCredentials merge/precedence test.
 *
 * Pins the contract the provider runtime layers rely on: the env map a provider
 * resolves credentials from is `process.env` with the provider's configured
 * non-secret settings and stored secrets overlaid on top, configured values
 * winning and blank/absent fields leaving the env untouched. This is what lets a
 * key entered in Settings select the real client while an unconfigured field
 * still falls through to the env-or-fake path unchanged.
 *
 * @module RuntimeProviderCredentials.test
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DeepPartial } from "@t3tools/shared/Struct";
import type { ServerSettings } from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { ServerSecretStoreLive } from "../../auth/Layers/ServerSecretStore.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { RuntimeProviderCredentials } from "../Services/RuntimeProviderCredentials.ts";
import { sandboxSecretName } from "../sandboxCredentialMapping.ts";
import { RuntimeProviderCredentialsLive } from "./RuntimeProviderCredentials.ts";

const SANDBOX_ENV_VARS = [
  "DAYTONA_API_KEY",
  "DAYTONA_API_URL",
  "DAYTONA_ORGANIZATION_ID",
  "DAYTONA_TARGET",
  "DAYTONA_SNAPSHOT",
  "VERCEL_TOKEN",
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT_ID",
  "VERCEL_SANDBOX_RUNTIME",
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
  "MODAL_ENVIRONMENT",
  "SYNARA_CLOUDFLARE_BRIDGE_URL",
  "SYNARA_CLOUDFLARE_BRIDGE_TOKEN",
] as const;

const makeLayer = (settings: DeepPartial<ServerSettings>) =>
  RuntimeProviderCredentialsLive.pipe(
    Layer.provide(ServerSettingsService.layerTest(settings)),
    // provideMerge so the test body can also seed secrets through the same store.
    Layer.provideMerge(ServerSecretStoreLive),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "runtime-provider-creds-test-" }),
    ),
    Layer.provide(NodeServices.layer),
  );

const run = <A>(
  settings: DeepPartial<ServerSettings>,
  body: Effect.Effect<A, unknown, RuntimeProviderCredentials | ServerSecretStore>,
) => body.pipe(Effect.provide(makeLayer(settings)), Effect.scoped, Effect.runPromise);

describe("RuntimeProviderCredentialsLive", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of SANDBOX_ENV_VARS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of SANDBOX_ENV_VARS) {
      const value = saved.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    saved.clear();
  });

  it("overlays non-secret settings and stored secrets onto process.env", async () => {
    process.env.DAYTONA_API_URL = "https://env.example/api";
    const env = await run(
      { sandboxes: { daytona: { apiUrl: "https://settings.example/api", target: "eu" } } },
      Effect.gen(function* () {
        const store = yield* ServerSecretStore;
        yield* store.set(
          sandboxSecretName("daytona", "apiKey"),
          new TextEncoder().encode("secret-key"),
        );
        const credentials = yield* RuntimeProviderCredentials;
        return yield* credentials.envFor("daytona");
      }),
    );

    // Settings win over the env value, the stored secret lands as the token, and
    // an unset field stays undefined.
    expect(env.DAYTONA_API_URL).toBe("https://settings.example/api");
    expect(env.DAYTONA_API_KEY).toBe("secret-key");
    expect(env.DAYTONA_TARGET).toBe("eu");
    expect(env.DAYTONA_SNAPSHOT).toBeUndefined();
  });

  it("leaves env untouched when nothing is configured (env-or-fake fallback)", async () => {
    process.env.DAYTONA_API_KEY = "env-key";
    process.env.DAYTONA_API_URL = "https://env.example/api";
    const env = await run(
      {},
      Effect.gen(function* () {
        const credentials = yield* RuntimeProviderCredentials;
        return yield* credentials.envFor("daytona");
      }),
    );

    expect(env.DAYTONA_API_KEY).toBe("env-key");
    expect(env.DAYTONA_API_URL).toBe("https://env.example/api");
  });

  it("does not clobber an env var when the settings field is blank", async () => {
    process.env.VERCEL_TEAM_ID = "env-team";
    const env = await run(
      { sandboxes: { vercel: { teamId: "   " } } },
      Effect.gen(function* () {
        const credentials = yield* RuntimeProviderCredentials;
        return yield* credentials.envFor("vercel-sandbox");
      }),
    );

    expect(env.VERCEL_TEAM_ID).toBe("env-team");
  });

  it("treats a blank stored secret as absent", async () => {
    process.env.MODAL_TOKEN_ID = "env-id";
    const env = await run(
      {},
      Effect.gen(function* () {
        const store = yield* ServerSecretStore;
        yield* store.set(sandboxSecretName("modal", "tokenId"), new TextEncoder().encode("  "));
        const credentials = yield* RuntimeProviderCredentials;
        return yield* credentials.envFor("modal");
      }),
    );

    // A blank secret must not overwrite a real env value with an empty string.
    expect(env.MODAL_TOKEN_ID).toBe("env-id");
  });
});

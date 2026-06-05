/**
 * Daytona settings-driven real-client selection.
 *
 * Pins the end-to-end credential resolution contract the Settings UI relies on:
 * when a Daytona `apiKey` is configured through settings + the secret store (no
 * `env` override, no live network), `makeDaytonaSandboxClientLayer()` resolves the
 * REAL REST client rather than the local fake. The fake client never touches
 * `HttpClient`, so a recorded HTTP request to the Daytona REST endpoint is proof
 * the real client was selected. The negative control (no key configured) records
 * no HTTP request — the fake is selected.
 *
 * @module daytona/DaytonaRuntimeLayer.realClientSelection.test
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DeepPartial } from "@t3tools/shared/Struct";
import type { ServerSettings } from "@t3tools/contracts";

import { ServerConfig } from "../../../config.ts";
import {
  ServerSecretStore,
  type SecretStoreError,
} from "../../../auth/Services/ServerSecretStore.ts";
import { ServerSecretStoreLive } from "../../../auth/Layers/ServerSecretStore.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { RuntimeProviderCredentialsLive } from "../../Layers/RuntimeProviderCredentials.ts";
import { sandboxSecretName } from "../../sandboxCredentialMapping.ts";
import { DaytonaSandboxClient } from "./DaytonaSandboxClient.ts";
import { makeDaytonaSandboxClientLayer } from "./runtimeLayer.ts";

const SANDBOX_ENV_VARS = [
  "DAYTONA_API_KEY",
  "DAYTONA_API_URL",
  "DAYTONA_ORGANIZATION_ID",
  "DAYTONA_TARGET",
  "DAYTONA_SNAPSHOT",
] as const;

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
}

/**
 * A recording HttpClient that answers `POST /sandbox` with a created sandbox and
 * 404s anything else. Records every request so the test can assert the real client
 * reached the Daytona REST API. The fake client never resolves `HttpClient`, so any
 * recorded request proves the real path was taken.
 */
const makeRecordingHttpClient = (recorded: RecordedRequest[]): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        recorded.push({
          method: request.method,
          url: request.url,
          authorization: request.headers["authorization"],
        });
        if (request.method === "POST" && request.url.includes("/sandbox")) {
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ id: "sb-real-1", state: "started" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        return HttpClientResponse.fromWeb(request, new Response("not found", { status: 404 }));
      }),
    ),
  );

/**
 * Seeds a secret into the store before the daytona client resolves credentials.
 * The dispatching client re-reads the credential env on each `create`, so the
 * secret only needs to be in place before the provision under test runs; seeding
 * it at layer-build time keeps it there for the whole test.
 */
const seedSecret = (
  name: string,
  value: string,
): Layer.Layer<never, SecretStoreError, ServerSecretStore> =>
  Layer.effectDiscard(
    Effect.flatMap(ServerSecretStore.asEffect(), (store) =>
      store.set(name, new TextEncoder().encode(value)),
    ),
  );

const makeRuntime = (
  settings: DeepPartial<ServerSettings>,
  recorded: RecordedRequest[],
  seed?: Layer.Layer<never, SecretStoreError, ServerSecretStore>,
) => {
  const credentials = seed
    ? RuntimeProviderCredentialsLive.pipe(Layer.provide(seed))
    : RuntimeProviderCredentialsLive;
  return ManagedRuntime.make(
    makeDaytonaSandboxClientLayer().pipe(
      Layer.provide(makeRecordingHttpClient(recorded)),
      Layer.provide(credentials),
      Layer.provide(ServerSettingsService.layerTest(settings)),
      Layer.provideMerge(ServerSecretStoreLive),
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "daytona-real-client-test-" })),
      Layer.provideMerge(NodeServices.layer),
    ),
  );
};

describe("Daytona settings-driven real-client selection", () => {
  const saved = new Map<string, string | undefined>();
  let runtime: ReturnType<typeof makeRuntime> | undefined;

  beforeEach(() => {
    for (const key of SANDBOX_ENV_VARS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
      runtime = undefined;
    }
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

  it("selects the REAL Daytona REST client when an apiKey is configured via settings/secret store", async () => {
    const recorded: RecordedRequest[] = [];
    runtime = makeRuntime(
      { sandboxes: { daytona: { apiUrl: "https://daytona.test/api" } } },
      recorded,
      // Seed the apiKey the way the Settings UI does: a secret in the store keyed
      // by runtime/daytona/apiKey, read back through RuntimeProviderCredentials.
      seedSecret(sandboxSecretName("daytona", "apiKey"), "settings-secret-key"),
    );
    const local = runtime;
    const sandbox = await local.runPromise(
      Effect.flatMap(DaytonaSandboxClient.asEffect(), (client) =>
        client.create({ threadId: "t-real", ports: [], snapshotId: null }),
      ),
    );

    // The real client decoded the REST response; the fake would have produced a
    // local `daytona-fake-*` id and never issued an HTTP request.
    expect(sandbox.id).toBe("sb-real-1");
    const create = recorded.find(
      (request) => request.method === "POST" && request.url.includes("/sandbox"),
    );
    expect(create?.url).toBe("https://daytona.test/api/sandbox");
    expect(create?.authorization).toBe("Bearer settings-secret-key");
  });

  it("falls back to the fake client when no apiKey is configured (no HTTP request)", async () => {
    const recorded: RecordedRequest[] = [];
    runtime = makeRuntime({}, recorded);
    const local = runtime;
    const sandbox = await local.runPromise(
      Effect.flatMap(DaytonaSandboxClient.asEffect(), (client) =>
        client.create({ threadId: "t-fake", ports: [], snapshotId: null }),
      ),
    );

    // The fake client runs locally: a synthetic id and no HTTP traffic at all.
    expect(sandbox.id).toContain("daytona-fake-");
    expect(recorded).toHaveLength(0);
  });

  it("selects the real client per provision: a key saved AFTER build takes effect with no rebuild", async () => {
    const recorded: RecordedRequest[] = [];
    // Build with a configured apiUrl but no key in place — at build time the
    // provider has no credentials, so the old build-time selection would bind the
    // fake client for the layer's whole lifetime.
    runtime = makeRuntime(
      { sandboxes: { daytona: { apiUrl: "https://daytona.test/api" } } },
      recorded,
    );
    const local = runtime;

    // First provision with no key: the fake client runs, no HTTP request.
    const before = await local.runPromise(
      Effect.flatMap(DaytonaSandboxClient.asEffect(), (client) =>
        client.create({ threadId: "t-before", ports: [], snapshotId: null }),
      ),
    );
    expect(before.id).toContain("daytona-fake-");
    expect(recorded).toHaveLength(0);

    // Save the apiKey the way the Settings UI does, into the same secret store the
    // runtime already holds — no rebuild, no restart.
    await local.runPromise(
      Effect.flatMap(ServerSecretStore.asEffect(), (store) =>
        store.set(
          sandboxSecretName("daytona", "apiKey"),
          new TextEncoder().encode("late-secret-key"),
        ),
      ),
    );

    // The next provision re-resolves credentials and selects the REAL REST client.
    const after = await local.runPromise(
      Effect.flatMap(DaytonaSandboxClient.asEffect(), (client) =>
        client.create({ threadId: "t-after", ports: [], snapshotId: null }),
      ),
    );
    expect(after.id).toBe("sb-real-1");
    const create = recorded.find(
      (request) => request.method === "POST" && request.url.includes("/sandbox"),
    );
    expect(create?.url).toBe("https://daytona.test/api/sandbox");
    expect(create?.authorization).toBe("Bearer late-secret-key");
  });
});

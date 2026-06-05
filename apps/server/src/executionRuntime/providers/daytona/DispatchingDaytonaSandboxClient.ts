/**
 * DispatchingDaytonaSandboxClient - a {@link DaytonaSandboxClient} that picks its
 * real-vs-fake backing per provision rather than once at server boot.
 *
 * The earlier wiring resolved credentials once at layer build (`Layer.unwrap`),
 * so a `DAYTONA_API_KEY` saved in Settings only took effect after a server
 * restart. This client instead re-resolves the credential env on each `create`:
 * with a key present it builds the real REST client, otherwise it uses the fake
 * (local temp dirs) client. The chosen backing is cached by the returned sandbox
 * id, so the follow-up `exec` / `startSession` / `destroy` / ... for that sandbox
 * stay on the same backend that created it.
 *
 * A call that names a sandbox id with no cached backing (a reconnect after
 * restart, or `getStatus` for an id this process never created) re-resolves the
 * env and picks fresh, so reconnect after a restart still reaches the real
 * provider when the key is configured.
 *
 * The real client is constructed on demand from the resolved `DaytonaCredentials`
 * using a single `HttpClient` captured at build; the fake client is constructed
 * once. Local/worktree threads never reach this client — it backs only the
 * `daytona` remote provider.
 *
 * @module daytona/DispatchingDaytonaSandboxClient
 */
import { Effect } from "effect";
import type { FileSystem } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { HttpClient } from "effect/unstable/http";

import type { ResolveProvisionEnv } from "../../providerCredentialLayer.ts";
import { resolveDaytonaCredentials } from "./DaytonaConfig.ts";
import { DaytonaSandboxClient, type DaytonaSandboxClientShape } from "./DaytonaSandboxClient.ts";
import { makeFakeDaytonaSandboxClientEffect } from "./FakeDaytonaSandboxClient.ts";
import { makeHttpDaytonaSandboxClient } from "./HttpDaytonaSandboxClient.ts";

/**
 * Build the dispatching client. Runs inside an effect that already carries the
 * fake client's services (`FileSystem` + `ChildProcessSpawner`) and the real
 * client's `HttpClient`, plus a `resolveEnv` effect that re-reads the credential
 * env per provision.
 */
export const makeDispatchingDaytonaSandboxClient = (resolveEnv: ResolveProvisionEnv) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const fake = yield* makeFakeDaytonaSandboxClientEffect;

    // The real client closes over the resolved `HttpClient`; build it lazily from
    // the credentials resolved for a given provision so a Settings change is
    // reflected without rebuilding the layer.
    const buildReal = (env: Record<string, string | undefined>) =>
      Effect.gen(function* () {
        const credentials = resolveDaytonaCredentials(env);
        if (credentials === null) {
          return null;
        }
        return yield* makeHttpDaytonaSandboxClient(credentials).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        );
      });

    // The backing chosen for a provision, keyed by sandbox id, so every later
    // call for that sandbox routes to the same backend that created it.
    const backingBySandbox = new Map<string, DaytonaSandboxClientShape>();

    // Resolve the credential env for this provision and pick the backing. The fake
    // is the fallback whenever no real credentials are configured.
    const selectBacking: Effect.Effect<DaytonaSandboxClientShape> = Effect.gen(function* () {
      const env = yield* resolveEnv;
      const real = yield* buildReal(env);
      return real ?? fake;
    });

    // Resolve the backing for an existing sandbox id: the cached one when this
    // process created it, else a fresh selection (reconnect after restart).
    const backingFor = (sandboxId: string): Effect.Effect<DaytonaSandboxClientShape> => {
      const cached = backingBySandbox.get(sandboxId);
      return cached !== undefined ? Effect.succeed(cached) : selectBacking;
    };

    const create: DaytonaSandboxClientShape["create"] = (input) =>
      Effect.gen(function* () {
        const backing = yield* selectBacking;
        const sandbox = yield* backing.create(input);
        backingBySandbox.set(sandbox.id, backing);
        return sandbox;
      });

    const exec: DaytonaSandboxClientShape["exec"] = (sandboxId, input) =>
      backingFor(sandboxId).pipe(Effect.flatMap((backing) => backing.exec(sandboxId, input)));

    const startSession: DaytonaSandboxClientShape["startSession"] = (sandboxId, input) =>
      backingFor(sandboxId).pipe(
        Effect.flatMap((backing) => backing.startSession(sandboxId, input)),
      );

    const exposePort: DaytonaSandboxClientShape["exposePort"] = (sandboxId, port) =>
      backingFor(sandboxId).pipe(Effect.flatMap((backing) => backing.exposePort(sandboxId, port)));

    const snapshot: DaytonaSandboxClientShape["snapshot"] = (sandboxId, label) =>
      backingFor(sandboxId).pipe(Effect.flatMap((backing) => backing.snapshot(sandboxId, label)));

    const refreshActivity: DaytonaSandboxClientShape["refreshActivity"] = (sandboxId) =>
      backingFor(sandboxId).pipe(Effect.flatMap((backing) => backing.refreshActivity(sandboxId)));

    const stop: DaytonaSandboxClientShape["stop"] = (sandboxId) =>
      backingFor(sandboxId).pipe(Effect.flatMap((backing) => backing.stop(sandboxId)));

    const getStatus: DaytonaSandboxClientShape["getStatus"] = (sandboxId) =>
      backingFor(sandboxId).pipe(Effect.flatMap((backing) => backing.getStatus(sandboxId)));

    const destroy: DaytonaSandboxClientShape["destroy"] = (sandboxId) =>
      backingFor(sandboxId).pipe(
        Effect.flatMap((backing) => backing.destroy(sandboxId)),
        Effect.ensuring(Effect.sync(() => backingBySandbox.delete(sandboxId))),
      );

    // A sandbox is remote only when the cached backing that created it is the
    // real REST client. An uncached id (reconnect after restart) is treated as
    // not-remote for injection: credential bootstrap runs at provision, not on
    // reconnect, so this gate never needs to re-resolve the env here.
    const isRemoteSandbox = (sandboxId: string): boolean =>
      backingBySandbox.get(sandboxId)?.isRemoteSandbox?.(sandboxId) ?? false;

    return {
      isRemoteSandbox,
      create,
      exec,
      startSession,
      exposePort,
      snapshot,
      refreshActivity,
      stop,
      getStatus,
      destroy,
    } satisfies DaytonaSandboxClientShape;
  });

/**
 * Services the dispatching client resolves at build: the real client's
 * `HttpClient` and the fake client's `FileSystem` + `ChildProcessSpawner`. The
 * server root satisfies all three (`FetchHttpClient.layer` + `NodeServices.layer`).
 */
export type DispatchingDaytonaSandboxClientServices =
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner;

export { DaytonaSandboxClient };

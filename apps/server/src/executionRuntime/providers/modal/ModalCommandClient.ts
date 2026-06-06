/**
 * ModalCommandClient - Layer that provides `ModalCommandTransport`, choosing the
 * real or fake backend by credential presence.
 *
 * When {@link resolveModalCredentials} finds a Modal token pair the layer wires
 * {@link makeModalRealCommandBackend}; otherwise it wires
 * {@link makeModalFakeCommandBackend}, so the execution-runtime infra builds and
 * the Phase-17 baseline contract suite runs with no credentials. The selection
 * happens once at layer build time; the rest of the Modal provider never checks
 * credentials again.
 *
 * @module ModalCommandClient
 */
import { Effect, Layer } from "effect";

import { ModalCommandTransport } from "./ModalCommandTransport.ts";
import { resolveModalCredentials, type ModalCredentials } from "./ModalCredentials.ts";
import { makeModalFakeCommandBackend } from "./ModalFakeCommandBackend.ts";
import { makeModalRealCommandBackend } from "./ModalRealCommandBackend.ts";

export interface ModalCommandClientOptions {
  /**
   * Explicit credentials. When omitted the layer resolves them from the process
   * environment; `null` forces the fake backend regardless of the environment
   * (used by the contract suite to pin the credential-free path).
   */
  readonly credentials?: ModalCredentials | null;
}

const resolveBackend = (options?: ModalCommandClientOptions) =>
  Effect.gen(function* () {
    const credentials =
      options !== undefined && "credentials" in options
        ? options.credentials
        : resolveModalCredentials();
    return credentials === null || credentials === undefined
      ? yield* makeModalFakeCommandBackend
      : yield* makeModalRealCommandBackend(credentials);
  });

export const makeModalCommandClientLive = (options?: ModalCommandClientOptions) =>
  Layer.effect(ModalCommandTransport, resolveBackend(options));

/** Default wiring: resolve credentials from the process environment. */
export const ModalCommandClientLive = makeModalCommandClientLive();

/** Pin the credential-free fake backend (contract suite, no network). */
export const ModalCommandClientFakeLive = makeModalCommandClientLive({ credentials: null });

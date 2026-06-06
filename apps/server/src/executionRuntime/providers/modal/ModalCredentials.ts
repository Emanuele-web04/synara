/**
 * ModalCredentials - Resolves whether a real Modal account is configured.
 *
 * Real Modal API calls are gated behind credentials: when `MODAL_TOKEN_ID` and
 * `MODAL_TOKEN_SECRET` are both present the adapter may talk to Modal; when
 * either is absent it falls back to the local fake backend that drives the same
 * remote mechanism without a network call. This keeps the Phase-17 baseline
 * contract test green with no credentials while still letting a credentialed
 * environment exercise the real path.
 *
 * Resolution reads the process environment directly rather than threading
 * Modal-specifics through `ServerConfig`, keeping every Modal concern inside the
 * Modal provider package.
 *
 * @module ModalCredentials
 */
export interface ModalCredentials {
  readonly tokenId: string;
  readonly tokenSecret: string;
  /** Optional Modal environment name (`MODAL_ENVIRONMENT`). */
  readonly environment: string | undefined;
}

const trimmedEnv = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * Resolve Modal credentials from an environment map (defaults to `process.env`).
 * Returns `null` when either required token is missing, signalling the adapter
 * to use the fake backend.
 */
export const resolveModalCredentials = (
  env: Record<string, string | undefined> = process.env,
): ModalCredentials | null => {
  const tokenId = trimmedEnv(env.MODAL_TOKEN_ID);
  const tokenSecret = trimmedEnv(env.MODAL_TOKEN_SECRET);
  if (tokenId === undefined || tokenSecret === undefined) {
    return null;
  }
  return {
    tokenId,
    tokenSecret,
    environment: trimmedEnv(env.MODAL_ENVIRONMENT),
  };
};

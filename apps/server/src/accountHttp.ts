// FILE: accountHttp.ts
// Purpose: The fetch every account-API call from this server goes through, so
//          polls 10-60 s apart reuse one TLS connection instead of opening one each.
// Layer: Server account transport

import { createAccountClient, type AccountClient } from "@synara/shared/account";
import { Agent } from "@effect/platform-node/Undici";

/**
 * How long an idle account-API connection is kept for reuse. Node's fetch
 * keeps one for 4 s, but every account poll is at least 10 s and at most 60 s
 * apart, so each poll paid a new TCP and TLS handshake (about 150-250 ms
 * instead of about 70 ms, measured against the account API). This outlasts
 * the slowest poll; the account API's edge keeps idle connections longer.
 */
export const ACCOUNT_KEEP_ALIVE_MS = 65_000;

/**
 * Node's own fetch with a dispatcher that keeps connections for
 * {@link ACCOUNT_KEEP_ALIVE_MS}. The `Agent` comes from undici through
 * `@effect/platform-node`, which the server already ships; Node's fetch
 * accepts it through its `dispatcher` option, so request, response and error
 * behavior stay Node's.
 */
const dispatcher = new Agent({
  keepAliveTimeout: ACCOUNT_KEEP_ALIVE_MS,
  keepAliveMaxTimeout: ACCOUNT_KEEP_ALIVE_MS,
});

// `RequestInit.dispatcher` is typed against Node's bundled undici types, a
// different copy from the package's, hence the cast; the interface is the same.
export const accountFetch = ((input, init) =>
  fetch(input, { ...init, dispatcher } as unknown as RequestInit)) as typeof fetch;

/** The account client every server path uses, on the kept-alive transport. */
export function createServerAccountClient(baseUrl: string): AccountClient {
  return createAccountClient({ baseUrl, fetch: accountFetch });
}

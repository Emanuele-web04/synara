// FILE: accountHttp.ts
// Purpose: The fetch every account-API call from this server goes through, so
//          polls 10-60 s apart reuse one TLS connection instead of opening one each.
// Layer: Server account transport

import { createAccountClient, type AccountClient } from "@synara/shared/account";
import * as undiciModule from "undici";

/**
 * How long an idle account-API connection is kept for reuse. Node's fetch
 * keeps one for 4 s, but every account poll is at least 10 s and at most 60 s
 * apart, so each poll paid a new TCP and TLS handshake (about 150-250 ms
 * instead of about 70 ms, measured against the account API). This outlasts
 * the slowest poll; the account API's edge keeps idle connections longer.
 */
export const ACCOUNT_KEEP_ALIVE_MS = 65_000;

// undici is CommonJS: under Node its exports sit on the namespace and on `default`.
const undici =
  (undiciModule as unknown as { default?: typeof undiciModule }).default ?? undiciModule;

/**
 * A dispatcher that keeps connections for {@link ACCOUNT_KEEP_ALIVE_MS}, for
 * Node's own fetch (request, response and error behavior stay Node's).
 *
 * It must be the maintained undici, the pin `apps/desktop/src/httpRuntime.ts`
 * uses for the same reason: the undici 7 bundled in Electron's Node (and the
 * 7.x that `@effect/platform-node` resolves) calls `socket.setTypeOfService`
 * unguarded on every HTTP/1 write. macOS can reject that on a socket the peer
 * has just closed, which throws outside the fetch promise and takes the
 * process down. Reusing idle sockets makes a write on a just-closed socket
 * more likely, so the kept-alive agent has to be the guarded one. undici 8
 * agents speak a newer handler interface than Node's bundled fetch;
 * `Dispatcher1Wrapper` is undici's own adapter for it.
 *
 * `undefined` under Bun (development): its `undici` is a built-in shim
 * without the adapter, and its fetch pools connections itself and ignores
 * dispatchers.
 */
function createAccountDispatcher(): object | undefined {
  if (typeof undici.Dispatcher1Wrapper !== "function") return undefined;
  return new undici.Dispatcher1Wrapper(
    new undici.Agent({
      keepAliveTimeout: ACCOUNT_KEEP_ALIVE_MS,
      keepAliveMaxTimeout: ACCOUNT_KEEP_ALIVE_MS,
    }),
  );
}

const dispatcher = createAccountDispatcher();

// `RequestInit.dispatcher` is typed against Node's bundled undici types, a
// different copy from the package's, hence the cast.
export const accountFetch = (
  dispatcher
    ? (input, init) => fetch(input, { ...init, dispatcher } as unknown as RequestInit)
    : (input, init) => fetch(input, init)
) as typeof fetch;

/** The account client every server path uses, on the kept-alive transport. */
export function createServerAccountClient(baseUrl: string): AccountClient {
  return createAccountClient({ baseUrl, fetch: accountFetch });
}

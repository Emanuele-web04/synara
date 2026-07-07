# Plan 006: Refuse unauthenticated remote binds and stop treating an unset auth token as "authorized"

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat d94f416d9..HEAD -- apps/server/src/wsRpc.ts apps/server/src/http.ts apps/server/src/main.ts apps/server/src/startupAccess.ts apps/server/src/config.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `d94f416d9`, 2026-07-07

## Why this matters

The server's WebSocket RPC control plane can spawn shells, run git/provider CLI
commands, and read/export the user's entire chat history and attachments. Today,
when the optional auth token is **not** configured (the default), the auth check
short-circuits to "authorized" and never invokes the real session-auth path — on
**every** bind, including `--host 0.0.0.0` / LAN / Tailnet. `REMOTE.md` tells
users to "always set `--auth-token` before exposing the server outside
localhost," but nothing in the code enforces or even warns about this. A user who
binds to a non-loopback interface and forgets the token exposes full remote code
execution to anyone who can reach the port (the origin check explicitly allows
requests with no `Origin` header, so a bare script can connect). This plan closes
the bypass and adds a fail-fast startup guard so misconfiguration fails safe.

## Current state

Relevant files:

- `apps/server/src/wsRpc.ts` — the `/ws` RPC upgrade route (the WebSocket control plane).
- `apps/server/src/http.ts` — GET file routes (`/api/thread-export`, `/api/editor-icon`, `/api/local-image`, `/attachments/*`, `/api/site-favicon`) gated by `isLegacyTokenAuthorized`.
- `apps/server/src/main.ts` — CLI entry: resolves config, logs startup, runs the server.
- `apps/server/src/startupAccess.ts` — host classification helpers (`isWildcardHost`, `isLoopbackHost`).
- `apps/server/src/config.ts` — `ServerConfigShape`; `authToken: string | undefined`.

The bypass in the WS route (`apps/server/src/wsRpc.ts:1228-1236`):

```ts
const legacyToken = url.searchParams.get("token");
const authenticatedSession =
  !config.authToken || legacyToken === config.authToken
    ? null
    : yield * serverAuth.authenticateWebSocketUpgrade(makeEffectAuthRequest(request));

if (!authenticatedSession) {
  return yield * rpcWebSocketHttpEffect; // <-- proceeds unauthenticated when authToken is unset
}
```

The identical logic for HTTP GET routes (`apps/server/src/http.ts:188-194`):

```ts
export function isLegacyTokenAuthorized(input: {
  readonly config: ServerConfigShape;
  readonly url: URL;
}): boolean {
  const legacyToken = input.url.searchParams.get("token");
  return !input.config.authToken || legacyToken === input.config.authToken;
}
```

Callsites of `isLegacyTokenAuthorized` in `http.ts`: lines 430, 468, 523, 566, 618 (live Effect routes) and 932 (`serveEditorIcon`, dead legacy handler — see below).

**IMPORTANT (corrected 2026-07-07 after first execution attempt):** the 5 live
Effect-route callsites **already** fall through to real auth. They do NOT hard
early-return. Actual shape (`http.ts:429-432`):

```ts
const config = yield * ServerConfig;
if (!isLegacyTokenAuthorized({ config, url })) {
  yield * requireAuthenticatedRequest; // already correct — falls through to session auth
}
```

So the ONLY code change needed for the live routes is fixing
`isLegacyTokenAuthorized` itself: today it returns `true` when no token is set,
so `if (!isLegacyTokenAuthorized(...))` is `if (!true)` → the fallthrough is
skipped and the request proceeds unauthenticated. Making the function return
`false` when no token is configured is what makes the existing, already-correct
fallthrough actually fire. **Do not modify the 5 live callsites — they are
already right.**

The 6th callsite, `serveEditorIcon` (`http.ts:926-943`), lives inside
`createHttpRequestHandler` (`http.ts:766`), a legacy raw Node `http` handler that
is **dead code in production**: `grep -rn "createHttpRequestHandler"
apps/server/src` shows it is referenced only by its own definition and
`http.test.ts`. Production uses the Effect route layers via
`main.ts → effectServer.ts → makeEffectHttpRouteLayer`. `serveEditorIcon` does a
hard `respond(401, …)` when unauthorized (no Effect context, no `ServerAuth`
available). After the function-semantics fix, that dead handler will return 401
when no token is set — which is harmless (it is unreachable in production) but
**will flip the expectations of its unit tests** in `http.test.ts` that currently
assert "no token ⇒ authorized". Those tests encode the old insecure behavior and
must be updated to the new secure behavior (see Step 2b).

Host helpers already exist (`apps/server/src/startupAccess.ts:1-8`):

```ts
export const isWildcardHost = (host: string | undefined): boolean =>
  host === "0.0.0.0" || host === "::" || host === "[::]";

export const isLoopbackHost = (host: string | undefined): boolean => {
  if (!host) return true;
  const normalized = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
};
```

The server auth policy already computes "remote reachable" from the host
(`apps/server/src/auth/Layers/ServerAuthPolicy.ts:11`):
`const remoteReachable = isWildcardHost(config.host) || !isLoopbackHost(config.host);`
— but this only shapes the descriptor; it does not gate startup.

Startup currently only logs whether auth is enabled (`apps/server/src/main.ts:337-342`):

```ts
const { authToken, devUrl, ...safeConfig } = config;
yield *
  Effect.logInfo("Synara running", {
    ...safeConfig,
    devUrl: devUrl?.toString(),
    authEnabled: Boolean(authToken),
  });
```

**Key nuance — do NOT weaken loopback/desktop UX.** The desktop app and local
loopback browser flow rely on the newer session-auth path (see
`ServerAuthPolicy.ts`: policies `desktop-managed-local` and `loopback-browser`),
not on the legacy `?token=` query param. The legacy-token short-circuit exists so
that a user who _has_ set `--auth-token` can pass `?token=…`. The bug is only the
`!config.authToken` disjunct, which means "no token set ⇒ allow". The fix keeps
"token set and matches ⇒ allow via legacy path" and otherwise **falls through to
the real auth** (`authenticateWebSocketUpgrade` / `authenticateHttpRequest`)
instead of allowing unauthenticated access.

## Commands you will need

| Purpose                | Command                                                    | Expected on success |
| ---------------------- | ---------------------------------------------------------- | ------------------- |
| Server tests (focused) | `cd apps/server && bun run test src/http.test.ts`          | all pass            |
| New auth-guard test    | `cd apps/server && bun run test src/startupAccess.test.ts` | all pass            |
| Typecheck (server)     | `cd apps/server && bun run typecheck`                      | exit 0, no errors   |
| Full test suite        | `bun run test`                                             | all pass            |

Repo rule (`AGENTS.md`): use `bun run test`, **never** `bun test`. Do not run
`bun fmt`/`bun lint`/`bun typecheck` at the root repeatedly during iteration; run
the focused commands above while working, and the full validation set once at the
end (see Done criteria).

## Scope

**In scope** (the only files you should modify/create):

- `apps/server/src/http.ts` — change `isLegacyTokenAuthorized` semantics ONLY (do not touch the 5 live callsites or `serveEditorIcon`).
- `apps/server/src/wsRpc.ts` — change the `/ws` auth decision to match.
- `apps/server/src/startupAccess.ts` — add a pure `requiresAuthForBind` helper.
- `apps/server/src/main.ts` — add the fail-fast startup guard.
- `apps/server/src/startupAccess.test.ts` — **create**; unit-test the new helper.
- `apps/server/src/http.test.ts` — update the `createHttpRequestHandler` block's token-auth expectations to the new secure behavior (Step 2b).

**Out of scope** (do NOT touch):

- `apps/server/src/auth/**` — the real session-auth implementation is correct; do
  not change how `authenticateWebSocketUpgrade`/`authenticateHttpRequest` work.
- `REMOTE.md` doc edits beyond what Step 4 specifies.
- Cookie `Secure` attribute / TLS — tracked as a separate finding (SECURITY-02),
  out of scope here.
- Any change to the legacy `?token=` behavior **when a token is set**.

## Git workflow

- Branch: `advisor/006-enforce-auth-remote-binds`
- Commit style: match `git log` (short imperative subjects, e.g.
  `Refuse unauthenticated remote binds`). One commit per step is fine.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add a pure helper that decides whether a bind requires auth

In `apps/server/src/startupAccess.ts`, add:

```ts
/**
 * A non-loopback bind is remotely reachable and must not run without an auth
 * mechanism. Loopback binds may run without a token (desktop/local browser use
 * the session-auth path, not the legacy query token).
 *
 * IMPORTANT: an UNSET host counts as remotely reachable. When `config.host` is
 * undefined, `effectServer.ts` passes only `{ port }` to the Node server
 * (see `apps/server/src/effectServer.ts:96-97`), and Node binds the
 * *unspecified* address (`::` / `0.0.0.0`) — i.e. all interfaces. So an omitted
 * host is remote, NOT loopback. `isLoopbackHost(undefined)` returns `true`, so
 * we must special-case undefined here rather than delegate to it.
 */
export const isRemoteReachableHost = (host: string | undefined): boolean =>
  host === undefined || isWildcardHost(host) || !isLoopbackHost(host);
```

(If an equivalent expression already exists inline elsewhere, still add this
named export so both the guard and any future callers share one definition.
Note `isLoopbackHost(undefined) === true` by design — that helper serves the
auth-policy descriptor; do NOT reuse it directly for the bind-reachability
decision, which must treat undefined as remote to match the actual Node bind.)

**Verify**: `cd apps/server && bun run typecheck` → exit 0.

### Step 2: Stop treating "no token configured" as authorized (function only)

In `apps/server/src/http.ts`, change `isLegacyTokenAuthorized` so an unset token
is **never** an automatic pass:

```ts
export function isLegacyTokenAuthorized(input: {
  readonly config: ServerConfigShape;
  readonly url: URL;
}): boolean {
  // Only the legacy query-token path is decided here. When no token is
  // configured, this path grants nothing; callers fall through to the real
  // session auth instead of allowing the request.
  if (!input.config.authToken) return false;
  return input.url.searchParams.get("token") === input.config.authToken;
}
```

**Do NOT modify the 5 live Effect-route callsites** (`http.ts:430,468,523,566,618`).
They already do `if (!isLegacyTokenAuthorized(...)) { yield* requireAuthenticatedRequest; }`
and already `.pipe(Effect.catchTag("AuthError", …))`. Changing the function is
sufficient to make them secure — verify by reading each one that it has the
fallthrough (it does at the commit this plan targets). If any live callsite does
a hard early-return instead of the fallthrough, that is drift — STOP and report.

**Do NOT modify `serveEditorIcon`** (`http.ts:932`) or the dead
`createHttpRequestHandler`. Leave the callsite as-is; the function change alone
makes it 401 on no-token, which is fine (it is unreachable in production).

**Verify**: `cd apps/server && bun run typecheck` → exit 0. (The focused
`http.test.ts` run will surface the legacy-handler expectation flips handled in
Step 2b — do not treat those as a failure of this step.)

### Step 2b: Update the dead legacy handler's tests to the new secure behavior

Run `cd apps/server && bun run test src/http.test.ts`. Any failing cases in the
`describe("createHttpRequestHandler", …)` block (around `http.test.ts:270`) that
asserted "no auth token ⇒ request authorized / 200" now encode the old insecure
behavior. Update those expectations to the new behavior: with no token
configured, the legacy editor-icon path responds `401`. With a token set and a
matching `?token=`, it still succeeds. Do NOT change any test that is unrelated to
the token-authorization semantics. If a failing test cannot be cleanly mapped to
"old insecure expectation → new secure expectation" (e.g. it fails for an
unrelated reason), STOP and report.

**Verify**: `cd apps/server && bun run test src/http.test.ts` → all pass.

### Step 3: Make the `/ws` route fall through to real auth instead of allowing anonymous

In `apps/server/src/wsRpc.ts`, replace the decision at lines 1228-1236:

```ts
const legacyToken = url.searchParams.get("token");
const legacyAuthorized = Boolean(config.authToken) && legacyToken === config.authToken;
const authenticatedSession = legacyAuthorized
  ? null
  : yield * serverAuth.authenticateWebSocketUpgrade(makeEffectAuthRequest(request));

if (!authenticatedSession) {
  // Reached only when the legacy token matched a configured token.
  return yield * rpcWebSocketHttpEffect;
}
```

The behavioral change: when `config.authToken` is unset, `legacyAuthorized` is
`false`, so the code now **calls `authenticateWebSocketUpgrade`** (which for
loopback/desktop policies resolves the session, and for an unauthenticated remote
client raises `AuthError`, already handled by the existing
`.pipe(Effect.catchTag("AuthError", …))` at line 1243). When the token is set and
matches, behavior is unchanged (legacy path, `authenticatedSession = null`,
proceed).

**Verify**: `cd apps/server && bun run typecheck` → exit 0.

### Step 4: Fail fast at startup on a remote bind with no auth mechanism

In `apps/server/src/main.ts`, before `yield* start;` (currently line 305), add a
guard. A remote-reachable bind is only safe if EITHER a legacy `authToken` is set
OR the server is in a mode whose session-auth policy requires bootstrap
(desktop). Keep this conservative: require an explicit auth token for a
non-loopback bind unless running in `desktop` mode.

```ts
if (isRemoteReachableHost(config.host) && !config.authToken && config.mode !== "desktop") {
  return (
    yield *
    Effect.fail(
      new StartupConfigError({
        message:
          `Refusing to bind to a non-loopback host (${config.host}) without --auth-token. ` +
          `Set --auth-token (or T3CODE_AUTH_TOKEN), or bind to localhost. See REMOTE.md.`,
      }),
    )
  );
}
```

Use whatever error/exit convention `main.ts` already uses for fatal startup
config problems — search the file for existing `Effect.fail`/`die`/process-exit
on bad config (e.g. the web-build-missing branch near line 296-303) and mirror it
exactly (same error type, same logging). If there is no existing typed startup
error, log at error level with `Effect.logError(...)` and then fail/exit the same
way that branch does. Do NOT invent a new global error-handling mechanism.

Then update `REMOTE.md`: under "Security First", add one line noting that Synara
now refuses to start on a non-loopback host without `--auth-token` (so the doc
matches the enforced behavior).

**Verify**: `cd apps/server && bun run typecheck` → exit 0.

### Step 5: Add unit tests for the new helper and the guard decision

Create `apps/server/src/startupAccess.test.ts` following the structure of an
existing server test (model it after `apps/server/src/config.test.ts` for
imports/`describe`/`it` style and the vitest runner). Cover:

- `isRemoteReachableHost("0.0.0.0")` → `true`; `isRemoteReachableHost("::")` → `true`.
- `isRemoteReachableHost("127.0.0.1")` / `"localhost"` / `"::1"` → `false`.
- **`isRemoteReachableHost(undefined)` → `true`** (an omitted host binds `::`, all interfaces — this is the security-critical case; DO NOT assert `false` here).
- `isRemoteReachableHost("192.168.1.42")` → `true`.
- A pure test of the guard predicate: assert that `(remoteReachable && !authToken && mode !== "desktop")` is `true` for BOTH a `0.0.0.0` + no-token + `web` combo AND an **undefined-host + no-token + `web`** combo (the default web start), and `false` for `localhost` + no-token, `0.0.0.0` + token, and `undefined`/`0.0.0.0` + no-token + `desktop`. If the guard predicate is inlined in `main.ts`, extract it into a small exported pure function `requiresAuthTokenForBind({ host, authToken, mode })` in `startupAccess.ts` and test that instead (preferred — keeps the decision unit-testable).

If `http.test.ts` already has a harness that constructs requests against these
routes, add two cases there: (a) unset token + no session cookie on
`/api/local-image` → not authorized (401/403); (b) set token + matching
`?token=` → authorized. If no such harness exists, note that in the plan status
and rely on the helper tests.

**Verify**: `cd apps/server && bun run test src/startupAccess.test.ts` → all pass.

## Test plan

- New file `apps/server/src/startupAccess.test.ts`: happy/edge cases for
  `isRemoteReachableHost` and the auth-required predicate (see Step 5).
- Extend `apps/server/src/http.test.ts` only if a route-level test harness already
  exists there; add the authorized/unauthorized fallthrough cases.
- Structural pattern to follow: `apps/server/src/config.test.ts`.
- Verification: `cd apps/server && bun run test src/startupAccess.test.ts src/http.test.ts` → all pass, including the new cases.

## Done criteria

ALL must hold:

- [ ] `cd apps/server && bun run typecheck` exits 0.
- [ ] `bun run test` exits 0; new tests in `startupAccess.test.ts` exist and pass.
- [ ] `grep -n "!input.config.authToken\|!config.authToken" apps/server/src/http.ts apps/server/src/wsRpc.ts` shows the unset-token disjunct is gone from the "authorized" decisions (it may still appear inside the new guard/`isRemoteReachableHost` logic, but must NOT grant access).
- [ ] Manual reasoning check recorded in the PR description: with no `--auth-token`, a `--host 0.0.0.0 --mode web` start fails at startup; a `--host 127.0.0.1` start still works.
- [ ] `bun run fmt` and `bun run lint` pass (final validation pass).
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row for 006 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- The code at `wsRpc.ts:1228-1236` or `http.ts:188-194` does not match the
  excerpts above (drift since this plan was written).
- Removing the `!config.authToken` pass causes existing desktop/loopback tests to
  fail in a way that suggests those flows actually depend on the legacy-token
  short-circuit rather than the session-auth path — this means the auth model
  differs from this plan's assumption; report the failing test and stop.
- You cannot find how `main.ts` signals a fatal startup config error (no existing
  pattern to mirror) — report and stop rather than inventing one.
- A **live Effect-route** callsite (`http.ts:430,468,523,566,618`) does a hard
  early-return instead of the `yield* requireAuthenticatedRequest` fallthrough —
  that is drift from what this plan expects; report and stop. (The dead
  `serveEditorIcon` handler at line 932 is expected to hard-return and is
  deliberately left unchanged — that is NOT a stop condition.)

## Maintenance notes

- If a future TLS/proxy change (SECURITY-02) sets `Secure` cookies, the startup
  guard's `mode !== "desktop"` carve-out may need to widen to "desktop OR
  TLS-terminated" — revisit `requiresAuthTokenForBind` then.
- Reviewer should scrutinize: that no route silently returns 200 for an
  unauthenticated remote request after the change, and that loopback desktop
  startup is unaffected (the session-auth path still authorizes).
- Deferred out of scope: cookie `Secure` flag and a first-class `--tls` option
  (SECURITY-02), Electron `will-attach-webview` hardening (SECURITY-03).

# Configure the remote MVP

This is the handoff from implementation to the first real MacBook ↔ Mac Mini test. Use the same build from `codex/cloudflare-remote-mvp` on both computers. Local qualification is recorded in [STATUS.md](STATUS.md); it does not substitute for a live Cloudflare/WorkOS test.

## What must run

| Component                       | Where it runs                                     | What the operator supplies                                                |
| ------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------- |
| Synara account API (`apps/api`) | Bun in a Cloudflare Container behind public HTTPS | Public URL, environment variables and persistent signing key              |
| WorkOS AuthKit                  | WorkOS                                            | Application/client ID, API key, authentication settings                   |
| PostgreSQL                      | Supabase PostgreSQL, reachable by the account API | A persistent database and connection URL                                  |
| Cloudflare Tunnel               | Cloudflare plus the bundled connector on the Mini | Active DNS zone and scoped API token, kept on the account API             |
| Synara                          | Both Macs, separate installation homes            | Same account/workspace and a Beta/Canary build with remote access enabled |

There is no Synara traffic-relay service to deploy. The shared account API is
now hosted on Cloudflare Containers for the profiles trial; see the
[deployed trial and evidence](../cloudflare-profiles/READINESS.md). This does not
configure remote tunnel provisioning, test enrollment or prove two-Mac access.
Railway is excluded. Avatar storage and iOS work are not required for remote.

## Current trial readiness — 2026-09-29

The shared API is `https://synara-account-api-trial.synara-orgs.workers.dev`.
Supabase connectivity, a real WorkOS login and the migrated account session
have been verified. The remote-binding forwarding fix and all five remote
bindings are deployed. A dedicated account-owned token permits cloudflared
tunnel management in Synara Orgs and DNS edits only in `trysynara.com`; it has
no expiration, as requested by the operator, and can be revoked manually.
It is stored in Worker secrets and a protected operator file outside the repo.
Only the operator's trial WorkOS user is enrolled. The API Container restart
completed healthy. Both isolated Mac instances now have matching WorkOS user
and organization identities. Creating the Mini's code automatically provisioned
a healthy named tunnel and proxied DNS record. The real two-Mac pairing,
connection and remote file-read flow passed with a DNS override limited to the
test controller process while resolver caches propagate. Normal DNS and
revocation qualification remain pending. After the initial remote
read, the MacBook UI stayed on `Connecting…` despite a healthy tunnel. The
remote renderer was subscribing to two local-only device/computer streams;
the server's rejection triggered a global reconnect. The adapter now skips
these remote subscriptions; regression tests and over a minute of live UI
observation passed. A controlled connector restart found that a temporary
absence of published routes stopped retries permanently. This now uses the
existing reconnect backoff, with a passing supervisor/registry regression.
The controller supervisor also needed to live in the router's server-lifetime
scope. With both fixes, the existing MacBook page recovered after controller
restart and a forced connector crash without reload or manual connection;
fresh file reads succeeded. The strengthened built-workspace E2E passes.
See [the execution record](STATUS.md) for measured timings, test-suite
limitations and the remaining live checks.

`trysynara.com` is now active in Synara Orgs on Cloudflare's Free website plan;
the account separately has Workers Paid. After explicit operator confirmation,
Namecheap nameservers changed to `cecelia.ns.cloudflare.com` and
`eric.ns.cloudflare.com`. The registry and Cloudflare zone API confirm the change.
All ten records from the complete Vercel dashboard inventory were reproduced,
including mail, verification and CAA records. Vercel ALIAS records became
DNS-only CNAMEs with the same targets, with apex flattening on Cloudflare.
The website remains on Vercel; HTTPS returned 200 for `www` and Vercel Analytics
retains its history. No DS delegation existed before the switch.

Keep the old Vercel zone during propagation. Some recursive resolvers initially
retained the old nameservers. Direct port-53 queries from this Mac were
intercepted by a recursive resolver and do not constitute authoritative checks.
Record preservation and website HTTPS have been verified. For the newly created
tunnel hostname, Cloudflare and Google DNS-over-HTTPS return Cloudflare while
the Mini's system resolver still returns the old Vercel wildcard. A probe using
the public DNS result with normal TLS validation passed `/health` and confirmed
404 for app/admin paths; it does not prove the normal resolver path. Mail
delivery and resolution from the MacBook's network still need live checks.

Use `CLOUDFLARE_TUNNEL_DOMAIN=trysynara.com`: generated hostnames are one label
below it, within ordinary wildcard certificate coverage. The API creates only
the generated tunnel CNAMEs and refuses unrelated record collisions.
The token's DNS permission applies to the whole selected zone; Cloudflare does
not restrict this token to the generated record names.

[Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
can test transport without moving DNS, but this branch's managed allocation
flow does not use them. A Quick Tunnel smoke test would not qualify automatic
provisioning, persisted routes or managed connector recovery.
A separate live transport proof has now passed with synthetic credentials;
see [its scope and DNS caveat](STATUS.md#live-quick-tunnel-transport-proof).
This does not add Quick Tunnel pairing to the app.

## Configuration in dependency order

1. Reuse the existing Supabase Synara project and dedicated account role configured for the profiles trial. Account tables use default-deny RLS and deny Data API roles; preserve the sponsor tables and their enabled Data API. `DATABASE_URL` is already a Cloudflare secret with verified TLS. Do not point automated test suites at this database. See [database instructions](../../../apps/api/README.md#supabase-postgresql-with-workos).
2. Reuse the WorkOS Staging application already configured for this trial. See [the API setup instructions](../../../apps/api/README.md#dashboard-setup) when recreating it. Keep `IDENTITY_PROVIDER=workos`, `WORKOS_API_KEY`, and `WORKOS_CLIENT_ID`. Magic Auth and the loopback redirect are configured. Leave issuer/JWKS overrides unset for ordinary WorkOS discovery. Use the same application for both Macs.
3. Reuse the deployed API origin above. `ACCOUNT_BASE_URL` is that origin; `API_PUBLIC_URL` is the exact same origin plus `/api/v1`. Preserve the existing `API_SIGNING_KEY` across redeploys and keep it in Worker secrets. The ingress Worker sets `TRUSTED_PROXY_HOPS=1` for its sanitized proxy chain.
4. Set all four Cloudflare variables from [the operations guide](../../cloudflare-remote.md#test-service-configuration): account ID, zone ID, API token and tunnel domain. Use an active zone with HTTPS certificate coverage for one generated label beneath the domain. Grant tunnel administration for that account and DNS administration for that zone. Synara creates named tunnels, ingress configuration and DNS records automatically; do not manually create a tunnel for each device or copy an administrative token to a Mac.
5. Deploy the Worker with remote-binding forwarding and install the complete runtime configuration using [the Cloudflare deployment instructions](../../../apps/api/cloudflare/README.md). Restart the Container after changing bindings; updating Worker secrets alone does not update a running API process. `GET /api/v1/instance` and `GET /api/v1/keys/jwks` should succeed over public HTTPS; these are discovery checks, not proof of a working login or tunnel.
6. On both Macs set `SYNARA_ACCOUNT_URL` to the API origin, without `/api/v1`, in the environment used to launch Synara. Restart the application after changing it. An unset value uses the built-in hosted API, so configuring another API alone does not redirect the app to it. Sign in to the same account and workspace on both Macs.
7. Copy that test account's WorkOS user ID into the API's `REMOTE_TEST_USER_IDS`, then restart the API. Do this before creating the first pairing code. Empty enrollment deliberately refuses remote access. This allowlist is for the internal MVP; it is not a subscription check.
8. Use **Hosts & devices** on the Mini to create a code. Enter it on the MacBook, compare the displayed identity groups, request access, and approve the exact MacBook device fingerprint on the Mini. Press **Connect** on the MacBook. Credentials for WorkOS, PostgreSQL and Cloudflare administration stay on the API; the app receives only its own session/device/tunnel credentials.

Stable deliberately refuses remote connections. For an unpackaged development server use Node 24 and `SYNARA_REMOTE_CONNECTIONS=1`; do not run that server under Bun. A packaged Beta/Canary supplies its runtime and connector. Keep the Mini powered, online and awake with Synara running for unattended access.

## What the first live test must prove

- A new login and host link complete with real WorkOS, including session refresh. A user outside the test allowlist cannot provision or pair.
- The API creates a named tunnel and proxied DNS record without manual per-host setup. The generated HTTPS endpoint becomes reachable from a different network; unrelated app/admin paths are unavailable.
- Code lookup alone does not grant access. Expired, cancelled and replayed codes are rejected; the approved device connects with the pinned host identity.
- A temporary failure during pairing allows retry of the already reviewed code until expiry. Cancelling or forgetting clears the local pending state; a new code starts a new pairing.
- Disconnecting/reconnecting the network, restarting the connector/app and sleeping/waking the Mini recover without repeating a completed pairing. Existing execution-host work remains recoverable. Commands are not blindly replayed.
- Revoking the device or unlinking the host closes access. The API authorization lease expires during an API outage. Reconnection cannot bypass revocation.
- A declared-duration unattended run covers credential renewal; record actual connection and recovery timings. “24/7” requires an available Mini and measured recovery, not just a passing local fixture.

## Remaining boundary

For the **internal two-Mac MVP**, service configuration and managed provisioning
are verified, and pairing/connection/file reading passed with the test DNS
override. Controller restart and connector crash recovery also passed.
Remaining work is normal-path DNS resolution, live revocation, sleep/wake,
authorization-outage and unattended qualification. The repository contains the connector,
automatic allocation, code rendezvous, approval, trust persistence, reconnect
and revocation paths.

For a **customer launch**, also connect an authoritative paid entitlement source and qualify the signed distribution on supported platforms. `REMOTE_TEST_USER_IDS` must not be presented as payment enforcement. Billing integration is separate from proving the remote MVP and has not been implemented by this task.

# @synara/api

The Synara account service: WorkOS AuthKit for identity, plus account/host
routes under `/api/v1`.

It is a **self-hosting-first, opt-in** component. Local desktop use works without
it; account features and managed Remote use need a configured deployment. The
account API itself runs only where an operator starts or deploys it.

## Off by default, and no secrets in this repo

- **No account API instance runs unless an operator starts one.** Execution
  hosts with Remote available, or with strict remote-policy checking enabled,
  perform bounded public deployment-policy reads described below. Those reads
  establish authorization policy; they do not sign in a user or send diagnostics.
- **With `IDENTITY_PROVIDER=workos` (the default), `WORKOS_API_KEY` and
  `WORKOS_CLIENT_ID` are required**; the dev provider needs neither and refuses
  to coexist with a real key.
- **The CLI is gated on `SYNARA_ACCOUNT_URL`.** `synara auth` (host linking)
  and `synara status` only talk to an account service when that variable (or
  `synara auth --account-url`) names one. Unset, `synara status` prints
  "account features are not configured" and the CLI never opens a socket to
  anything. Sign-in itself is app-only.
- **Identity login starts when the person chooses to sign in.** The app can
  fall back to the hosted account service in `packages/shared/src/account.ts`;
  set `SYNARA_ACCOUNT_URL` explicitly for an operator-managed deployment. Public
  Remote policy checks can precede login and remain independent of that login.
- **No credentials are committed.** Every secret is read from the environment at
  boot (see `src/config.ts`). `apps/api/.env` is gitignored; `.env.example`
  carries names and comments only, never values. Host and device tokens live on
  the operator's machine under `<synara home>/account-credentials.json` at mode
  `0600`, never in the repository.

## Polar / Synara Pro Remote subscriptions

Billing supports isolated sandbox and production environments and is **off by
default**. Production payments require a separate explicit interlock. This code
change does not activate production billing or paid remote-access enforcement.
The sandbox campaign configured for qualification is recorded below.

| Product decision  | Configuration                                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Local use         | Free; local coding, local chats and local workspace access do not require Pro.                                              |
| Synara Pro        | All Remote functionality requires Pro; local desktop use stays free, with ownership and device approval checked separately. |
| Monthly           | USD 7.99, recurring monthly (`799` minor units).                                                                            |
| Annual            | USD 84.99, recurring annually (`8499` minor units).                                                                         |
| Tax               | Exclusive: applicable tax is added at checkout.                                                                             |
| Introductory code | 50% off the first monthly payment only; no annual discount or permanent reduced renewal price.                              |

The iPhone/iPad app remains a free companion, with no in-app purchase flow here.
A subscription never authorizes a host or device by itself, revokes a pairing,
or deletes chat history. `POLAR_REMOTE_ACCESS_ENFORCED` is a separate, strict
boolean and defaults to `false`; enabling it requires configured billing and
applies the paid-access check to remote operations. Keep it off during this
preparation. Billing refusals must remain distinct from ownership refusals such
as `not_host_owner`. With paid enforcement off, the existing beta/test-user
rollout controls remote admission. With it on, the commercial gate takes
precedence: neither beta access nor a test-user allowlist bypasses the paid
check. Ownership, organization membership and device approval still apply.

### Execution-host policy and manual paid rollout

Pro covers all official Remote ingress, including managed tunnels, LAN/Tailscale,
SSH forwarding, HTTP/file access, WebSocket sessions and remote UI frames. A
local-network address, a browser cookie, a legacy pairing or an untagged session
is not an exemption. Free local desktop admission requires positive local proof:
the current private startup capability on a loopback-bound desktop process with
no public URL. Keep that capability private; an IP address or owner role alone
does not establish a local session. Account access, computer lists, saved history,
billing management, export and revocation/cleanup remain available without Pro.

The execution host reads the account API's public `GET /api/v1/instance` policy
with `no-store`, independently of login. Its persistent hint is scoped to that
exact account authority and survives logout and host unlink. A policy for a
different authority cannot clear a known paid policy. Policy discovery never
proves that the current user has paid; a fresh authenticated authorization lease
must establish that separately.

| Setting                                 | Runs on               | Default and rollout use                                                                                                                                                                            |
| --------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SYNARA_ACCOUNT_URL`                    | Remote execution host | Set explicitly to the canonical account API origin for the actual Remote deployment. Match the intended account/host authority; do not copy a trial URL or infer it from a generic UI fallback.    |
| `SYNARA_REMOTE_BILLING_POLICY_REQUIRED` | Remote execution host | `false` during current preparation. Set to `true` only as part of the approved manual paid rollout. It requires fresh policy proof before admitting unverified Remote sessions, even before login. |
| `POLAR_REMOTE_ACCESS_ENFORCED`          | Account API           | `false` now. The future paid rollout sets it to `true` with configured billing; beta/test enrollment cannot override it.                                                                           |
| `POLAR_PRODUCTION_PAYMENTS_ENABLED`     | Account API           | `false` now. Production billing separately requires explicit `true`, production credentials, expected catalog and approved return origins.                                                         |

With strict host policy enabled, an unknown policy or first-read outage holds
Remote closed while positive local desktop use remains available. A verified
OFF policy lasts at most 60 seconds; an outage, an older response without the
field, clock rollback, logout or unlink cannot refresh it. Once ON is known,
logout/unlink is not an escape from enforcement. Only a previously verified
positive paid lease can retain its bounded outage grace. An OFF/unknown lease
is paused immediately on an unverified paid cutover, and an explicit
`subscription_required` response pauses Remote without revoking device trust.

Before a manual paid rollout, verify the exact build against the chosen account
API authority: known ON survives actual logout, unlink and restart; a held old
OFF reply cannot undo newer authenticated ON evidence; OFF/unknown-to-paid
cutover cannot reuse a free lease; expired paid leases pause Remote and fresh
paid proof restores the same credential. Check LAN/SSH, bearer/cookie/ticket,
HTTP/files, WebSocket/frame paths, and that positive local desktop use and
account/export/cleanup stay available. Keep all enforcement flags off until this
rollout is deliberately approved. This documentation changes no runtime setting.

### Configure an isolated environment

1. Use separate Polar organizations, credentials, webhook secrets and account
   PostgreSQL databases for sandbox and production. Use the
   [Polar sandbox](https://sandbox.polar.sh) for qualification, test payment
   details and deliverable aliases of a mailbox you control; Polar rejects
   reserved `example.com` fixtures. Never connect sandbox tests to a production
   account database.
2. Create monthly and annual subscription products with one fixed price each,
   recurring once per month/year. Attach the same Feature Flag benefit to both.
   Configure each price explicitly as tax-exclusive rather than inheriting
   location-based tax behavior, and do not configure a trial for these paid
   products. Polar's [tax behavior documentation](https://polar.sh/docs/features/tax-inclusive-pricing)
   describes the difference. The API reads catalog prices; clients never choose
   an amount, product, customer or return destination.
3. Supply the `POLAR_*` variables in `.env.example` through a protected
   operator-managed file outside the repository. Set `POLAR_BILLING_ENABLED=true`
   and choose `POLAR_ENVIRONMENT=sandbox` or `production` explicitly. Production
   additionally requires `POLAR_PRODUCTION_PAYMENTS_ENABLED=true` and all four
   expected-catalog values: `POLAR_EXPECTED_CURRENCY=USD`,
   `POLAR_EXPECTED_MONTHLY_AMOUNT_MINOR=799`,
   `POLAR_EXPECTED_YEARLY_AMOUNT_MINOR=8499` and
   `POLAR_EXPECTED_TAX_BEHAVIOR=exclusive`. The same complete expected-catalog
   set is optional in sandbox. Catalog validation rejects mismatches; updating
   a dashboard price is not permission to charge another amount.
4. Production requires a nonempty `POLAR_RETURN_ORIGINS` comma-separated list
   of exact operator-controlled HTTPS origins. Entries contain no credentials,
   non-default ports, paths, query strings or fragments. Both
   `POLAR_CHECKOUT_SUCCESS_URL` and `POLAR_PORTAL_RETURN_URL` must use an origin
   from that list. Sandbox additionally permits HTTP loopback return URLs on
   `localhost`, `127.0.0.1` or `[::1]`, including isolated development ports.
   Return URLs cannot contain credentials or fragments. The API and desktop
   reject cross-environment vendor redirects: sandbox uses
   `https://sandbox.polar.sh`, production uses `https://polar.sh`.
5. The runtime token needs only `products:read`, `customers:read`,
   `subscriptions:read`, `subscriptions:write`, `checkouts:read`,
   `checkouts:write` and `customer_sessions:write`. Renewal cancellation needs
   subscription write. Campaign administration and refunds stay outside the
   runtime token; do not add discount/refund write scopes to it.
6. Enable the desktop panel separately with `VITE_SYNARA_BILLING_ENABLED=1`.
   The legacy `VITE_SYNARA_BILLING_SANDBOX=1` flag is retained as an alias for
   panel visibility only. Neither build flag selects the billing environment
   or enables backend billing. Sign in to the intended account and open
   Settings → Profile → Subscription. Returning from checkout is not proof of
   payment; refreshing reads authoritative customer state.

The additive `billing_environment` singleton binds the database to one provider
environment. Existing billing-account or webhook rows are stamped as sandbox;
an empty database atomically claims its first configured environment. Startup
initialization rejects a mismatch before vendor operations. Use a separate
production database; never clear or edit the stamp, commercial rows or checkout
fences to repurpose sandbox state. Back up the database and protected operator
configuration together, and preserve that pairing across restarts and restores.

### Monthly introductory campaign

The sandbox campaign `SYNARABETA50QA` was configured and exercised with a new
sandbox customer: 50%, Once, restricted to `Synara Desktop — Sandbox Monthly`,
with one redemption per customer. The first discounted payment succeeded with
`399` USD minor units before tax, `88` tax and `487` total (USD 3.99 + 0.88 = 4.87),
and the shared feature benefit was granted. The annual checkout rejected this
campaign code. The checkout displayed the following full monthly price, but an
actual post-discount renewal has **not** yet been tested. No production campaign
is activated. Create any production counterpart separately; IDs and redemption
history do not transfer between environments.

| Polar campaign field             | Required value                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Type                             | Percentage (`percentage`).                                                                            |
| Percentage                       | 50% (`basis_points: 5000`).                                                                           |
| Duration                         | Once (`once`), not repeating or forever.                                                              |
| Products                         | Only that environment's monthly product ID; never the annual product or an unrestricted product list. |
| Code                             | `SYNARABETA50QA` in sandbox only; select a separate production campaign deliberately.                 |
| Maximum redemptions per customer | `1`.                                                                                                  |

Polar supports one-time recurring discounts and product restrictions; see
[discounts](https://polar.sh/docs/features/discounts) and the
[discount API](https://polar.sh/docs/api-reference/discounts/update). Monthly
checkout allows the customer to enter a code on Polar's hosted page; annual
checkout disallows codes. The [checkout API](https://polar.sh/docs/api-reference/checkouts/create-session)
provides `allow_discount_codes`; Synara does not accept client-selected discount
IDs or override the amount. No additional promo-code field is needed in Settings.

`once` limits the discount to one invoice. The per-customer redemption limit
limits repeat use, but does not establish an absolute lifetime-first-purchase
rule: Polar documents that a full refund frees that customer's redemption slot.
Do not promise stronger eligibility than has been implemented and qualified.
The first sandbox charge above verifies the observed rounding and itemized tax
for that checkout. Still qualify the actual full-price following renewal,
repeat-customer eligibility and invalid/expired-code refusals; a displayed
renewal price is not a paid renewal. Do not generalize the first-charge evidence
to those remaining cases.

### Durable checkout and access state

The verified account user ID becomes Polar's immutable external customer ID.
No browser-supplied email or arbitrary ID can select another customer's plan.
Status and redirect responses are private and uncached; desktop operations are
owner-only and fenced against account changes. The account PostgreSQL database
stores an additive billing ledger and durable webhook inbox with default-deny
RLS, separate from analytics and device trust. Webhooks are validated over the
original request body and acknowledged after durable storage; duplicate or late
events reconcile fresh Polar state instead of replaying an old entitlement.
A separate, non-overlapping billing worker drains pending events every 30
seconds; explicit status reads reconcile immediately. Provider outages leave
events retryable without holding up normal host/tunnel housekeeping. Remote
access checks use a bounded 30-second cache, bypass pending webhook work and
expired access leases, and do not convert provider failures into stale grants.

Checkout creation commits a durable attempt ID and chosen product before sending
Polar a POST. A timeout is **uncertain**, not proof that no checkout was created.
Retries only read Polar until that attempt becomes visible; they never create a
second checkout because time passed or a list response was empty. Known open or
confirmed attempts resume the same session. Only a freshly verified failed or
expired session allows a replacement; successful payments wait for account-state
synchronization. Cached links are never accepted as proof of the current state.
Known sessions persist the Polar checkout ID and revalidate directly by ID;
older attempt-and-URL rows learn it during recovery. Attempts without an ID use
at most ten newest-first pages of 100 organization/product candidates, then
verify the exact account, attempt and product. An incomplete search never
authorizes a new checkout, and customer email never establishes identity.
A documented HTTP 422 schema rejection from checkout creation proves that no
session was created: only that exact attempt is cleared, allowing a corrected
retry. Network errors, timeouts and 5xx responses never clear an uncertain intent.

For an uncertain attempt that remains unresolved, inspect its matching
`synara_checkout_attempt_id` metadata and customer/product scope in Polar before
operator recovery. Do not erase the local fence or force another purchase merely
because a request timed out. If no conclusive vendor outcome is available, keep
the attempt blocked rather than risk charging the customer twice. Returning
from a checkout URL never grants access.

Access follows granted benefits, including any configured payment-recovery
grace period, rather than assuming every non-active subscription is revoked.
Cancel-at-period-end preserves the remaining paid period. Refund and subscription
termination are separate operations; verify both and their effects on benefits.
Account deletion records an access tombstone immediately and retries stopping
renewals before deleting the external identity. An uncertain started purchase
also remains fenced during erasure until its outcome can be reconciled; an
empty provider search is insufficient proof that payment cannot still complete.

### Receiver, monitoring and restart runbook

- Deploy `POST /api/v1/billing/webhook` on a stable HTTPS receiver under an
  operator-controlled hostname. No particular Synara domain is required. Register
  `customer.state_changed` in Polar using the Raw delivery format and the matching
  environment's signing secret. Use the final destination URL without redirects;
  preserve the original request body and signature headers through the proxy.
  [Polar webhook setup](https://polar.sh/docs/integrate/webhooks/endpoints)
  describes endpoint registration. A temporary development forwarder is suitable
  for an isolated test, not a substitute for the persistent receiver. Expose only
  that receiver when forwarding locally, never the dev identity provider.
- Run the account API as a supervised process against its persistent database.
  `bun run --cwd apps/api start` runs migrations before serving and starts the
  billing worker immediately. Configure the supervisor to restart after failure
  and preserve the same environment, organization, database and secret file.
  Graceful shutdown waits for in-flight billing maintenance. After restart,
  verify API readiness, pending-inbox progress and a fresh test-account status;
  do not declare recovery solely because the process exists.
- Cloudflare Container deployments forward Polar settings through an explicit
  allowlist. The Worker keeps only a private hash of the effective runtime
  configuration; a changed or unknown warm process must stop gracefully and
  become ready with the new configuration before requests are forwarded.
  Handover/startup failures return retryable 503 without exposing bindings.
  Verify the intended Worker, container image and loaded policy together;
  deployment success alone is not proof that the paid rollout is active.
- Monitor receiver availability and latency, signature refusals, Polar delivery
  failures, worker reconciliation warnings and the count/age of inbox rows with
  `handled_at IS NULL`. Alert on sustained failures or a growing/aged queue;
  the 30-second interval is not a guaranteed maximum reconciliation latency.
  Log event IDs and bounded operational outcomes, never tokens, checkout links,
  raw payment bodies, customer emails or account content.
- Use Polar's delivery dashboard to investigate and retry failed deliveries.
  [Polar delivery guidance](https://polar.sh/docs/integrate/webhooks/delivery)
  documents retries, request timeouts and automatic endpoint disabling after
  repeated failures. Repair reachability/signature configuration before manually
  re-enabling a disabled endpoint. Let the durable inbox and fresh provider state
  handle duplicates; do not mark pending rows handled or clear purchase fences
  as an operational shortcut.
- For a database restore, restore the matching environment's protected config,
  keep customer traffic disabled until migrations and the environment stamp pass,
  then reconcile pending deliveries and affected accounts before reopening it.
  A deliberate maintenance pause must have an operator decision for remote-access
  availability; silently bypassing the paid gate is not a recovery mechanism.

### Sandbox qualification and production launch state

| Case                                | Required evidence before launch                                                                                                                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monthly and annual purchase         | Paid sandbox order, correct USD catalog price, tax-exclusive itemization, shared feature benefit and reconciled account access.                                                                          |
| Introductory monthly code           | First sandbox charge `399 + 88 = 487`, benefit grant and annual-code rejection verified. Actual full-price renewal after the discount and remaining eligibility cases still need qualification.          |
| Renewal and payment recovery        | Paid `subscription_cycle` order plus advanced period and reconciled access; test the configured grace behavior. A period advancing alone does not prove payment.                                         |
| Cancellation, refund and chargeback | Remaining paid access for period-end cancellation; separately verify refund-only and subscription termination, benefit changes and eventual remote denial.                                               |
| Webhook delivery                    | Real signed automatic event reaches the stable receiver; duplicate, delayed and out-of-order events converge; invalid signatures are refused.                                                            |
| Restart and provider downtime       | Persisted uncertain checkout resumes without another POST; inbox survives restart and drains after recovery; stale permission is not granted on provider failure.                                        |
| Identity and erasure                | Account switching never opens another account's billing; deletion during an uncertain checkout cannot leave a renewable purchase behind.                                                                 |
| Product boundary                    | All official Remote ingress requires Pro at paid rollout; positive local desktop use, account/history/export/cleanup remain free. Verify persistent authority policy, logout/unlink and old-OFF cutover. |

For sandbox renewal qualification, Polar's public subscription update accepts a
future `current_billing_period_end` for an existing isolated test subscription.
Keep its account, product and price unchanged, then require the paid renewal
order as well as the new period. Polar may defer invoicing while its grace
window runs. Restore cancellation afterward and verify the resulting state.
Issue refunds from the sandbox merchant dashboard; the runtime token has no
refund permissions. Record failed or pending cases instead of treating local
unit tests or historic sandbox receipts as production qualification.

Production activation remains pending the deployed receiver and monitoring,
merchant onboarding, qualification of the chosen products/campaign, and approved
commercial terms, refund/cancellation policy, support contact and privacy
disclosures. Remote enforcement remains off during preparation. The free
companion design is not a claim of an Apple payment exemption. This change
does not provision production credentials, payouts, a real payment or a paid
rollout.

## Identity: WorkOS AuthKit behind an adapter seam

This service does not store users, passwords, or WorkOS sessions. WorkOS owns
those. Synara does own an Ed25519 API signing key supplied at boot for host
grants; only its public keys are served from
`GET /api/v1/keys/jwks`. The database holds the additive host/account registry
(`hosts`, legacy `host_tokens`, `devices`, link challenges and revocations)
plus Synara-owned profiles.

The domain never talks to WorkOS directly: routes depend on the identity and
registry interfaces in `src/identity/interfaces.ts`. WorkOS implements user
verification and membership grants; the database-backed host/device/key and
revocation modules are provider-independent and wired alongside the retained
legacy host-token adapters in `src/identity/index.ts`.

### Two ways in

The app offers email OTP in-app and SSO through the browser, and this service
backs both:

- **Email OTP** — `POST /api/v1/auth/otp/send` asks WorkOS to email a 6-digit
  Magic Auth code; `POST /api/v1/auth/otp/authenticate` redeems it, signing up
  the user on first redemption. The proxy exists because the Magic Auth grant
  is a confidential-client grant: it requires the client secret, so the app
  cannot make the call itself. The code is **pass-through** at every step —
  read off the request, handed to WorkOS, and never written to the database, a
  log line, or an error message. `src/identity/workos.ts` deliberately uses a
  separate request helper for these calls, because the general one puts the
  upstream response body into the thrown error and WorkOS echoes offending
  fields. Send is limited to 2/min per client, redemption to 5/min, each on
  its own budget below the authorize route's 10/min. There is **no password
  auth**.
- **SSO** — "Continue with Google/Apple/GitHub" takes the authorization-code
  grant with PKCE and a loopback redirect, finishing on the WorkOS hosted
  page in a real browser — the only auth step that leaves the app. Every leg
  is proxied here: the authorize URL (`POST /api/v1/auth/authorize`), the
  code exchange (`POST /api/v1/auth/authorize/token`), and refresh
  (`POST /api/v1/auth/refresh`) — the client never talks to WorkOS, so a
  different identity backend is a server-side swap.

Both converge on the same token pair, so everything downstream — workspace
scoping, credential storage, refresh — is one code path.

## Hosts are account entities shared through organizations

### Private saved Inbox recaps

The Beta Inbox saves snapshots only when the user selects **Save privately**.
`PUT /api/v1/inbox/recaps` accepts `{ sourceHostId, day, timezone, recap }`, where
`recap` is `StatsGetRecapResult` and the window runs from 04:00 on `day` to the
next 04:00 in the source IANA timezone. Project names are included in this
explicit save; the account's public profile never exposes saved recaps.

Every save, list, read, and delete requires a valid account session and live
membership of its active workspace. Saving also requires an owned or discoverable
source host in that workspace. The same user, workspace, source, day, and timezone
updates one saved snapshot. The service supplies `id`, `sourceHostName`, and
`savedAt`; request bodies retain the existing 64 KiB API limit.

`GET /api/v1/inbox/recaps?limit=20&cursor=…` returns `{ recaps, nextCursor }` in
descending save order, with limits from 1 to 50 and an opaque continuation cursor.
`GET /api/v1/inbox/recaps/:id` reads a snapshot and
`DELETE /api/v1/inbox/recaps/:id` deletes it with a 204 response.
History is private to the user and workspace, served with `private, no-store`,
and protected by default-deny RLS for non-owner database roles. The API's WorkOS
authorization remains authoritative; Supabase client roles receive no policies.

History persists independently of host or device registrations. Signing in to
the same account and workspace restores saves after a phone reset and while all
source computers are offline. There is no automatic recap upload, host deletion
cascade, or dependency on local device caches. Migration `0016` is additive and
must be applied by the operator before deploying this API version.

Ownership is keyed on **`hosts.owner_user_id`**. Every user
gets a personal organization the first time they use the service — provisioned
lazily, named `Personal — <email>` — so there is no "personal account" concept
separate from a workspace. Teams later are the same organization with more
members: an invite, not a migration.

- Owners can manage and reach their hosts across their active workspace
  context. A non-owner can see/use a host only when it is discoverable and
  both users are members of `hosts.owner_org_id`.
- `hosts.registered_by_user_id` records who ran the registration. It is an
  audit trail only and is never consulted for access — otherwise someone who
  left an organization would keep reaching the hosts they happened to register.
- The unique index remains `(owner_org_id, environment_id)` for additive
  compatibility, while keypair link completion unlinks every other row for
  the same environment id so one machine has only one live account link.

WorkOS mints sign-in tokens **without** an `org_id` claim, so the first call
after a sign-in is always refused with `403 organization_required`. That
response carries the caller's organizations, and the client refreshes with
`organization_id` to obtain a scoped token before retrying. The same 403
answers a token naming an organization the caller has since left, which is what
makes a revoked membership take effect without anything being purged.

Membership lists are cached per process for 60 seconds, so a burst of requests
costs one round trip while an added or removed member still takes effect on its
own.

## What WorkOS owning identity means in practice

- **Sign-in methods are dashboard toggles, not env vars.** Magic Auth (email
  OTP), Google, GitHub, Microsoft and the rest are enabled per-application in
  the WorkOS dashboard. There are no OAuth client ids or secrets to register
  here, and no provider pairs in the environment. The OTP routes above will
  fail against an application that has Magic Auth switched off, which is a
  dashboard change rather than a deploy.
- **Email verification is WorkOS's decision, not ours.** Redeeming an OTP
  implicitly verifies the address, so the challenge should not fire on the
  OTP path — if WorkOS answers `email_verification_required` anyway, the
  service classifies it into a terse 403 telling the user to sign in with an
  emailed code instead. There is no in-app challenge flow.
- **Email delivery is WorkOS's.** OTP mail is sent by WorkOS, so there is no
  SMTP or Resend configuration.
- **There are two JWKS roles.** WorkOS's JWKS verifies user access tokens. The
  service also derives a stable Ed25519 key from `API_SIGNING_KEY`, serves its
  public JWK (plus `API_SIGNING_KEY_PREVIOUS` during rotation), and signs host
  host grants. WorkOS mode fails closed when this key is absent.
- **The issuer and JWKS URL are discovered, not guessed.** On its first token
  verification the service fetches WorkOS's OIDC metadata document at
  `{WORKOS_API_URL}/user_management/{WORKOS_CLIENT_ID}/.well-known/openid-configuration`
  and caches the `issuer` and `jwks_uri` it returns for the process lifetime.
  This matters: WorkOS scopes `iss` to the **environment's** client id
  (`https://api.workos.com/user_management/client_…`), which is _not_
  `WORKOS_CLIENT_ID` whenever your AuthKit application is not the environment
  default. Any locally derived issuer would reject every real token.
- **Discovery failure is fatal, by design.** Without a trusted issuer a token
  minted for some other tenancy could pass, so verification errors out naming
  the metadata URL rather than relaxing the check.
- **`WORKOS_ISSUER` / `WORKOS_JWKS_URL` are overrides.** Set them only for a
  custom auth domain or a stand-in that serves no metadata document; an
  explicit value always wins over discovery.

### Dashboard setup

1. Create an AuthKit application at <https://dashboard.workos.com>.
2. Under **Authentication**, enable the sign-in methods you want (Magic Auth
   for email codes; Google, Apple, and GitHub for SSO — Sign in with Apple
   additionally needs an Apple Developer Services ID and key configured on the
   WorkOS side).
3. Add `http://127.0.0.1:*/callback` to the allowed redirect URIs — the
   desktop PKCE flow redirects to a loopback listener on an ephemeral port
   (wildcard-port loopback redirects are allowed in all WorkOS environments).
4. Copy the API key and client id into `WORKOS_API_KEY` / `WORKOS_CLIENT_ID`.

## Quick start (local)

```sh
docker compose -f apps/api/docker-compose.yml up -d          # Postgres 18 on :5432
cp apps/api/.env.example apps/api/.env                       # then fill in the WorkOS keys
bun install
bun run --cwd apps/api dev                                   # http://localhost:8788
```

Migrations run automatically at boot (`runMigrations` in `src/index.ts`), so an
empty database is fine. To generate new SQL after a schema change, use
`bun run --cwd apps/api db:generate`; to apply without booting the server, use
`db:migrate`.

Then sign in from the Synara app (account menu), and from a server checkout:

```sh
SYNARA_ACCOUNT_URL=http://localhost:8788 bun run --cwd apps/server src/index.ts auth    # link this host
SYNARA_ACCOUNT_URL=http://localhost:8788 bun run --cwd apps/server src/index.ts status
```

## Developing without a WorkOS account

### The dev identity provider (recommended)

Set `IDENTITY_PROVIDER=dev` and the service swaps the whole identity seam for
an offline implementation — no WorkOS tenancy, no network, no extra process:

```sh
IDENTITY_PROVIDER=dev DATABASE_URL=postgres://synara:synara@localhost:5432/synara_accounts \
  ACCOUNT_BASE_URL=http://localhost:8788 API_PUBLIC_URL=http://localhost:8788/api/v1 \
  bun run --cwd apps/api dev
```

- Any email signs in. The 6-digit OTP code is **printed to the API's stdout**
  (`[dev-identity] OTP for you@example.com: 000001`) instead of emailed — type
  it into the app's sign-in dialog.
- SSO sign-ins self-approve as the dev user: the authorize page 302s straight
  back to the loopback listener, standing in for the browser hop.
- Users, organizations, and codes are in-memory and die with the process; the
  host registry and profiles still live in Postgres as usual.

It refuses to start — by design, with a process exit — when `NODE_ENV` is
`production` or when `WORKOS_API_KEY` is set: printing sign-in codes to stdout
is only acceptable on a machine where the operator at the terminal is the only
user, and a real WorkOS secret means the environment is meant to serve real
users. Internally it runs the same in-process double the test suite uses
behind the same WorkOS adapter that runs in production, so the code path you
exercise is the deployed one.

### The standalone stub (WorkOS env-wiring testing)

`scripts/fake-workos.ts` runs that same double as a standalone server, so the
full in-app sign-in flow works against a _normally configured_ API with no
WorkOS tenancy. SSO authorize requests self-approve as the dev user and OTP
codes print to the stub's stdout — which is what makes the flow headless.
Prefer this over `IDENTITY_PROVIDER=dev` when you specifically want to
exercise the env-var wiring of the WorkOS configuration itself.

```sh
bun run --cwd apps/api scripts/fake-workos.ts        # :8790
```

It prints the environment to point the API at:

```sh
export WORKOS_API_URL=http://127.0.0.1:8790
export WORKOS_API_KEY=fake
export WORKOS_CLIENT_ID=client_01FAKE
```

The stub serves the same OIDC metadata document real WorkOS does — including an
environment-scoped issuer that differs from the client id — so the discovery
path is exactly the one production takes, and neither `WORKOS_ISSUER` nor
`WORKOS_JWKS_URL` needs setting.

Start the API with those set, then sign in from the app as usual: SSO lands
straight back in the app, OTP codes print in the stub's terminal, and you end
up with a real credentials file (and, after `synara auth`, a registered host).

| Flag                 | Default         | Purpose                                                                                                     |
| -------------------- | --------------- | ----------------------------------------------------------------------------------------------------------- |
| `--port`             | `8790`          | Listen port.                                                                                                |
| `--client-id`        | `client_01FAKE` | Client id to serve.                                                                                         |
| `--access-token-ttl` | `5m`            | Access-token lifetime. Set something like `30s` to exercise the refresh path.                               |
| `--organization`     | none            | Pre-create an organization the dev user joins. Repeatable — pass it twice to exercise the workspace picker. |

With no `--organization`, the dev user belongs to nothing and the API
provisions their personal organization lazily, which is the path a real
first-time sign-in takes. The stub mints sign-in tokens without an `org_id`
claim and honours `organization_id` on the refresh grant, exactly as WorkOS
does, so the 403-then-refresh dance is real here too.

The stub mints **single-use refresh tokens**, exactly as WorkOS does, so a
client that fails to persist a rotation is locked out here the same way it would
be in production. It is dev tooling only — nothing in `src/` imports it, and it
is never reachable from a deployed instance.

### Manual checklist against a real WorkOS tenancy

The stub verifies the shape of the flow, not WorkOS's behaviour. Before
trusting an instance against real WorkOS, confirm by hand:

1. **The loopback redirect URI is registered** in the dashboard
   (`http://127.0.0.1:*/callback`) — the SSO buttons error until it is.
2. "Continue with Google/Apple/GitHub" opens the provider page in the system
   browser and lands back in the app signed in; the email OTP dialog signs in
   with the code WorkOS mails.
3. `synara status` resolves your real name and email through `GET /me`.
4. A command run more than ~5 minutes after signing in still works — that is the
   refresh path, and the credentials file should hold a changed token pair
   afterwards.
5. Signing out of all sessions in the WorkOS dashboard makes the next refresh
   fail with a 4xx, and the CLI reports the session as expired rather than
   hanging or looping.
6. If you configured a custom auth domain, `WORKOS_ISSUER` matches it —
   otherwise every token is rejected. With no custom domain, leave it unset:
   discovery resolves the environment-scoped issuer, and a hand-written guess
   is the one thing that reliably breaks this.
7. **A refresh carrying `organization_id` yields a token with an `org_id`
   claim.** Everything about host access depends on it. Decode the stored
   access token after signing in and confirm the claim is there and matches
   the workspace you chose; without it every host route answers
   `organization_required` forever.
8. **The membership listing has the shape this service reads.**
   `GET /user_management/organization_memberships?user_id=…` must return
   `data[].organization_id` **and** `data[].organization_name`. The name is
   read inline rather than fetched per organization, so if a real tenancy omits
   it the workspace picker falls back to showing raw `org_…` ids.
9. Signing in as a brand-new user with no organizations provisions one, and the
   WorkOS dashboard shows both the organization and the membership afterwards.
   Two users must not end up sharing a personal organization.
10. **Real access tokens carry a `client_id` claim equal to `WORKOS_CLIENT_ID`.**
    Verification refuses any token whose `client_id` does not match, and refuses
    one that omits the claim — that check is what stops a token minted for a
    sibling AuthKit application in the same environment from being accepted, as
    one issuer and one JWKS are shared across all of them. Decode a real access
    token (jwt.io, or `synara status` plus the credentials file) and confirm the
    claim is present with the expected value. If a tenancy is configured with
    Resource Indicators the audience may arrive as `aud` instead, in which case
    this check needs widening before that tenancy can sign in at all.

## Environment variables

| Variable                                                                                          | Required     | Default                  | Purpose                                                                                                                                              |
| ------------------------------------------------------------------------------------------------- | ------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                                    | yes          | —                        | Postgres connection string for the host registry.                                                                                                    |
| `WORKOS_API_KEY`                                                                                  | yes          | —                        | WorkOS secret key (`sk_…`). Server-side only.                                                                                                        |
| `WORKOS_CLIENT_ID`                                                                                | yes          | —                        | WorkOS AuthKit client id (`client_…`).                                                                                                               |
| `ACCOUNT_BASE_URL`                                                                                | yes          | —                        | Public origin of this instance.                                                                                                                      |
| `API_PUBLIC_URL`                                                                                  | yes          | —                        | Exact public API issuer used by host/device JWTs, e.g. `https://accounts.example.com/api/v1`.                                                        |
| `API_SIGNING_KEY`                                                                                 | WorkOS       | dev: ephemeral           | Base64url-encoded 32-byte Ed25519 seed for host grants.                                                                                              |
| `API_SIGNING_KEY_PREVIOUS`                                                                        | no           | —                        | Previous signing seed kept in public JWKS during rotation.                                                                                           |
| `REMOTE_TEST_USER_IDS`                                                                            | remote tests | empty denies             | Explicit test users; not a paid subscription entitlement.                                                                                            |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_TUNNEL_DOMAIN` | remote       | all or none              | API-only managed tunnel administration; see the remote operations guide.                                                                             |
| `PORT`                                                                                            | no           | `8788`                   | HTTP listen port.                                                                                                                                    |
| `WORKOS_API_URL`                                                                                  | no           | `https://api.workos.com` | WorkOS API origin. Override only to point at a stand-in.                                                                                             |
| `WORKOS_JWKS_URL`                                                                                 | no           | discovered (`jwks_uri`)  | Full JWKS URL. Override only to point at a stand-in.                                                                                                 |
| `WORKOS_ISSUER`                                                                                   | no           | discovered (`issuer`)    | Expected `iss` claim. Set only for a custom auth domain.                                                                                             |
| `IDENTITY_PROVIDER`                                                                               | no           | `workos`                 | `dev` selects the offline dev identity provider. Refused with `NODE_ENV=production` or a set `WORKOS_API_KEY`.                                       |
| `TRUSTED_PROXY_HOPS`                                                                              | no           | `0`                      | Proxies trusted to append to `x-forwarded-for`. `0` (no proxy) keys rate limits on the socket; Railway and similar TLS-terminating proxies need `1`. |
| `PROFILE_PROXY_SECRET`                                                                            | no           | unset                    | Shared secret from the profiles SSR deployment; when matched, public-profile rate limits key on the forwarded viewer IP. Keying only, not auth.      |
| `TEST_DATABASE_URL`                                                                               | tests        | —                        | Database the Vitest suites use. Without it they skip.                                                                                                |

A missing required variable fails the boot with an explicit
`Missing required environment variables: …` rather than starting half-configured.

## Supabase PostgreSQL with WorkOS

Supabase is the selected PostgreSQL host for the remote MVP. WorkOS remains the
identity authority: login, organizations, sessions and refresh tokens continue
through the account API. Supabase only stores Synara's application data through
the existing `pg`/Drizzle connection. No Supabase Auth setup, WorkOS-to-Supabase
JWT integration, `supabase-js`, publishable key or service-role API key is needed.

1. The current trial uses the existing Synara project
   (`ubdkfrnaqfbdymgipddq`), alongside its advertising tables. Account migrations
   0000–0015 and their Drizzle journal were applied through MCP on 2026-09-28.
   For another existing project, first check for account-table name collisions
   (including historical tables such as `user` and `session`). Keep hosted data
   separate from disposable automated-test databases.
2. In the project's **Connect** dialog, copy the **Direct connection** URL when
   the API host supports IPv6. For an IPv4-only host, use the **Session pooler**
   URL (port `5432`). This is a persistent Bun service; transaction pooling
   (port `6543`) is not the setup qualified here. Copy the actual hostname and
   username from the dashboard; do not infer a pooler hostname from the region.
3. Set that URL as server-only `DATABASE_URL`, using the database password
   (URL-encoded), not a Supabase API key. Add `sslmode=verify-full`. If the
   certificate requires Supabase's project CA, download it from **Database
   Settings**, mount it on the API host and add `sslrootcert` with that absolute
   path. The existing PostgreSQL driver reads the CA file; do not disable
   certificate verification to fix a connection error. Do not reset the shared
   database password or change project-wide settings used by the sponsor service.
4. Keep this shared project's **Data API** enabled for the sponsor service.
   Account tables are accessed only through Synara's API. Their bootstrap
   revokes all table grants from `PUBLIC`, `anon`, `authenticated` and
   `service_role`, without changing advertising grants or schema defaults.
   Migration 0015 also enables RLS without client-facing policies. Apply the
   same explicit grant restrictions to future account tables on this shared
   project; do not add them to Realtime replication.
5. Use the same database-owner role for migrations and API runtime (the
   dashboard's `postgres` connection works). The API applies migrations before
   listening. RLS deliberately allows the table owner; a separate non-owner
   role with ordinary grants alone cannot serve the API. Never distribute this
   database credential to desktop, web or mobile clients.
6. Configure WorkOS and Cloudflare through the [remote setup guide](../../docs/implementation/cloudflare-remote/READINESS.md).
   After startup, inspect the tables with the Supabase plugin/SQL editor and
   verify login, profile creation, pairing, reconnect and revocation through
   Synara. Passing local PostgreSQL tests is not live Supabase qualification.

Example URL shapes (replace placeholders with the values from **Connect**):

```dotenv
# Direct connection, when the API host can reach IPv6:
DATABASE_URL=postgresql://postgres:URL_ENCODED_PASSWORD@db.PROJECT_REF.supabase.co:5432/postgres?sslmode=verify-full
# Session pooler: use the exact dashboard hostname, not this placeholder:
# DATABASE_URL=postgresql://postgres.PROJECT_REF:URL_ENCODED_PASSWORD@POOLER_HOST:5432/postgres?sslmode=verify-full
# If the selected endpoint needs the project's CA, append:
# &sslrootcert=/run/secrets/supabase-ca.crt
```

Keep this integration standard PostgreSQL so a future provider move transfers
the schema/data and connection configuration, rather than replacing login.
Provider references: [connections](https://supabase.com/docs/guides/database/connecting-to-postgres),
[SSL](https://supabase.com/docs/guides/platform/ssl-enforcement),
[Data API settings](https://supabase.com/docs/guides/api/securing-your-api),
[RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).

## Deploying to Cloudflare

Synara's selected API host is Cloudflare Containers. The public profiles run in
a separate Cloudflare Worker; PostgreSQL stays on Supabase and identity stays on
WorkOS. Railway is not part of this deployment.

The existing Dockerfile runs TypeScript under Bun. The small ingress Worker in
`cloudflare/worker.ts` forwards to one container and replaces untrusted forwarded
IP headers with Cloudflare's caller address. The API retains its existing
transactions, rate limits, startup migrations and maintenance loop.

See [Cloudflare deployment](cloudflare/README.md) for secrets, build verification,
the manual GitHub Actions workflow and the final live checks. The checked-in
configuration targets a new trial service; it does not overwrite another Worker.

API hosting and database hosting are independent: use the selected
[Supabase database](#supabase-postgresql-with-workos) while the API runs on
Cloudflare. Other standard PostgreSQL hosts, including PlanetScale Postgres, remain
compatible alternatives. A hosted `DATABASE_URL` must verify TLS:

```
postgres://USER:PASSWORD@HOST/DATABASE?sslmode=verify-full
```

Use the provider's root certificate when its CA is not trusted by the runtime.
Migrations run on boot, so the first deploy provisions the schema with no extra
release step.

Other platforms work the same way: any host that can run `bun run start` with a
Postgres URL and a persistent public origin is enough. There is no filesystem
state — everything lives in Postgres.

## Build and run

The server has **no bundle step**. It runs TypeScript directly under Bun, in
both development and production.

| Script  | What it does                                                       |
| ------- | ------------------------------------------------------------------ |
| `build` | Prints `no build step`. Kept so generic `bun run build` CI passes. |
| `start` | Runs the server from `src/index.ts`. There is no `dist/index.mjs`. |
| `dev`   | Same, with `--hot`.                                                |

**For packaging:** ship `src/`, `drizzle/`, and `node_modules`, then run
`start`. Do not look for a compiled server entrypoint — unlike `@synara/server`,
which builds to `dist/index.mjs`, this app deliberately has none.

## Tests

`bun run test` requires Postgres and a `TEST_DATABASE_URL`; without it the
database-backed suites skip. WorkOS is never called: `src/testing/fakeWorkos.ts`
serves a JWKS from a freshly generated key pair, mints access tokens signed by
it, and answers the OTP, PKCE, and refresh grants, so the auth path is
exercised end to end with no network. The same module backs the dev stub above.

Create the separate `synara_accounts_test` database before running:

```sh
docker compose -f docker-compose.yml up -d
TEST_DATABASE_URL=postgres://synara:synara@localhost:5432/synara_accounts_test bun run test
```

Use a disposable test database, separate from personal development and production
state. Fixture setup can remove or replace registry rows; API and E2E suites
sharing that test database must run sequentially.

The billing suites and the billing-lifecycle case create, migrate, and drop their
own UUID-named temporary databases so parallel files cannot erase one another's
fixtures. Their **test-only** PostgreSQL role needs `CREATEDB`; the local Docker
Postgres owner already has it. Use a dedicated disposable server/role for
`TEST_DATABASE_URL`, never a production connection, and do not grant `CREATEDB`
to the production runtime role. Vendor sandbox E2E uses another separate database.

## Account erasure

`DELETE /api/v1/me` requires the existing authenticated device session and a JSON
body with `confirmation: "delete"` and the current verified account email. The
target is always the authenticated owner, never a caller-supplied user ID. A
successful request returns `202 {"status":"pending"}`; clients then sign out.
The owner-only desktop RPC also fences the account shown in the confirmation
against an intervening account switch. Local computer chat history is preserved.

Migration `0022_account_deletions.sql` adds the private durable deletion queue.
Requests immediately hide the public profile, unlink host identities, expire
activities and refuse subsequent authenticated access. Maintenance retries
identity-provider deletion, avatar removal and owner-scoped data cleanup after
failures or restarts. A second purge after 24 hours catches late writes; a
completed queue tombstone remains for 30 days. Tunnel allocation metadata is
anonymized and retained for cleanup rather than losing the identifiers needed
to remove the remote resources. No existing migration or other owner's data is
rewritten. Provider account deletion is not proof of upstream Apple OAuth token
revocation; that requires separate production qualification.

## Managed remote access

The current app uses [managed Cloudflare tunnels](../../docs/cloudflare-remote.md). No relay secret is required for WorkOS startup or normal remote access. Configure the four Cloudflare variables together and explicit remote test users. Tunnel allocation and code rendezvous migrations are additive; admin tokens remain in the account service. The retired relay-ticket endpoint returns 410 and the internal revocation endpoint returns 401. Ticket issuance and the relay polling feed have been removed; hosts use authenticated authorization snapshots and acknowledge durable device revocations.

The [remote MVP handoff](../../docs/implementation/cloudflare-remote/READINESS.md) lists the service configuration, client settings and live acceptance checks in dependency order.

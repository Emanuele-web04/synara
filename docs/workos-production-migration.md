# WorkOS Production migration

WorkOS environments have separate users, organizations and sessions. Synara stores
user and organization IDs in profiles, hosts, devices, usage and private Inbox
records. Switching credentials alone gives existing users a different ownership
identity. Rewriting those IDs can also invalidate encrypted host-secret AAD.

## Preserve account ownership

1. Inventory the existing users and active memberships through the trusted
   identity provider. Import those exact accounts into Production, keeping them
   separate. Retain each previous ID as its WorkOS `externalId` for operator
   reconciliation, and create only its verified personal-organization membership.
2. Prepare an explicit old-to-current mapping for users and organizations. Store
   it as the private `WORKOS_IDENTITY_MAP` Worker secret alongside the destination
   `WORKOS_API_KEY` and `WORKOS_CLIENT_ID`:

   ```json
   {
     "clientId": "client_destination",
     "users": { "user_existing": "user_destination" },
     "organizations": { "org_existing": "org_destination" }
   }
   ```

   Never infer ownership from email or trust an upstream `externalId` as an
   authorization claim. Only reviewed operator pairs establish the mapping.
   The config refuses a wrong client, duplicate destinations, self-maps, chains
   and malformed pairs. Retain this mapping as long as these accounts exist;
   removing it would make their old data inaccessible. Unlisted new accounts
   continue using their own provider IDs.

3. The WorkOS adapter translates verified Production identities to the existing
   Synara IDs and translates upstream user/organization operations back to the
   Production IDs. Signature, issuer, expiry and exact client verification remain
   mandatory. Membership and revocation checks still query Production. No
   Supabase ownership rows, API signing keys or encrypted blobs are rewritten.

## Cut over and verify

- Back up the existing identity credentials in protected operator storage, outside
  Git. Record row counts and ownership before the switch. Keep Staging intact.
- Configure and test Apple, Google, email codes and native redirects in Production.
  Google credentials must request only the required basic identity scopes; Google
  OAuth publishing status and WorkOS's environment selection are separate settings.
- Deploy the backwards-compatible adapter first with the existing credentials.
  Verify API health and existing public profiles.
- Update the three identity secrets together; retain every unrelated Worker secret.
  Roll out the Container so the running API loads the new environment.
- Existing Staging sessions cannot be refreshed in Production. Sign in again;
  this changes the authentication session, not the account's Synara ownership.
- Check each imported user's `/me`, organizations, profile/handle, hosts/devices,
  usage summary and private Inbox. Verify that a different account cannot read
  another user's private records, then test refresh, revocation and native login.
  Recompare counts and ownership, allowing independent activity during the test.
- Keep the signed grant issuer, storage configuration and account-service origin
  stable so existing host and device identities remain usable after sign-in.

Rollback restores the old key/client and removes `WORKOS_IDENTITY_MAP` in the same
secret update, followed by a Container rollout. No database rollback is needed
because the ownership records are unchanged. Do not remove imported accounts or
old credentials until live qualification and the rollback window are complete.

## Qualification before publication

The regression uses an independent local WorkOS HTTP server: without the mapping
it fails reading the old user's identity; with it, email/PKCE login, scoped refresh,
membership authorization and revoked-membership refusal use the correct owners.
Config and Worker forwarding checks cover deployment admission. Run the full API
suite against a disposable PostgreSQL database, plus repository format, lint and
type checks. These checks do not replace live Production login and data checks.

## Trial qualification — 2026-10-14

The trial account API now uses WorkOS Production. Google OAuth is published with
only basic identity scopes; email codes and the previously configured Apple
provider are enabled. The live privacy policy documents the account services and
Cloudflare's remote transport role. Credentials and the reviewed identity pairs
remain in protected operator storage and Worker secrets, outside Git and images.

- All imported accounts completed real email-code login and scoped refresh. Their
  profile, cached photo, hosts, devices, usage and private Inbox remained available
  under their existing Synara IDs. Cross-account recap reads returned 404.
- Google completed the real browser/loopback PKCE exchange, scoped refresh and
  existing-profile lookup. Test sessions were subsequently revoked; every revoked
  refresh was refused with 401. No existing app session was revoked by this test.
- Database fingerprints for profiles, devices, Inbox and model usage were
  unchanged. Hosts retained their counts and continued receiving heartbeats.
  Staging accounts and their memberships were retained for rollback.
- The complete API suite passed 365 tests against disposable PostgreSQL. The
  final Worker ingress suite passed 12 tests, and repository format, lint and
  type checks passed. No database ownership rewrite or new migration was needed.

Existing apps must sign in again with the same email: Staging sessions cannot
refresh in Production. Native iPhone/iPad and desktop sign-in after this cutover,
and a complete Apple token exchange, still require their own qualification; the
browser/API tests are not evidence of those platform flows.

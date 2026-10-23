> Historical account migration notes, imported from the former standalone repo.
> Current source and commands: [README.md](README.md). Do not repeat this migration
> to move code into the monorepo. The redactor now imports from `@synara/shared`.

# Handoff: moving Beta diagnostics to Emanuele

Written for Emanuele or his agent. Read it top to bottom once before running
anything. Every step can be done by an agent except the ones marked
**(human)**, which need a browser login.

## What this is

This repo is the Cloudflare Worker behind Synara Beta diagnostics. Beta builds
send crash and error reports to it; it stores them and serves a private
dashboard.

- **Worker:** `worker.ts` (ingest `/v1/events`, `/v1/crash`, dashboard `/api/*`, SPA).
- **D1 database** `synara-beta-diagnostics`: events, usage rows, dump index, triage state.
- **R2 bucket** `synara-beta-crash-dumps`: raw minidumps.
- **Secrets:** `DASHBOARD_PASSWORD`, optional `DASHBOARD_PASSWORD_2`,
  `DASHBOARD_SESSION_KEY`. Write-only in Cloudflare; they cannot be copied, only
  set again.
- **Client side** lives in the Synara repo: `apps/desktop/src/betaDiagnostics.ts`
  (hardcoded endpoint) and `docs/diagnostics.md` (privacy notice).

## State as of 2026-09-28 (verified)

- Everything runs in Cloudflare account **Synara**
  (`9f9caeb268766deda99bc580c775d50c`), owned by Kartik. Emanuele is a Super
  Administrator there as `manu.development.app@gmail.com`.
- **Kartik may rename that account to "Vex" at any time** and reuse it for his
  own projects. Same account ID, same data, same URL: renaming changes only
  the display name. If you see "Vex" instead of "Synara" in `wrangler whoami`,
  it is the same OLD account. Until Part B is done, Kartik keeps the worker,
  D1 database, and R2 bucket named `synara-beta-diagnostics` /
  `synara-beta-crash-dumps` untouched and keeps you as a member.
- Live URL: `https://synara-beta-diagnostics.kartik-9f9.workers.dev`. Every
  shipped Beta has this URL baked in.
- Data: about 1,300 events, 30 usage rows, 1 R2 object (a 2 KB smoke-test dump).
  DB size under 1 MB.
- **Retention: nothing is deleted.** No cron, no R2 expiry rule. This was a
  deliberate decision; keep it that way. The privacy notice in the Synara repo
  says so (Emanuele-web04/synara#1373).
- The Synara account also holds Kartik's own experiments (`synara-cloud-agent`,
  `trace`, their D1 and R2). They are **not** part of the handoff. Do not touch them.
- Zero Trust is enabled on that account but no Access apps exist. The worker
  can verify Cloudflare Access JWTs (`TEAM_DOMAIN`, `POLICY_AUD`,
  `ALLOWED_EMAILS` vars) if you want Access instead of passwords later.
  Optional.

## Tools

- **Wrangler** needs no install: `npm ci` brings the pinned version, and every
  command here runs it through `npx`. Wrangler stays supported for 18 months
  after Cloudflare's new CLI leaves beta.
- **`cf`** (optional, open beta, `npm i -g cf`) is Cloudflare's new CLI. It
  covers the whole Cloudflare API, so an agent can use it for the steps marked
  (human) in Part A: adding the zone and creating DNS records. Use
  `cf cli search "<what you want>"` to find a command. Not needed for Part B.
- **Vercel CLI** (`vercel dns ls trysynara.com`) lists the current DNS
  records, if the agent has a Vercel login for the team that owns the domain.

## Where it goes

- A Cloudflare account owned by Emanuele (called NEW below).
- Permanent URL: `https://diagnostics.trysynara.com`. After this the URL never
  depends on which account hosts it.
- The old URL stays alive on Kartik's account as a small forwarder
  (`forwarder/`) so older Betas keep reporting. Kartik keeps that account
  (renamed to Vex) for his own work.

## Order of work

1. Domain moves to Cloudflare (Part A).
2. Data and worker move (Part B).
3. Synara app points at the new URL and a Beta ships (Part C).
4. Kartik cleans up his side (Part D).

Do not skip ahead. Part B step 5 needs the domain live, and Part D needs Part C.

## Part A: move trysynara.com DNS to Cloudflare

Today `trysynara.com` is registered at **Namecheap** with DNS on **Vercel**
(the website is hosted on Vercel). A Worker custom domain needs the zone on
Cloudflare. The website and email must keep working through this.

Records visible from outside today:

| Name            | Type    | Value                                        |
| --------------- | ------- | -------------------------------------------- |
| `trysynara.com` | A       | `216.150.16.65`, `216.150.1.129` (Vercel)    |
| `www`           | A/CNAME | Vercel (apex redirects to `www`)             |
| `trysynara.com` | MX      | `10 inbound-smtp.eu-west-1.amazonaws.com`    |
| `trysynara.com` | TXT     | `google-site-verification=...`               |
| `trysynara.com` | CAA     | `pki.goog`, `sectigo.com`, `letsencrypt.org` |

Vercel answers for every name (wildcard), so this list and Cloudflare's
auto-scan can both miss records. **The Vercel DNS dashboard is the source of
truth.** Look for DKIM `_domainkey` CNAMEs, `_vercel` TXT, and anything else.

1. **(human, or agent with `cf`)** In NEW, add site `trysynara.com`, Free plan.
2. **(human, or agent with Vercel and `cf` access)** Export every record from Vercel
   DNS and recreate each one in Cloudflare. Set Vercel website records to
   **DNS only** (grey cloud); Vercel handles its own TLS. Keep the CAA
   records: they allow Google and Let's Encrypt, which Cloudflare uses.
3. **(human)** Log in to Namecheap and replace the nameservers with the two Cloudflare
   shows. Propagation is usually minutes, can take hours.
4. Verify before moving on:

   ```bash
   dig +short NS trysynara.com          # Cloudflare nameservers
   curl -sI https://www.trysynara.com   # website still 200
   dig +short MX trysynara.com          # still the Amazon MX
   ```

   Also send a test email to an address on the domain if one is in use.

## Part B: move data and worker

### Before you start

**(human)** `npx wrangler login` opens a browser. Log in as a user that can see
**both** accounts. Kartik must keep that user on the old account until Part B
is done.

```bash
npm ci
npx wrangler login
npx wrangler whoami    # both account IDs must be listed
export OLD=9f9caeb268766deda99bc580c775d50c
export NEW=<Emanuele's account id>
npm test && npm run typecheck && npm run build
```

### How it avoids data loss

Events have integer IDs, so rows cannot be merged into a database that is
already taking new events. Instead the old URL is frozen first: it answers 503,
and the desktop client keeps its queue on disk for any non-2xx. The data is
copied while frozen, then the old URL forwards, and queued events arrive at the
new worker. Crash uploads retry too.

Keep the frozen window short (minutes, not days): the client trims its queue
past 1 MiB.

### Steps

1. Create storage on NEW. Do not run migrations: the export carries the schema
   and the applied-migrations table.

   ```bash
   CLOUDFLARE_ACCOUNT_ID=$NEW npx wrangler d1 create synara-beta-diagnostics
   # note the printed database_id; do not edit wrangler.toml yet
   CLOUDFLARE_ACCOUNT_ID=$NEW npx wrangler r2 bucket create synara-beta-crash-dumps
   ```

   Do not add an R2 lifecycle rule. Nothing expires.

2. Freeze the old worker. This replaces it with the forwarder, no target set.

   ```bash
   CLOUDFLARE_ACCOUNT_ID=$OLD npx wrangler deploy -c forwarder/wrangler.toml
   curl -s -o /dev/null -w "%{http_code}\n" -X POST --data '' \
     https://synara-beta-diagnostics.kartik-9f9.workers.dev/v1/events   # 503
   ```

3. Export from OLD, switch `wrangler.toml` to the new database, import.
   Wrangler resolves the database through `wrangler.toml` even when given the
   name, so the order matters.

   ```bash
   CLOUDFLARE_ACCOUNT_ID=$OLD ./scripts/export.sh
   # set database_id in wrangler.toml to the id from step 1
   CLOUDFLARE_ACCOUNT_ID=$NEW ./scripts/import.sh
   ```

   `export.sh` prints the event and dump counts. `import.sh` prints counts
   from the new database; they must match. It also runs
   `migrations apply`, which must say nothing to apply.

4. Deploy the real worker on NEW. First add the custom domain near the top of
   `wrangler.toml`, above the first `[section]`:

   ```toml
   routes = [{ pattern = "diagnostics.trysynara.com", custom_domain = true }]
   ```

   ```bash
   export CLOUDFLARE_ACCOUNT_ID=$NEW
   npm run build && npx wrangler deploy
   npx wrangler secret put DASHBOARD_PASSWORD        # (human) picks the password
   openssl rand -base64 32 | npx wrangler secret put DASHBOARD_SESSION_KEY
   unset CLOUDFLARE_ACCOUNT_ID
   ```

   Old dashboard passwords and sessions do not carry over. If Kartik should
   keep dashboard access, set `DASHBOARD_PASSWORD_2` for him and send it
   privately. Never commit or paste passwords.

   Verify: log in at `https://diagnostics.trysynara.com`, set the range to
   "All", and check the overview and Issues show the old data.

5. Unfreeze: point the old URL at the new worker.

   ```bash
   CLOUDFLARE_ACCOUNT_ID=$OLD npx wrangler deploy -c forwarder/wrangler.toml \
     --var TARGET:https://diagnostics.trysynara.com
   # must print {"accepted":0,"received":0}, not a Cloudflare 404 page
   curl -s -X POST --data '' https://synara-beta-diagnostics.kartik-9f9.workers.dev/v1/events
   ```

   A worker cannot fetch another worker on the same `*.workers.dev`
   subdomain (it gets a 404). The custom domain avoids that.

   Within an hour or so, the dashboard should show fresh events from current
   Betas.

6. Commit `database_id` and the `routes` line in `wrangler.toml`, and the live
   URL in `README.md`. Then delete the local `export/` folder: it holds real
   user data and is gitignored for that reason.

### Rollback

Before step 5 nothing points at NEW. To undo, restore the real worker on OLD
(its D1 and R2 were never changed):

```bash
CLOUDFLARE_ACCOUNT_ID=$OLD npx wrangler versions list   # last non-forwarder version
CLOUDFLARE_ACCOUNT_ID=$OLD npx wrangler rollback <version-id>
```

After step 5, fix forward on NEW; the old D1 still has everything up to the
freeze.

## Part C: point Synara at the new URL

In `Emanuele-web04/synara`:

1. Change `BETA_DIAGNOSTICS_ENDPOINT` in `apps/desktop/src/betaDiagnostics.ts`
   to `https://diagnostics.trysynara.com`.
2. Change the URL in `docs/diagnostics.md`, and the "maintainers' Cloudflare
   account" wording if you want.
3. Nothing else references the old host (checked with a code search).
4. Ship a Beta. Automatic Betas are off until Emanuele-web04/synara#1328 merges,
   so cut one by hand. Only Betas built after this change use the new URL.

## Part D: cleanup (Kartik)

Only after Part C has shipped:

- Keep the forwarder running on the old account until the dashboard shows no
  events from versions older than the Part C Beta. It costs nothing on the
  Free plan. Do not delete the worker named `synara-beta-diagnostics` there.
- Remove Emanuele's membership (and rename the account to Vex, if not done
  already). Renaming does not change the old URL.
- The old D1 and R2 stay as a backup. Delete them only when Emanuele confirms
  his copy is complete. It is a manual, one-way step, and the dumps can hold
  fragments of app memory, so do not keep them longer than needed.
- Transfer this GitHub repo to Emanuele (Settings → Transfer). GitHub redirects
  the old URL.

## Cost

At current volume the NEW account's Free plan covers D1, R2, and Workers. Not
verified: whether the rate-limit bindings (`[[ratelimits]]`) deploy on Free. If
`wrangler deploy` rejects them, the Workers Paid plan ($5/month) fixes it.

## Gotchas learned the hard way

- `wrangler deploy` does not remove a cron you deleted from config. Keep
  `crons = []` in `wrangler.toml`.
- `wrangler d1` commands use `database_id` from `wrangler.toml` when the name
  matches, even with `CLOUDFLARE_ACCOUNT_ID` set to another account.
- `wrangler secret` values cannot be read back. Set them again instead.
- R2 custom metadata on dumps is not copied. The dashboard reads dump details
  from D1, so nothing depends on it.
- Forwarded requests may reach the new worker from a Cloudflare address, so
  old-URL clients may share one per-IP rate limit (120 requests a minute). Fine
  at current volume; it goes away as clients move to the new URL.
- The historical standalone redactor copy has been replaced by the canonical
  `@synara/shared/diagnosticsRedaction` import (see `README.md`).

## Done means

- [ ] `dig NS trysynara.com` shows Cloudflare; website and email still work
- [ ] New dashboard at `diagnostics.trysynara.com` shows all old data
- [ ] Old URL returns `{"accepted":0,"received":0}` for an empty POST
- [ ] Fresh events arrive on the new dashboard
- [ ] `wrangler.toml` and `README.md` committed; local `export/` deleted
- [ ] Synara endpoint changed and a Beta shipped
- [ ] Kartik: account renamed, membership removed, repo transferred

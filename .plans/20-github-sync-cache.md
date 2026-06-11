# Design Doc: GitHub → Local Cache & Sync Layer for Instant PR Review
**Status:** Proposed (for review) **Scope:** `apps/server/src/review`, `apps/server/src/persistence`, `apps/web/src/lib/reviewReactQuery.ts`, WS transport **Basis:** parallel research on GitHub rate limits + local-persistence options, plus a verified audit of Synara's current data path. Key research facts are in the appendices so this doc stands alone.

* * *
## Problem
Opening a PR review is slow because every open re-shells out to `gh`. Today the path is browser → WebSocket → server → `gh` subprocess **on demand, with zero server-side caching**, and the client `QueryClient` is in-memory only (`apps/web/src/router.ts:11` is a bare `new QueryClient()`). Cold app start, Electron window recreation, and even mid-session navigation (default 5-min `gcTime`) all re-run `gh`, paying the subprocess spawn _and_ the effect/Schema decode every time. Continuous polling across multiple repos would also walk straight into GitHub's secondary rate limits.

The fix must do two things at once: make warm opens **instant**, and make steady-state sync **rate-limit-safe** across many repos and open PRs.

* * *
## 1. Goals & Non-Goals
### Goals
- **G1 — Instant open.** Warm-cache PR open renders from local data before any `gh` call resolves. Target: cached overview/conversation/diff visible immediately on route mount.
  
- **G2 — Rate-limit safety.** Continuous background sync of all tracked repos stays well under GitHub's 5,000 req/hr primary budget and never trips secondary/abuse limits, even with 10+ repos and dozens of open PRs. Conditional requests (ETag/304) are the core lever.
  
- **G3 — Correctness under reconnect.** WS disconnect/reconnect, server restart, and Electron window recreation never serve permanently stale data or lose an in-flight refresh. Stale-while-revalidate always converges to fresh.
  
- **G4 — Multi-repo (forward-compatible, not v1).** The target is **1–2 repos** (see §5). Cache and rate-limit budget are keyed per GitHub _token identity_ so a shared budget pool is *available* if repo count grows — but the v1 build does not need the fleet machinery.
  
### Non-Goals
- **Offline mutation queueing.** Submitting reviews/comments offline is out of scope; writes require connectivity.
  
- **Owning a database of GitHub state.** GitHub stays the source of truth — this is a _cache_, never a bidirectionally reconciled mirror. (This is why ElectricSQL is rejected; see §2.)
  
- **Webhook ingestion in v1.** A desktop app has no inbound HTTPS endpoint. We design for conditional polling; webhooks are a documented future option, not a v1 dependency.
  
- **Client-side persistence as the primary mechanism.** `persistQueryClient` is a complementary later add (P4), not the load-bearing layer.
  
- **GraphQL migration of the whole** `gh` **surface.** Keep the existing `gh pr ...` calls; add GraphQL only where it measurably cuts round-trips.
  

* * *
## 2. Recommended Architecture
### Decision: a server-side SQLite cache in the `ReviewSource` layer, stale-while-revalidate, pushed to the client over the existing WS channel.
Put a SQLite-backed `ReviewCacheStore` behind the read methods in `apps/server/src/review/Layers/ReviewSource.ts`, serve cached normalized rows instantly, fork a conditional `gh`/HTTP refresh in the background, and push fresh results to open clients over a new `review.updated` WS channel.

The cache lives **server-side**, co-located with the `gh` broker, because that is the only place that hits all three targets at once:

| Why server-side wins |     |
| --- | --- |
| **Instant open survives everything** | A warm server cache serves a reloaded web tab, a recreated Electron window, and a second client identically. Client-only persistence is per-renderer. |
| **Skips the expensive work** | Caching the _normalized contract result_ (not raw stdout) skips both the `gh` subprocess spawn _and_ the `decodeGitHubJson` → Schema decode (`GitHubCli.ts:849-875`). |
| **One rate-limit budget** | Every `gh` call already funnels through the server. A server cache with in-flight de-dup means concurrent clients/tabs never multiply `gh` calls. |
| **Infra already exists** | `SqlClient.SqlClient` is in scope for `ReviewLayerLive` (merged at `serverLayers.ts:250` under the root `provideMerge(SqlitePersistence.layerConfig)` at `main.ts:251`). A new table is one migration file + one array entry. The `Projection*.ts` stores are the exact pattern to copy. |
### Alternatives considered
- **Client TanStack Query persist (IndexedDB).** Near-zero effort, real cold-start win — but per-renderer, can't skip server `gh`+decode, no shared cache/budget. **Adopt as a complement (P4).**
  
- **Client TanStack DB** `persistedCollectionOptions`**.** Best client reactivity (live cross-view joins) — but beta API, and still can't beat a warm server cache for cross-session speed or budget consolidation. **Defer to P5.**
  
- **ElectricSQL.** Postgres-read-path sync engine. No Postgres here; GitHub is upstream. **Rejected — architecturally wrong.**
  
- **Dexie.** Duplicates TanStack Query's job; two client data layers. **Rejected.**
  
### How reads serve instantly (stale-while-revalidate)
For each cached read method (`listPullRequests` :182-200, `loadPullRequest` :306-309, `loadConversation` :311-346, `loadChangeset` :299-302):

1. Resolve `repositoryId` (already done at `ReviewSource.ts:160-180`).
  
2. **Read the cached normalized row** keyed by `(repositoryId, resource, reference)`. Present and not hard-expired → **return immediately**.
  
3. **Fork a background conditional refresh** (existing `gitHubCli.*` call, now with `If-None-Match`). On 200, write fresh row + new ETag and **push** over `review.updated`. On 304, bump `last_validated_at` — zero churn, zero primary cost.
  
4. **Cache miss** → fall back to today's synchronous `gh` path, populate the cache, return.
  

The client renders stale-then-fresh: it gets the cached payload synchronously over WS, then a `review.updated` push patches the same React Query key in place via `setQueryData`.
### How refreshes happen
- **ETag conditional revalidation is the primary mechanism.** Store the ETag, re-send as `If-None-Match`; unchanged → 304, empty body, zero primary cost. **Caveat (baked in):** `gh api` has a known bug (cli/cli#2941) returning 200 where `curl` returned 304. **Do not trust** `gh api` **for free 304s** — route conditional probes through a real HTTP client (Octokit/raw HTTPS) with the `gh`-stored token, copying the ETag verbatim (incl. `W/` + quotes). Keep `gh pr view/list` for cold detail.
  
- **GraphQL batching for cold detail.** One GraphQL query pulls detail + commits + `statusCheckRollup` + threads + comments in one call (~1–5 points) vs 4–8 REST round-trips. GraphQL has no 304s, so it's for cold/changed fetches only.
  
- **Webhooks: deferred.** No inbound endpoint on a desktop app; conditional polling is the pragmatic choice and is required as a backstop even when webhooks exist (at-least-once, droppable delivery).
  
### How the client stays reactive
Reuse the existing WS push mechanism (`apps/web/src/wsTransport.ts:180-315`, already carrying `server.config`, `terminal.events`, `orchestration.domainEvent`). Add a `review.updated` channel; on a fresher row the server emits `{ repositoryId, resource, reference }` + payload, and the client maps it to the matching `reviewQueryKeys.*` entry (already `(cwd, reference)`-shaped) and calls `setQueryData`. No refetch, no jitter. Existing mutation invalidation (`reviewReactQuery.ts:188-229`) is untouched.

* * *
## 3. Data Model
One SQLite table per cacheable resource, sharing a common freshness envelope.

**Common freshness columns (every cache table):**

| Column | Type | Meaning |
|---|---|---|
| `etag` | TEXT NULL | Verbatim ETag (incl. `W/` + quotes) for `If-None-Match`. NULL for GraphQL rows. |
| `last_modified` | TEXT NULL | Survives token rotation when ETag doesn't. |
| `fetched_at` | INTEGER | Epoch ms of the last 200 producing this payload. |
| `last_validated_at` | INTEGER | Epoch ms of the last 200 **or** 304. Drives "fresh enough to skip a probe?" |
| `ttl_ms` | INTEGER | Soft TTL: serve instantly within, revalidate past it. |
| `token_identity` | TEXT | Hash of the `gh` token the ETag is scoped to; mismatch forces ETag-free refetch. |
| `head_sha` | TEXT NULL | PR head SHA at fetch time; cheap freshness check for the diff. |

**Tables (migration** `039_ReviewCache`**):**

| Table | Primary key | Payload (normalized contract JSON) | Notes |
|---|---|---|---|
| `review_cache_pr_list` | `(repository_id, list_filter)` | `ReviewPullRequestSummary[]` | The change-detector probe target. |
| `review_cache_pr_overview` | `(repository_id, reference)` | detail + commits + `statusCheckRollup` | One row carries detail+commits+checks (one `gh pr view` today). |
| `review_cache_pr_conversation` | `(repository_id, reference)` | comments + reviews + commits | From `getReviewConversation`. |
| `review_cache_pr_threads` | `(repository_id, reference)` | review threads | GraphQL → `etag` NULL, validated by `head_sha`/`updated_at`. |
| `review_cache_pr_diff` | `(repository_id, reference, head_sha)` | unified diff text | Keyed by `head_sha`: a new push = new row; never refetch an unchanged-SHA diff (the slow 120s call). |

Commits and checks are **not** separate tables — they ride inside the overview row exactly as `getReviewPullRequestOverview` returns them today, so we add no round-trips. **Indexes:** PKs cover point lookups; add `(token_identity)` and `(repository_id, last_validated_at)` for the staleness scan.

* * *
## 4. Sync Flows
**A. Cold open (no cache row).** Mount → resolve `repositoryId` → miss → run today's `gh` path → write row (`etag`/`last_modified`/`head_sha`/`fetched_at`/`token_identity`) → return. Identical latency to today; cold open is never slower, just no longer the common case.

**B. Warm open (cache hit + background revalidate).** Mount → hit → **return cached payload immediately**. (For the diff, if `head_sha` matches the PR's current head — cheap `getPullRequestHeadSha` — skip revalidation.) If `now - last_validated_at ≥ ttl_ms`, fork a conditional refresh: 304 → bump `last_validated_at`, no push; 200 → write fresh + emit `review.updated` → client `setQueryData`. In-flight de-dup: a second client opening mid-refresh attaches to the existing Effect.

**C. Background polling cadence (the rate-limit engine).** Per tracked repo, per cycle: (1) **one conditional REST list probe** (`GET /repos/{o}/{r}/pulls?state=open&sort=updated&direction=desc&per_page=100` with `If-None-Match`); unchanged → 304, 0 primary cost. (2) On 200, only PRs whose `updated_at` advanced get a detail refresh. (3) Push fresh rows over `review.updated`. **Guardrails:** at the 1–2 repo target a fixed 60–120s interval suffices and ETags persisted per page+endpoint (keyed by `token_identity`) are the only must-have. The rest — jitter, a single shared limiter across REST+GraphQL, concurrency ≤10, and adaptive widening on falling `x-ratelimit-remaining`/`-reset` — are for the multi-repo scale-up and can be deferred (see §5).

**D. Invalidation & eviction.** Mutation-driven: `reviewSubmission.submit` + comment mutations bump/clear the affected `(repository_id, reference)` rows (alongside existing client invalidation). Push-driven: a `head_sha` change invalidates the diff row (its key includes `head_sha`, so a new push orphans the old row). Eviction: time-and-size bounded for diffs (drop non-head SHAs older than N days, cap bytes/repo); keep last-known small rows, evict on repo removal. Token rotation: on `token_identity` mismatch, ignore the stored ETag.

* * *
## 5. Rate-Limit Budget (the math)
Budget: **5,000 primary req/hr** per user token. The conditional list poll is the whole game — a 304 probe costs **0 primary**.

**Target scale: 1–2 repos** with ~30 open PRs each, probe every 90s, ~90% of cycles unchanged. {>>Recomputed for 1–2 repos: ~0.4–0.8% of budget. Multi-repo budget pool (G4) and the cross-repo limiter/jitter (§4C) are deferred; P3 ships as a single-repo conditional poll. ETags stay token-keyed so it still scales if repo count grows.<<}{id="c2" by="AI" at="2026-06-07T03:40:00.000Z" re="c1"}

| Component | Per-hour (1 repo) | Primary req/hr |
| --- | --- | --- |
| List probes | 40 cycles; ~90% are 304 (0 cost) | ~4 |
| Detail refresh (changed PRs only) | a handful of PRs move/hr, 1 GraphQL each | ~10 |
| Diff refresh | only on `head_sha` change | ~5 |
| **Total (1 repo)** |     | **~20 req/hr (≈0.4% of budget)** |

Two repos ≈ **~40 req/hr (≈0.8%)**. The headroom is enormous — the probe interval could drop to 30s and still sit under 1%.

**Conditional requests still matter even at one repo.** Naive (no ETags): 30 PRs × ~4 REST calls = 120/cycle; at every 2 min → **3,600 req/hr (72% of budget)** and bursty enough to trip secondary limits. The ETag layer turns frequent polling from "risky" into effectively free.

**What this means for the design.** At 1–2 repos the multi-repo budget pool (G4) and the elaborate §4C guardrails (shared cross-repo limiter, jitter, adaptive backoff) are **over-built — defer them.** P3 can ship as a single-repo, fixed-interval conditional poll with simple serial fetching. Keep `token_identity`-keyed ETags so nothing has to be rewritten if the repo count later grows; just add the fleet machinery then.

* * *
## 6. Phased Migration Plan
Each phase is independently shippable and additive.

- **P1 —** `ReviewCacheStore` **(SQLite) + read-through, no background poll.** _Biggest single win._ Add migration `039_ReviewCache.ts` + register it; new `ReviewCacheStore.ts` copying the `Projection*.ts` pattern; wrap the four read methods in `ReviewSource.ts:182-346` with read-through-then-fork-refresh, caching the **normalized** result; push fresh rows via a new `review.updated` channel. Ships instant warm-open. Refresh is unconditional `gh` here — correctness first.
  
- **P2 — Conditional revalidation (ETag/Last-Modified).** _The rate-limit win._ Add `etag`/`last_modified`/`token_identity`; introduce a real HTTP client (Octokit/raw HTTPS) with the `gh` token for conditional fetches — do not rely on `gh api` 304s (cli/cli#2941); verify end-to-end.
  
- **P3 — Background list-poll change detector.** _Continuous sync._ Scheduled per-repo conditional list probe with shared limiter, jitter, adaptive interval, `x-ratelimit-*` monitoring; drives `review.updated` pushes.
  
- **P4 — Client** `persistQueryClient` **(IndexedDB).** _Complementary cold-start polish._ Replace bare `new QueryClient()` with `PersistQueryClientProvider` + `idb-keyval`; `gcTime ≥ maxAge`, `useIsRestoring`, `buster` = schema/`gh` version.
  
- **P5 — (Optional) GraphQL cold-detail batching + TanStack DB for live cross-view UX.** Collapse cold detail into one GraphQL query; migrate hot collections to TanStack DB `persistedCollectionOptions` only when live cross-view reactivity is wanted (beta API risk).
  
- **P6 — (Optional) Hosted webhook relay.** Only if poll latency proves too high; the §4C poll remains the backstop.
  

* * *
## 7. Risks, Tradeoffs, and Open Questions
**Risks & tradeoffs**

- **Stale-render correctness.** SWR shows stale data for one cycle. Mitigation: aggressive mutation-driven invalidation (own writes never show stale), `head_sha` short-circuit for diffs, optional "updating…" affordance.
  
- `gh api` **304 unreliability (cli/cli#2941).** Mitigated by a real HTTP client (P2), which introduces a second auth path (the `gh`-stored token used directly) — confirm token extraction is stable across `gh auth refresh`.
  
- **ETag invalidation on token rotation.** Handled via `token_identity`, but easy to get subtly wrong; needs a test.
  
- **Restart mid-refresh.** A 200 that wrote the DB but never pushed self-heals on next open/probe — the DB is authoritative, the push is best-effort.
  
- `node:sqlite`**, not better-sqlite3.** The existing client (`NodeSqliteClient.ts`) is `node:sqlite` (`DatabaseSync`, Node ≥22.16/23.11/24). FTS5 search over PR bodies/comments is possible but unverified there; treat search as out of scope until confirmed.
  
- **Diff cache size.** Diffs are large; per-repo byte cap + SHA-based eviction needed.
  

**Open questions for you**

1. **Conditional-fetch HTTP path:** Octokit vs hand-rolled raw HTTPS with the `gh` token? _Recommendation: Octokit for the conditional/poll path, keep_ `gh` _for cold detail._
  
2. **Default list-probe interval:** 60 / 90 / 120s (all <2% budget)? _Recommendation: 90s adaptive._
  
3. **Which repos are "tracked" for background polling?** _Recommendation: repos with an open review view + a short LRU of recently-viewed; nothing background-polls what you're not looking at._
  
4. **GraphQL cold-detail in P2 or P5?** _Recommendation: P5; P1–P3 already hit instant-open + rate-limit safety with existing_ `gh` _calls._
  
5. **P4 (client persist) before or after P1 (server cache)?** _Recommendation: P1 first — it's where instant-open and rate-limit safety actually come from._
  

* * *
## Appendix A — GitHub rate-limit facts (verified)
- **Primary limits:** REST authenticated **5,000 req/hr** (15,000 on Enterprise Cloud); unauthenticated 60/hr; GitHub App installation 5,000/hr base (+50/hr per repo/user over 20, cap 12,500); Search API **30 req/min** (separate bucket); GraphQL **5,000 points/hr** (points ≠ requests; min cost 1; 500k-node hard cap per query).
  
- **Conditional requests:** a **304 Not Modified does NOT count against the primary limit** when correctly authorized. ETags are **per-page** and **token-scoped**; copy verbatim incl. `W/` and quotes. **GraphQL has no conditional requests.** A 304 still costs a secondary-limit point — throttle.
  
- **Secondary/abuse limits (these ban integrations):** >100 concurrent requests (shared REST+GraphQL); >900 points/min on one REST endpoint; >2,000 points/min on GraphQL; >90s CPU/60s real; content creation >80/min or >500/hr. Backoff: `retry-after` → `x-ratelimit-reset` → ≥60s → exponential. Make requests serially; ≥1s between writes.
  
- **Webhooks** cover it all (`pull_request` incl. `synchronize`, `pull_request_review`, `pull_request_review_comment`, `issue_comment`, `check_run`, `check_suite`, `status`) — but need an inbound endpoint a desktop app lacks; polling is the pragmatic path and a required backstop.
  
- **gh CLI:** `gh api` attaches the token, but **does not reliably honor conditional requests** (cli/cli#2941) — use a real HTTP client for 304s. GraphQL is cheaper than many REST calls for one cold PR overview.
  

Sources: GitHub REST rate-limits & best-practices docs, GraphQL rate-limits doc, GitHub Apps rate-limits, webhook events reference, cli/cli#2941.
## Appendix B — Local-persistence options (ranked for this app)
1. **TanStack Query +** `persistQueryClient` **(IndexedDB)** — lowest effort, instant cold-start, complements existing TanStack Query. Gotchas: `gcTime ≥ maxAge`, `useIsRestoring`, `buster` per schema/`gh` version.
  
2. **TanStack DB 0.6** `persistedCollectionOptions(queryCollectionOptions(...))` — best client reactivity (live cross-view joins, differential dataflow), SQLite-backed persistence; beta API.
  
3. **better-sqlite3 /** `node:sqlite` **server-side** — durable shared cache co-located with `gh`; one rate-limit budget; the load-bearing layer here.
  
4. **Dexie / IndexedDB direct** — duplicates TanStack Query; redundant.
  
5. **ElectricSQL** — Postgres-sync engine; wrong tool (no Postgres upstream).
  
## Appendix C — Synara integration points (file:line, verified)
| Concern | Location |
|---|---|
| `gh` exec + timeouts | `apps/server/src/git/Layers/GitHubCli.ts:877-887`, `:30-31` |
| JSON decode+normalize (cache its output) | `GitHubCli.ts:849-875`, `:969-1010` |
| **Cache wrapper insertion point** | `apps/server/src/review/Layers/ReviewSource.ts:182-346` |
| `repositoryId` cache key | `ReviewSource.ts:160-180` |
| Cache-key contract shape | `packages/contracts/src/review.ts:25-36` (`ReviewTargetKey`) |
| Review layer wiring (SQL in scope) | `apps/server/src/serverLayers.ts:250` |
| SQLite client / WAL | `apps/server/src/persistence/NodeSqliteClient.ts`, `persistence/Layers/Sqlite.ts` |
| DB provided at root | `apps/server/src/main.ts:251` |
| New table registration | `apps/server/src/persistence/Migrations.ts` (add `039_ReviewCache`, currently 38) |
| Store pattern to copy | `apps/server/src/persistence/Layers/Projection*.ts` |
| Existing per-target persistence precedent | `apps/server/src/review/Layers/ReviewCommentStore.ts` |
| WS push channel to reuse | `apps/web/src/wsTransport.ts:180-315` |
| Client cache (no persistence today) | `apps/web/src/lib/reviewReactQuery.ts`; bare `new QueryClient()` at `apps/web/src/router.ts:11` |

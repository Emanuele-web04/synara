# Native Notion provider

Status: implementation under review, not a production-ready Enterprise release. Tracks #1933. Independent of Code-OSS.

## Architecture

Synara Settings and Tasks → existing authenticated WebSocket → owner-gated Notion integration → official Notion API. Notion remains an external data provider. No iframe, webview, alternate navigation, duplicate task manager, or agent orchestration engine is introduced.

Provider tasks are projected into the existing TodoService event stream. Their stable identity includes the Notion workspace, bot, and page ID. Raw Notion properties remain in a bounded private cache. Native chat links and agent execution metadata remain local. Completing an agent run never completes a Notion record.

## Operator deployment

A confidential OAuth client must run on a trusted hosted backend, not inside Electron. Register a public Notion integration and configure its redirect URI as `https://YOUR-BROKER/oauth/notion/callback`. Configure only the capabilities needed by the organization, including content and comments as appropriate. Workspace administrators can restrict third-party integrations. Synara does not bypass these controls.

Run `bun apps/server/src/notion/brokerMain.ts` as a single service behind a TLS reverse proxy. The process binds to loopback. Supply these settings through the deployment secret manager:

- `SYNARA_NOTION_BROKER_ORIGIN`: the public HTTPS origin, without a path.
- `NOTION_CLIENT_ID` and `NOTION_CLIENT_SECRET`: the public integration's confidential client credentials.
- `SYNARA_NOTION_BROKER_STORE`: an absolute private persistent file path.
- `SYNARA_NOTION_BROKER_KEY`: a base64-encoded random 32-byte AES key. Keep a protected backup separately from the encrypted store.
- Optional `SYNARA_NOTION_BROKER_PORT`, default 4387.

On the Synara server, set `SYNARA_NOTION_BROKER_URL` to the hosted HTTPS origin. No client secret, refresh token, or bearer token is exposed through the renderer RPC responses. Local provider credentials use Synara's existing private ServerSecretStore. The hosted store is encrypted with AES-256-GCM. This is not a claim that local storage uses an operating-system keychain.

Terminate TLS at a trusted proxy, bound request sizes, disable query/body/authorization logging, and apply per-client rate limits. Run one broker instance per store. Multi-replica deployments require transactional shared storage and are not supported by this file adapter. Back up the encrypted store and encryption key with separate access controls. Monitor generic storage and maintenance failures without logging OAuth codes or tokens.

## OAuth and permissions

The system browser performs the official authorization-code flow. A short-lived state is tied to an HttpOnly secure browser cookie. A separate proof protects the desktop-to-broker transaction redemption. This proof is not represented as Notion PKCE. No unsupported Notion scopes are assumed.

The broker performs code exchange, token refresh, and revocation. Interrupted code or refresh exchanges are not blindly replayed. Reconnect is required when a refresh outcome is uncertain. All Notion RPCs are restricted to the authenticated Synara owner. Non-owner task snapshots and streams exclude Notion rows.

Existing unscoped agent Todo tools cannot list or update Notion records. Direct provider tools require an owner-enabled mapping and respect its Synara project. Reads and writes are distinct grants. Every agent mutation uses the existing per-call approval queue, with original and proposed values shown in the approval card; session-wide approval is refused. Mapping, project, relation-target and resource ancestry checks are repeated after asynchronous operations, approval, rate-limit waits and token refresh. A connection alone grants no agent access. Agent receipts are never automatically retried without a fresh approval.

## Mapping and synchronization

Mappings use property IDs and validated types rather than display names. Unsupported properties are preserved. Formula and rollup outputs are read-only. Richly formatted fields are not flattened by the native plain-text task editor. A block editor edits individual text runs and preserves unsupported runs.

A 60-second scoped poll performs incremental task queries with a short overlap and a full reconciliation every 15 minutes. A restart starts with a full query. Pagination must finish before missing records can be removed. Cache bounds are 50 mappings, 5000 records per source, and 10000 records total. Larger sources are refused rather than partially interpreted as deleted data.

Writes enter a durable journal before delivery. Definite rate-limit responses may retry. Uncertain creates, comments, and appends are never automatically replayed. Field-level preflight comparison retains conflicting edits for explicit owner review. Unknown remote fields are never replaced as a side effect of updating a known property.

The Notion API does not provide a transactional compare-and-swap guarantee for this client. Another writer can still change a resource between preflight and mutation. This implementation does not claim distributed serializability or complete prevention of every cross-client lost-update race. Closing this gap is an acceptance item before production deployment.

Disconnect immediately removes locally served data and then requests remote revocation. If revocation fails, a restricted capability is retained to retry it. Revoke the integration in Notion itself when the old broker is unavailable. Expiring Notion media URLs are fetched as part of the current page response rather than treated as permanent assets.

## Compatibility matrix

| Area                               | Implemented behavior and remaining limits                                                                                                                                                                                                                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OAuth and credentials              | Confidential broker, refresh, revocation and private storage; fixture-tested, not live-workspace verified.                                                                                                                                                                                                            |
| Settings and existing Tasks        | Native connection controls, property-ID mappings, stable Tasks projection and manual delegation. No parallel task system.                                                                                                                                                                                             |
| Task and record properties         | Native editing of writable mapped fields, rich text, assignees and complete relations. Original values remain the conflict baseline. Formula/rollup and incomplete fields stay read-only.                                                                                                                             |
| Sprint planning                    | Paginated relation-backed sprint discovery, product/sprint backlogs, current/upcoming/completed phases, workload and point summaries, moves and sprint creation. Totals explicitly describe loaded-page/filter limits; elapsed dates do not mark a sprint complete.                                                   |
| Epics, milestones and dependencies | Editable mapped relations and dependency/blocker summaries. A dedicated full project-roadmap workflow is still incomplete.                                                                                                                                                                                            |
| Database views                     | Table, list, grouped board, month/week calendar and horizontal timeline. Table filtering/sorting reaches the data-source API; board and sprint moves have selection alternatives to drag/drop. Calendar and timeline open native property editors. Date-only moves preserve ranges; timed values use the full editor. |
| Wiki and documents                 | Nested block navigation, rich-text run formatting, preserved mentions, supported block/table editing, slash insertion, insert-after, references and HTTPS media links. Unsupported blocks remain read-only. Arbitrary existing-block reordering and native file uploads are not complete.                             |
| Search                             | Contextual page-title and database-record discovery. Global search-palette integration and generalized full-text indexing remain unimplemented.                                                                                                                                                                       |
| Comments                           | Paginated page discussion reads, creation and supported discussion replies.                                                                                                                                                                                                                                           |
| Agent tools                        | Owner/project-scoped discovery, queries, record/nested-block reads and separately approved mutations. No credentials in tool results, destructive archive/delete tools or automatic status completion.                                                                                                                |
| Sync and conflict journal          | Polling, bounded pagination, stable identities, durable receipts and explicit conflict handling. No transactional compare-and-swap guarantee; live cross-client tests remain.                                                                                                                                         |
| Webhooks                           | Not implemented. Desktop-compatible polling remains the synchronization path.                                                                                                                                                                                                                                         |
| Platforms                          | Platform-neutral implementation. Native macOS/Windows/Linux OAuth and packaged application verification remain.                                                                                                                                                                                                       |
| UI evidence                        | Real Chromium screenshots of these React components using deterministic fixture data; not live Notion or complete-app end-to-end proof.                                                                                                                                                                               |

API version: `2026-03-11`. Current Notion APIs expose data sources and saved views. These native views do not pretend to reproduce Notion's saved view configuration. Search is title-oriented, not generalized full-text search. SAML, SCIM, global user administration, and Enterprise Admin APIs are outside scope.

## Validation evidence

The October 15 recovery reconstructed the published `ac2d3c1` source tree exactly before applying the existing continuation. Targeted server/shared/web fixtures and scoped TypeScript checks validate the recovered implementation, including denied/revoked approvals, moved records, dispatch-time authorization, mention preservation, and date-range handling. Detailed executed commands, counts and screenshots belong to PR #1937's evidence record.

A bounded full server typecheck did not finish in the local environment; scoped Notion server and web typechecks passed. Do not treat that as a passing full-workspace typecheck or infer live OAuth success. The PR remains draft until the remaining acceptance items and deployment verification are addressed. Temporary recovery tooling is not part of the final product tree.

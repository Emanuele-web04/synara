# Cloudflare Remote — local qualification

2026-09-28, macOS arm64, Node 24.21.0 / Bun 1.4.2. Branch `codex/cloudflare-remote-mvp`, based on `42aa8fb4f093f78fe7a1f7be5525f67571086ebf`. No merge, release, production deployment or iOS changes.

## What is implemented

The account API owns managed tunnel/DNS allocation and recovery, and returns a connector credential only to the authenticated execution host. The controller receives a directory endpoint and continues using the existing pinned TLS 1.3, grants, exact-device trust, sessions and resource gateway. A dedicated loopback listener exposes only the remote WebSocket and minimal health route. The application no longer needs the Bun relay or its secrets.

The normal UI uses a nine-minute, single-use code, comparison of the complete host root fingerprint, and explicit approval of the exact requesting device key. Settings rows, buttons, inputs and checkbox primitives were reused; no new UI primitive or dependency was introduced. The historical private-file CLI invitation is retained. API authorization polling replaces relay revocation delivery, with a fail-closed 60-second lease and durable revocation acknowledgements.

The connector version and official asset SHA256 hashes are pinned. Desktop staging places it outside asar and includes its license/signing path. Shared process boundaries own spawn and verified teardown. The existing Effect dependency patch also retains signal ownership during asynchronous finalization, avoiding premature termination by a later `signal-exit` handler. A second explicit signal still forces exit.

## Verification commands and results

Use a disposable PostgreSQL database for commands needing `TEST_DATABASE_URL`. The local database was isolated at 127.0.0.1:58433; it is not operator or production data. The API and E2E database suites ran sequentially.

| Check                                                                                          | Result                                                                                                                                          |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile`                                                                | Passed; no new package or version changes. Existing Effect patch extended in source and compiled runtime.                                       |
| `bun run fmt:check`                                                                            | Passed on the final code and documentation.                                                                                                     |
| `bun run lint`                                                                                 | Passed, 0 errors / 792 existing warnings.                                                                                                       |
| `bun run typecheck`                                                                            | Passed, 13/13 tasks.                                                                                                                            |
| `env -u TEST_DATABASE_URL bun run test`                                                        | Passed after the shutdown fix: 11/11 tasks, 13,914 tests passed / 246 skipped (no database/build opt-ins); 5m10.722s.                           |
| `TEST_DATABASE_URL=… bun run --cwd apps/api test`                                              | 318/318 passed, including PostgreSQL coordinator and rendezvous cases.                                                                          |
| `bun run --cwd apps/server test src/cloudflare src/hostConnectivitySupervisor.test.ts`         | 13/13 passed.                                                                                                                                   |
| `bun run build`                                                                                | Passed, 10/10 tasks. Nonfatal chunk-size, Browserslist age and empty-output task warnings.                                                      |
| `TEST_DATABASE_URL=… SYNARA_E2E_WORKSPACE=1 SYNARA_E2E_EVIDENCE=… bun run --cwd apps/e2e test` | 16/16 passed on the final built path, including verified shutdown (77.95 seconds).                                                              |
| `bun run windows-runtime:check`                                                                | Passed across 279 application source files. Static boundary evidence, not Windows runtime evidence.                                             |
| `bun run migrations:check`                                                                     | Passed; migration identity preserved across 91 released tags, v0.0.16 through v0.9.2.                                                           |
| Isolated Electron app.asar connector smoke                                                     | Passed on Electron 43.4.1 / Node 24.18.1 with actual verified cloudflared 2026.9.3; process start and teardown proven. No live edge connection. |

Root tests without explicit environment variables skip database/build-dependent tests. The API and E2E commands above execute those cases separately; their counts overlap root tests and must not be added as unique tests.

## Acceptance evidence

- Cloudflare boundary tests validate fixed API origin, bounded errors without token/body leakage, exact ingress path, restricted loopback port and refusal to overwrite foreign DNS. PostgreSQL tests cover concurrent requests, lost create responses, DNS failure, unlink during provisioning, failed cleanup, generation fences and a delayed disable that must not retire the next allocation.
- Rendezvous tests cover cryptographic device proof, same account/workspace, atomic concurrent redemption, replay, expiry, cancellation, renewal, revoked devices, changed host identities and shared rate budgets. Fresh WorkOS membership is required for provisioning and authorization snapshots.
- The HTTPS fixture terminates public TLS and forwards opaque bytes to the dedicated ingress; it runs a connector subprocess under the production supervisor. Public verification uses a scoped ephemeral CA. Inner TLS is real and a substituted root is rejected.
- End-to-end checks cover byte-identical text/binary traffic, direct transport reuse, spent grants, account outage, selective session close/expiry, a 4 MiB ordered backpressure burst, and account revocation delivered by polling.
- Two real browser pages create/redeem a code, compare the full root, approve the exact device key, reload and connect. Separate built controller and execution servers exercise files, Git, terminal, a 512 KiB hash-checked attachment and Range requests.
- A deterministic provider continues producing a delta while the connector is interrupted. Reconnect restores that delta without page reload, a new provider PID, or a duplicated turn. Controller stop/restart preserves execution-host work. Approval and Stop persist the interrupted state. Revocation cuts RPC/resources, and the UI returns to local work with the remote host stopped.
- The final workspace test checks both provider and connector PID exit. Its harness rejects signal-forced shutdown instead of treating the root process disappearing as cleanup success. Final process inspection found no fixture connector/server remnants; the personal listener at 127.0.0.1:7265 was preserved.

## Failures found and resolved

The first transport run exposed TLS ciphertext coalescing beyond the bounded outer WebSocket payload. Writes now split into 64 KiB chunks with backpressure; the limit was not relaxed. Browser recovery required an explicit ten-second wait for the persisted approval record. An ingress test's fetch implementation discarded a custom Host header; the test now uses the actual Node HTTP boundary. Type errors in new test fixtures were corrected.

The final process audit found a connector orphan despite passing functional tests. Reproduction showed `signal-exit` could re-raise SIGTERM after Effect removed its handler, killing Node before connector finalizers. The existing Effect patch now retains ownership until teardown, with a subprocess regression and built workspace PID assertions. The reproduction failed before the correction and passed afterwards. Earlier orphaned fixture PIDs were explicitly terminated; no operator processes were targeted.

## Artifacts and reproduction

Source scenarios: `apps/e2e/src/pairing.e2e.test.ts`, `workspace.e2e.test.ts`, `checkpoint.e2e.test.ts`; Electron smoke source: `apps/desktop/scripts/cloudflared-smoke.ts`. The smoke was bundled with `bun build … --target=node --external=electron`, archived with the installed `@electron/asar`, and run from `Resources/app.asar` next to `Resources/cloudflared/cloudflared`. It starts a local Access listener without a client or credentials; this proves executable loading and shared teardown, not a managed tunnel handshake or signed application distribution.

Task artifact directory: `/Users/emanueledipietro-macmini/.codex/visualizations/2026/09/28/01a0e737-6f66-7340-a97d-eada9d6c3680/cloudflare-remote/`. It contains `checks.json` and screenshots `pairing-code.png`, `pairing-root-comparison.png`, `pairing-exact-device-approval.png`, `workspace-remote.png`, `workspace-local-recovery.png`. All codes/identities shown belong to destroyed fixtures. Full temporary command logs remain under `/private/tmp/synara-cloudflare-*.log`; they are not committed.

## Not live-qualified

No real Cloudflare resource, WorkOS tenancy, paid provider session or customer entitlement was used. This does not establish two physical Macs on separate networks, real sleep/wake behavior, cloud latency, quota/cost suitability, signed/notarized distribution, Windows/Linux/universal-Mac execution, or a 24/7 soak with real credential renewal. The test allowlist is not billing authority; commercial rollout remains blocked.

The single external next step is to select and securely configure the isolated live test environment described in [the operations guide](../../cloudflare-remote.md): one account API/issuer, one PostgreSQL database, test WorkOS organization/login, a dedicated Cloudflare zone with a scoped API token, and test build access on both Macs. Configure secrets in the hosting/secret channel, not chat. Confirm the Cloudflare account's current plan, allowed product use and quotas before provisioning. Then run phase 9 of [PLAN.md](PLAN.md), including different networks, recovery, revocation and a declared soak duration.

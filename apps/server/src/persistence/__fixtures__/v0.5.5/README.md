# Synara v0.5.5 Windows migration fixture

`synara-v0.5.5.sqlite` is an immutable, sanitized SQLite database produced by the
published Synara v0.5.5 Windows desktop package. It exists to exercise the real
released migration lineage, especially the historical migration 54 identity
`ProjectPullRequestPins`, through the current production persistence startup.

The fixture contains no real project, thread, user, provider, authentication, or
automation data. Its only application row is this synthetic pin:

```text
project_id: fixture-project
repository_key: example.invalid/fixture/repository
pull_request_number: 55
```

The authoritative byte identity is:

```text
size: 385024 bytes
SHA-256: fe4eb795121d62dfe37e6ff15e961bf24f5fe9d6121f78dde39ab8910fdf02dc
```

This fixture closes the released-artifact coverage gap tracked by
[#406](https://github.com/Emanuele-web04/synara/issues/406). The original Windows
failure in [#393](https://github.com/Emanuele-web04/synara/issues/393) and its
implementation in [#396](https://github.com/Emanuele-web04/synara/pull/396)
cover read-only SQLite sync handling and historical tracker reconciliation. This
fixture is intentionally narrower: it proves those migration semantics against
bytes produced by the published Windows application instead of reconstructing
the old lineage with current migration code.

## Release provenance

The source was the official published Windows package, not a local build,
current source checkout, migration replay, or npm package.

| Evidence         | Recorded value                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Release          | [Synara v0.5.5](https://github.com/Emanuele-web04/synara/releases/tag/v0.5.5), ID `355430801`, published `2026-07-17T01:42:40Z` |
| Asset            | `Synara-0.5.5-x64.exe`, ID `479827056`, 185277552 bytes                                                                         |
| Asset SHA-256    | `a61ffa7dce8babf9b04ab417a63fb788277244e23e95d19995848a4d618630d9`                                                              |
| Annotated tag    | `b33638f8c6e6a0d85ec4a7af8c7685da8ea8a247`, unsigned                                                                            |
| Release commit   | `9be46c3ce6a7521b64436b7334bc6fce16e3cac4`                                                                                      |
| Release workflow | Successful `Release Desktop` run [29547141464](https://github.com/Emanuele-web04/synara/actions/runs/29547141464)               |
| Authenticode     | `NotSigned`; the bytes matched GitHub's published SHA-256 before extraction                                                     |

`manifest.json` records the release, workflow, asset, packaged executable,
ASAR, backend-entry, raw SQLite compound-file, and sanitized-fixture hashes.

## Isolated capture procedure

The capture ran on native x64 Windows in a new directory outside the repository:

1. Download the release asset and require its size and SHA-256 to match the
   manifest. Record Authenticode status before unpacking.
2. Fetch `7zip-bin@5.2.0` with `npm pack`, expand that package archive, and use
   its 7-Zip 21.07 x64 executable to unpack the installer without installing it:

   ```powershell
   npm pack 7zip-bin@5.2.0 --pack-destination '<capture-root>\tools'
   tar -xf '<capture-root>\tools\7zip-bin-5.2.0.tgz' -C '<capture-root>\tools'
   & '<capture-root>\tools\package\win\x64\7za.exe' x '<capture-root>\download\Synara-0.5.5-x64.exe' '-o<capture-root>\unpacked' -y
   ```

   The extractor reported six unsupported ARM64 `node-pty` entries. Every x64
   runtime file used by the capture was present and independently hashed.

3. Do not expand `app.asar`. Use the packaged Electron runtime's ASAR-aware
   filesystem to hash the backend entry in place:

   ```powershell
   $env:ELECTRON_RUN_AS_NODE='1'
   & '<capture-root>\unpacked\Synara.exe' -e "const {createHash}=require('node:crypto');const {readFileSync}=require('node:fs');const bytes=readFileSync(process.argv[1]);console.log(JSON.stringify({sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}));" '<capture-root>\unpacked\resources\app.asar\apps\server\dist\index.mjs'
   Remove-Item Env:ELECTRON_RUN_AS_NODE
   ```

   Require the extracted executable, `resources/app.asar`, and packaged server
   entry hashes to match the manifest.

4. Create fresh `<capture-root>\profile`, `<capture-root>\profile\Temp`, and
   `<capture-root>\synara-home` directories.
5. Clear the inherited process environment. Add only the environment-variable
   names in the manifest. Redirect `USERPROFILE`, `HOME`, `HOMEDRIVE`,
   `HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`, and `SYNARA_HOME` into
   `<capture-root>`. Use a synthetic Windows identity and local-only auth token,
   a Windows-system-only `PATH`, desktop mode, no browser, disabled telemetry,
   disabled project auto-bootstrap, and disabled Claude keepalive. Do not expose
   provider, GitHub, Codex, proxy, or other user credentials.
6. Confirm `os.homedir()` resolves under `<capture-root>\profile`, then run the
   packaged backend directly:

   ```text
   <capture-root>\unpacked\Synara.exe --max-old-space-size=8192 <capture-root>\unpacked\resources\app.asar\apps\server\dist\index.mjs
   ```

7. Do not import a project or launch a coding agent. Wait for the packaged
   backend to report migrations 1 through 54, including migration 54
   `ProjectPullRequestPins`.
8. Deliver Ctrl+C to the packaged backend PTY and wait until its process tree has
   exited and its server port has no listener. The observed process exit code was
   `1`; all processes and listeners were gone before the database was read.
9. Keep the raw `state.sqlite`, `state.sqlite-wal`, and `state.sqlite-shm`
   together. Open them read-only and verify integrity, foreign keys, the exact
   1-through-54 tracker, migration 54, and the pin schema. Never copy these raw
   files into the repository.

The profile and environment controls prevent the released process from reading
pre-existing Synara or coding-agent state. The raw capture is deliberately not
redistributed.

This was process-local isolation, not Windows Sandbox or Hyper-V. The host
network was not disabled, but the environment inherited no proxy or provider
credentials and the only observed network activity was the packaged backend's
local loopback listener. That limitation is recorded explicitly in the manifest.

## Sanitization procedure

Sanitization operates only on an offline logical backup that incorporates the
released process's committed WAL. It never modifies the raw capture or this
fixture.

1. Create an offline backup with the `node:sqlite` backup API after the packaged
   process exits.
2. On the backup, set `journal_mode=DELETE`, disable foreign-key enforcement for
   row removal, and enable `secure_delete`.
3. Delete every application row while preserving `effect_sql_migrations`.
4. Clear `sqlite_sequence` and insert only the documented synthetic pin.
5. Run `VACUUM`.
6. Reopen read-only and require `PRAGMA integrity_check` to return `ok`,
   `PRAGMA foreign_key_check` to return no rows, `freelist_count` to be zero,
   journal mode to be `delete`, and no WAL or SHM sidecars to exist.
7. Require migration IDs 1 through 54 exactly, migration 54
   `ProjectPullRequestPins`, the expected three-column composite primary key,
   positive pull-request-number check, and 20-pin limit trigger.
8. Record every application-table row count. Require only 54 migration rows and
   the one synthetic pin; every other table must be empty.
9. Scan the final bytes for user-profile paths, email addresses, private-key
   headers, bearer credentials, GitHub/OpenAI/AWS token shapes, JSON web tokens,
   and capture-machine identifiers. Require zero hits.
10. Verify the final size and SHA-256 against the manifest before copying it to
    this directory.

The final database has 26 tables including `sqlite_sequence`, 61 indexes
including SQLite autoindexes, one trigger, and one view. Its tracker contains
exactly IDs 1 through 54; every application table is empty except for the 54
tracker rows and one synthetic pin. The raw compound database remains outside
the repository. After independent fixture and regression verification, the
exact disposable capture root—including the raw database, isolated profile,
installer, extraction tool, and unpacked package—was permanently deleted at
`2026-07-18T21:48:52Z`; no copy is retained.

## Manual verification

From the repository root on PowerShell, verify the immutable identity:

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath apps/server/src/persistence/__fixtures__/v0.5.5/synara-v0.5.5.sqlite
```

Expected hash:

```text
FE4EB795121D62DFE37E6FF15E961BF24F5FE9D6121F78DDE39AB8910FDF02DC
```

Then run the focused native-Windows regression:

```powershell
bun run --cwd apps/server test src/persistence/MigrationBackup.test.ts
```

The test must pass after verifying the literal hash, manifest census, privacy
patterns, source tracker and pin schema, pre-migration backup, canonical
1-through-69 upgraded tracker, synthetic-row preservation, database integrity,
and unchanged source-fixture hash. `git diff --check` must also return success.

## Test use and update policy

Tests must first verify the checked-in fixture's literal SHA-256 and manifest,
then copy it to a unique disposable directory. Only that copy may be opened by
the writable production persistence layer. Tests independently validate the
pre-migration backup, upgraded database, synthetic data, canonical migration
tracker, integrity, and unchanged fixture hash.

Do not edit or regenerate this database in place. A future fixture must use a new
version directory, a newly verified published package, a complete manifest, and
the same isolation, sanitization, privacy, and immutable-copy rules.

The fixture contains only MIT-licensed released schema/migration output and
synthetic data; it contains no installer, executable, third-party database, or
user content. It is distributed under the repository's
[MIT license](../../../../../../LICENSE): Copyright (c) 2026 Emanuele Di Pietro.

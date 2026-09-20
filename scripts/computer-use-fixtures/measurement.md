# Computer Use measurement collector

`collect-measurement.ts` collects bounded evidence from the existing authenticated
Synara diagnostic tools. It does not launch applications, create threads, grant
permissions, or open the live SQLite database. The application deliberately owns
that database exclusively; another SQLite client cannot safely read it while the
app runs, and copying its database and WAL files separately is not a snapshot.

Use an isolated benchmark instance and an existing gateway session authorized for
`diagnostics:read`. Preserve the gateway URL/token environment supplied to that
session; do not put credentials in command arguments or reports. Capture an ISO
timestamp **before creating a fresh thread**, run one task, wait for its provider
turn to finish, then run:

```sh
nice -n 10 bun scripts/computer-use-fixtures/collect-measurement.ts \
  --thread-id "$BENCHMARK_THREAD_ID" \
  --turn-id "$BENCHMARK_TURN_ID" \
  --started-at "$BENCHMARK_STARTED_AT" \
  --out /private/tmp/computer-run-measurement.json
```

`SYNARA_AGENT_GATEWAY_URL` identifies the isolated loopback `/mcp` endpoint;
`SYNARA_AGENT_GATEWAY_TOKEN` must be an existing active session token. The collector
does not discover credentials or exchange single-use provider bootstrap tokens.
The output must not already exist and is created with mode `0600`. Exit 0 means
the measurement gates passed; 2 means the saved report is invalid; 1 means the
collector could not obtain/save trustworthy evidence.

The importable `collectComputerRun(callTool, scope)` accepts a caller that returns
the diagnostic tool's decoded JSON result, so an existing authenticated MCP
harness can reuse its own transport. The [packaged fixture runner](packaged-e2e.md)
instead uses the authenticated owner `server.readThreadDiagnostics` RPC, whose
readers are shared with those MCP tools; it needs no borrowed provider token.
`scope.auditEntries` optionally cross-checks
already-read audit entries for the exact thread and turn. Audit entries without a
turn ID are counted as unscoped and ignored. The audit records mutations only,
has no call IDs and is bounded; its row count is never a total-tool-call metric.

The collector requires a durable thread-creation event after the supplied start
timestamp, exactly one turn dispatch, retained session/turn start and completion,
stable pagination, complete tool lifecycles and cumulative usage counters.
It deduplicates started/completed events by call ID (or canonical item ID), reports
Computer calls by name, counts native command/search/edit calls by their canonical
type when no tool name exists, and never writes tool arguments or transcript text into
the report. The reported wall clock runs from the durable turn-dispatch timestamp
to provider completion, not from a UI click or final rendering.

Usage reports use explicit `cumulativeUsage` totals/deltas. Cached input is a
subset of input and is not added twice; output is separate. Missing or redacted
totals, missing cache counts and counter resets invalidate the run. Currently
Codex emits this explicit cumulative contract. Other providers' latest-request
snapshots are not a substitute; their accounting support remains unverified until
their adapters supply an equally explicit total contract.

This is measurement infrastructure, not packaged-app acceptance. A valid report
does not prove task success, background isolation, Escape handling, permission
behavior or nine-provider/Linux support. The focus sampler, window/Dock observer
and task-specific assertions must supply those independent acceptance results.
The existing focus probe's default `ok` is a sample-count gate; strict acceptance
must additionally require measured focus/Space fields and no excluded intervals.

Tests (no provider credentials or native input required):

```sh
nice -n 10 bun run --cwd scripts test computer-use-fixtures/measurement.test.ts
nice -n 10 bun run --cwd apps/server test src/agentGateway/diagnosticCursor.test.ts
```

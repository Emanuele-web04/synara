/**
 * HttpDaytonaSandboxClient - the real Daytona REST client (credential-gated).
 *
 * Selected only when `DAYTONA_API_KEY` is configured; otherwise the adapter uses
 * the fake client. Endpoints map to the documented Daytona REST API (base
 * `{api}` is `DAYTONA_API_URL`, default `https://app.daytona.io/api`):
 *
 *   - `POST   {api}/sandbox`                          create / resume
 *   - `GET    {api}/sandbox/{id}`                     status (reconnect)
 *   - `POST   {api}/sandbox/{id}/start`               start / activity refresh
 *   - `POST   {api}/sandbox/{id}/stop`                stop (FS persists)
 *   - `POST   {api}/sandbox/{id}/archive`             archive before delete
 *   - `DELETE {api}/sandbox/{id}`                     destroy
 *   - `POST   {api}/sandbox/{id}/snapshot`            snapshot
 *   - `GET    {api}/sandbox/{id}/ports/{port}/preview-url`  preview URL
 *   - `POST   {api}/toolbox/{id}/process/execute`     fire-and-collect exec
 *   - `POST   {api}/toolbox/{id}/process/session`     create a session
 *   - `POST   {api}/toolbox/{id}/process/session/{sid}/exec`  async session command
 *   - `GET    {api}/toolbox/{id}/process/session/{sid}/command/{cid}`       command status (exit code)
 *   - `GET    {api}/toolbox/{id}/process/session/{sid}/command/{cid}/logs`  command output
 *   - `POST   {api}/toolbox/{id}/process/session/{sid}/command/{cid}/input` stdin
 *
 * Credential safety: the bearer token, any tokenized URL, and a preview-URL token
 * never reach a log or an error detail — every failure runs through
 * {@link redactSecrets} with those values registered, and the adapter logs only
 * sandbox ids and exit codes.
 *
 * `startSession`: Daytona has no duplex stdio socket over plain REST, so a
 * long-lived process runs as an async session command. Its output is read from
 * the command-logs endpoint and line-framed into the stream the runtime forwards
 * into the in-memory JSON-RPC transport; its exit code comes from the
 * command-status endpoint (the logs endpoint streams output only). Stdin frames
 * are delivered via the command-input endpoint.
 *
 * Output transport — primary vs fallback:
 *   - PRIMARY: a single long-lived `GET .../logs?follow=true` stream. The proxy
 *     replays the existing backlog then tails each new line live as the process
 *     writes it, so each byte transfers exactly once (O(n)) with push latency.
 *   - FALLBACK: a 250→100ms poll loop that re-GETs the full cumulative body each
 *     tick (O(n^2); the plain GET ignores Range/offset). Engaged automatically
 *     when the follow stream fails to open, errors, or ends before the command
 *     reports an exit code. It must remain functional — it is the safety net for
 *     the working codex-on-Daytona path.
 *
 * Both paths share one line framer (`offerCompleteLines`/`flushResidual`,
 * extracted to {@link makeDaytonaSessionLineFramer}) driven by a `consumed` byte
 * offset over the cumulative output, so a mid-turn fallback after a dropped
 * stream re-reads from offset 0 without re-emitting already-seen lines.
 *
 * PTY transport — opt-in default with polling fallback:
 *   When `DAYTONA_PTY_TRANSPORT` is enabled, `startSession` first tries the
 *   duplex PTY WebSocket transport ({@link makeDaytonaPtySession}): codex stdout
 *   arrives as push (binary WS frames) instead of a poll, and stdin is a socket
 *   write instead of an HTTP POST per frame. Any PTY failure (REST create, WS
 *   upgrade, error frame) falls back to the polling session above — the working
 *   codex-on-Daytona default stays the safety net. Both transports share the one
 *   line framer, so echo suppression and frame-gate parity are identical.
 *
 * Every JSON response is decoded with effect/Schema; a body that does not match
 * the documented shape fails as a `DaytonaApiError` rather than silently reading
 * `undefined`, so a drift in the live API surfaces loudly.
 *
 * @module daytona/HttpDaytonaSandboxClient
 */
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Layer,
  Queue,
  Ref,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import type { ProcessExit } from "../../../provider/process/JsonRpcLineTransport.ts";
import { redactSecrets } from "../../Layers/redactCredentials.ts";
import { makeDaytonaSessionLineFramer } from "./daytonaSessionLineFramer.ts";
import type { DaytonaCredentials } from "./DaytonaConfig.ts";
import { DaytonaApiError, DaytonaSandboxUnknownError } from "./DaytonaErrors.ts";
import { liveDaytonaPtyConnect, type DaytonaPtyConnect } from "./DaytonaPtyConnector.ts";
import { makeDaytonaPtySession } from "./DaytonaPtyTransport.ts";
import {
  DaytonaSandboxClient,
  type DaytonaExecInput,
  type DaytonaSandbox,
  type DaytonaSandboxClientShape,
  type DaytonaSandboxStatus,
  type DaytonaSessionProcess,
} from "./DaytonaSandboxClient.ts";

const SANDBOX_ROOT = "/home/daytona";
// The session-log fallback poll interval. The primary path is a single
// long-lived `?follow=true` streaming GET (push, one byte transferred once);
// this loop only runs when that stream is unavailable or drops. 100ms is
// live-verified safe against the proxy (no throttling) and halves the worst-case
// line latency of the prior 250ms floor. Each tick still re-fetches the full
// cumulative body (the plain GET has no Range/offset support), so it stays the
// O(n^2) fallback, not the default.
const SESSION_POLL_INTERVAL = Schedule.spaced("100 millis");

// Fail-closed deadline for the PTY transport: connect succeeding is not proof
// the PTY is live (the daemon's create-command bug returned a connected-but-empty
// attach), so if no inbound byte arrives within this window after the launch
// write, the session aborts and the caller falls back to polling. Live-verified
// the shell prompt / launch echo arrives within tens of ms against a started
// sandbox, so 5s is generous headroom over real attach latency while still
// failing over quickly when the PTY is dead.
const PTY_READY_TIMEOUT = "5 seconds";

// Response schemas mirror the documented Daytona REST shapes. They stay tolerant
// where the API legitimately varies (id vs name fields, state vs status, camel
// vs lower-snake state strings) but reject a body missing every expected field,
// so a real shape drift fails loudly as a DaytonaApiError instead of decoding to
// `undefined` and silently misbehaving downstream.

/** `POST /sandbox`, `GET /sandbox/{id}` — the sandbox DTO (`state` is canonical). */
const SandboxResponse = Schema.Struct({
  id: Schema.String,
  state: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
});

/** `POST /toolbox/{id}/process/execute` — `result` is stdout, `exitCode` the code. */
const ExecResponse = Schema.Struct({
  result: Schema.optional(Schema.String),
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
});

/** `POST /sandbox/{id}/snapshot` — the created snapshot (id or name field). */
const SnapshotResponse = Schema.Struct({
  id: Schema.optional(Schema.String),
  snapshotId: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
});

/**
 * `GET /sandbox/{id}/ports/{port}/preview-url` — a PortPreviewUrl. `token` gates
 * access to a private sandbox's URL, so it is treated as a secret and redacted
 * from any error/log; only the `url` is surfaced.
 */
const PreviewResponse = Schema.Struct({
  url: Schema.String,
  token: Schema.optional(Schema.String),
  legacyProxyUrl: Schema.optional(Schema.String),
});

/** `POST /toolbox/{id}/process/session/{sid}/exec` — async command id (`cmdId`). */
const SessionCommandResponse = Schema.Struct({
  commandId: Schema.optional(Schema.String),
  cmdId: Schema.optional(Schema.String),
});

/**
 * `GET .../command/{cid}` — the session command DTO. `exitCode` is present only
 * once the command has terminated; while it runs the field is absent/null. This
 * is the authoritative exit-code source (the logs endpoint carries output only).
 */
const SessionCommandStatusResponse = Schema.Struct({
  exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
});

/**
 * Map a Daytona `SandboxState` wire string onto the normalized status set. The
 * API emits lower-snake-case (`build_failed`, `pending_build`); the full enum is
 * mapped so a transitional state (restoring, archiving, snapshotting, …) is not
 * misread as `unknown`. Underscores and dashes are both tolerated.
 */
const normalizeStatus = (state: string | undefined): DaytonaSandboxStatus => {
  switch ((state ?? "").toLowerCase().replace(/-/g, "_")) {
    case "started":
    case "running":
      return "running";
    case "starting":
    case "creating":
    case "restoring":
    case "pending":
    case "pending_build":
    case "building_snapshot":
    case "pulling_snapshot":
    case "resizing":
    case "forking":
      return "starting";
    case "stopped":
    case "stopping":
    case "snapshotting":
      return "stopped";
    case "archived":
    case "archiving":
      return "archived";
    case "destroyed":
    case "destroying":
    case "deleted":
      return "destroyed";
    case "error":
    case "failed":
    case "build_failed":
      return "error";
    default:
      return "unknown";
  }
};

const quoteArg = (value: string): string => `'${value.split("'").join("'\\''")}'`;

// Codex emits Rust `tracing` logs to stderr; on the merged PTY stream they
// interleave with the JSON-RPC frames. Silence them at the source so the
// consumer's frame-gate has less noise to classify. A caller-supplied RUST_LOG
// wins (debugging), so this is a default, not an override.
const DEFAULT_RUST_LOG = "off";

/**
 * Build the `bash -lc '<script>'` toolbox command for a remote exec.
 *
 * The Daytona toolbox runs the given command bare — no login shell — so without
 * an explicit login shell `codex` is not on PATH and `$HOME` is unset, which
 * breaks both finding the binary and resolving `$HOME/.codex/auth.json`. Wrapping
 * the inner `cd && env … cmd args` script in `bash -lc` runs it through the
 * sandbox image's login profile, putting codex on PATH and resolving `$HOME`.
 *
 * The inner script is single-quoted as one positional arg, so a `'` inside it is
 * escaped via {@link quoteArg}; the outer `bash -lc` then sees the exact script.
 */
const buildShellCommand = (input: DaytonaExecInput, root: string): string => {
  // No cwd -> run in the sandbox's default working dir (don't cd to a path that
  // may not exist). A relative cwd resolves under `root`; an absolute cwd is used
  // as-is (production passes the instance rootPath).
  const target =
    input.cwd === undefined || input.cwd.length === 0
      ? undefined
      : input.cwd.startsWith("/")
        ? input.cwd
        : `${root}/${input.cwd}`;
  const env: Record<string, string> = { RUST_LOG: DEFAULT_RUST_LOG };
  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  const envAssignments = Object.entries(env).map(([key, value]) => `${key}=${quoteArg(value)}`);
  const parts = input.args.map(quoteArg);
  const envPrefix = `env ${envAssignments.join(" ")} `;
  const command = `${envPrefix}${quoteArg(input.command)} ${parts.join(" ")}`.trim();
  const script = target === undefined ? command : `cd ${quoteArg(target)} && ${command}`;
  // Run the script through a login shell so codex is on PATH and `$HOME`
  // resolves; the script is passed as one quoted positional arg to `bash -lc`.
  return `bash -lc ${quoteArg(script)}`;
};

/**
 * Run a command under a PTY so an interactive, line-buffered server (codex
 * app-server) flushes through the captured session log — a plain pipe captured
 * to a file is fully buffered and the server's responses never appear. A very
 * wide terminal stops the PTY wrapping long JSON-RPC lines; `-echo` best-effort
 * suppresses input echo (the consumer also drops echoed lines).
 */
const wrapInPty = (command: string): string =>
  `script -qfec ${quoteArg(`stty -echo cols 100000 rows 100 2>/dev/null; ${command}`)} /dev/null`;

export interface HttpDaytonaSandboxClientOptions {
  /**
   * Opens the duplex PTY WebSocket session. Defaults to the live `ws`-backed
   * connector; tests inject a fake that resolves a scripted connection without a
   * network. Only consulted when `credentials.ptyTransport` is enabled.
   */
  readonly ptyConnect?: DaytonaPtyConnect;
}

export const makeHttpDaytonaSandboxClient = (
  credentials: DaytonaCredentials,
  options: HttpDaytonaSandboxClientOptions = {},
) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const ptyConnect = options.ptyConnect ?? liveDaytonaPtyConnect;
    // The API key is a static secret; preview-URL tokens are minted per call and
    // registered here so a later failure that echoes one is still redacted.
    const dynamicSecrets = new Set<string>();
    const registerSecret = (secret: string): void => {
      if (secret.trim().length > 0) {
        dynamicSecrets.add(secret);
      }
    };

    const redact = (value: string): string =>
      redactSecrets(value, [credentials.apiKey, ...dynamicSecrets]);

    const authed = (request: HttpClientRequest.HttpClientRequest) => {
      const withOrg =
        credentials.organizationId === undefined
          ? request
          : HttpClientRequest.setHeader(
              request,
              "X-Daytona-Organization-ID",
              credentials.organizationId,
            );
      return HttpClientRequest.bearerToken(withOrg, credentials.apiKey);
    };

    const apiUrl = (path: string): string => `${credentials.apiUrl}${path}`;

    // Toolbox/process endpoints are served by the Daytona proxy host
    // (`proxy.<api-host>`, no `/api` prefix), not the management API base.
    const toolboxBaseUrl = ((): string => {
      try {
        const parsed = new URL(credentials.apiUrl);
        return `${parsed.protocol}//proxy.${parsed.host}`;
      } catch {
        return credentials.apiUrl;
      }
    })();
    const toolboxUrl = (path: string): string => `${toolboxBaseUrl}${path}`;

    // Run an authed request, decode the JSON body with `schema`, and turn any
    // transport/non-2xx/decoding failure into a redacted DaytonaApiError that
    // carries the HTTP status (so callers can special-case 404 as idempotent).
    const requestJson = <A, I, RD, RE>(
      operation: string,
      request: HttpClientRequest.HttpClientRequest,
      schema: Schema.Codec<A, I, RD, RE>,
    ): Effect.Effect<A, DaytonaApiError, RD> =>
      Effect.gen(function* () {
        const response = yield* httpClient.execute(authed(request)).pipe(
          Effect.mapError(
            (cause) =>
              new DaytonaApiError({
                operation,
                status: null,
                detail: redact(String(cause)),
              }),
          ),
        );
        if (response.status >= 400) {
          const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
          return yield* Effect.fail(
            new DaytonaApiError({
              operation,
              status: response.status,
              detail: redact(body.length === 0 ? `HTTP ${response.status}` : body),
            }),
          );
        }
        const json = yield* response.json.pipe(
          Effect.mapError(
            (cause) =>
              new DaytonaApiError({
                operation,
                status: response.status,
                detail: redact(String(cause)),
              }),
          ),
        );
        return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
          Effect.mapError(
            (cause) =>
              new DaytonaApiError({
                operation,
                status: response.status,
                detail: redact(String(cause)),
              }),
          ),
        );
      });

    // Like requestJson but returns the raw response body. The session logs
    // endpoint streams cumulative command output as plain text, not JSON.
    const requestText = (
      operation: string,
      request: HttpClientRequest.HttpClientRequest,
    ): Effect.Effect<string, DaytonaApiError> =>
      Effect.gen(function* () {
        const response = yield* httpClient.execute(authed(request)).pipe(
          Effect.mapError(
            (cause) =>
              new DaytonaApiError({
                operation,
                status: null,
                detail: redact(String(cause)),
              }),
          ),
        );
        const body = yield* response.text.pipe(
          Effect.mapError(
            (cause) =>
              new DaytonaApiError({
                operation,
                status: response.status,
                detail: redact(String(cause)),
              }),
          ),
        );
        if (response.status >= 400) {
          return yield* Effect.fail(
            new DaytonaApiError({
              operation,
              status: response.status,
              detail: redact(body.length === 0 ? `HTTP ${response.status}` : body),
            }),
          );
        }
        return body;
      });

    const requestVoid = (
      operation: string,
      request: HttpClientRequest.HttpClientRequest,
    ): Effect.Effect<void, DaytonaApiError> =>
      Effect.gen(function* () {
        const response = yield* httpClient.execute(authed(request)).pipe(
          Effect.mapError(
            (cause) =>
              new DaytonaApiError({
                operation,
                status: null,
                detail: redact(String(cause)),
              }),
          ),
        );
        if (response.status >= 400) {
          const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
          return yield* Effect.fail(
            new DaytonaApiError({
              operation,
              status: response.status,
              detail: redact(body.length === 0 ? `HTTP ${response.status}` : body),
            }),
          );
        }
      });

    const create: DaytonaSandboxClientShape["create"] = (input) =>
      Effect.gen(function* () {
        const body: Record<string, unknown> = {
          labels: { "synara.thread": input.threadId },
          ...(credentials.target === undefined ? {} : { target: credentials.target }),
          ...(input.snapshotId === null
            ? credentials.snapshot === undefined
              ? {}
              : { snapshot: credentials.snapshot }
            : { snapshot: input.snapshotId }),
        };
        const request = yield* HttpClientRequest.bodyJson(
          HttpClientRequest.post(apiUrl("/sandbox")),
          body,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new DaytonaApiError({
                operation: "create",
                status: null,
                detail: redact(String(cause)),
              }),
          ),
        );
        const response = yield* requestJson("create", request, SandboxResponse);
        return {
          id: response.id,
          status: normalizeStatus(response.state ?? response.status),
          rootPath: SANDBOX_ROOT,
        } satisfies DaytonaSandbox;
      });

    const exec: DaytonaSandboxClientShape["exec"] = (sandboxId, input) =>
      Effect.gen(function* () {
        const request = yield* HttpClientRequest.bodyJson(
          HttpClientRequest.post(toolboxUrl(`/toolbox/${sandboxId}/process/execute`)),
          { command: buildShellCommand(input, SANDBOX_ROOT) },
        ).pipe(
          Effect.mapError(
            (cause) =>
              new DaytonaApiError({
                operation: "exec",
                status: null,
                detail: redact(String(cause)),
              }),
          ),
        );
        const response = yield* requestJson("exec", request, ExecResponse);
        return {
          stdout: response.stdout ?? response.result ?? "",
          stderr: response.stderr ?? "",
          exitCode: response.exitCode ?? null,
        };
      });

    // The logs-polling session transport (the working default). Reads codex
    // stdout by re-GETting the cumulative command-logs body (preferring the
    // `?follow=true` stream) and writes stdin with one HTTP POST per frame. This
    // is the fallback when the PTY WebSocket transport is disabled or fails.
    const startPollSession: DaytonaSandboxClientShape["startSession"] = (sandboxId, input) =>
      Effect.gen(function* () {
        const sessionId = `synara-${crypto.randomUUID()}`;
        const sessionBase = toolboxUrl(`/toolbox/${sandboxId}/process/session`);

        const createSessionReq = yield* HttpClientRequest.bodyJson(
          HttpClientRequest.post(sessionBase),
          { sessionId },
        ).pipe(
          Effect.mapError(
            (cause) =>
              new DaytonaApiError({
                operation: "startSession",
                status: null,
                detail: redact(String(cause)),
              }),
          ),
        );
        yield* requestVoid("startSession", createSessionReq);

        const execReq = yield* HttpClientRequest.bodyJson(
          HttpClientRequest.post(`${sessionBase}/${sessionId}/exec`),
          {
            command: wrapInPty(buildShellCommand(input, SANDBOX_ROOT)),
            runAsync: true,
          },
        ).pipe(
          Effect.mapError(
            (cause) =>
              new DaytonaApiError({
                operation: "startSession",
                status: null,
                detail: redact(String(cause)),
              }),
          ),
        );
        const command = yield* requestJson("startSession", execReq, SessionCommandResponse);
        const commandId = command.commandId ?? command.cmdId;
        if (commandId === undefined) {
          return yield* Effect.fail(
            new DaytonaApiError({
              operation: "startSession",
              status: null,
              detail: "Daytona session exec returned no command id",
            }),
          );
        }

        const sessionScope = yield* Scope.make();
        // `Cause.Done` in the error channel lets the poll loop `end` the queue so
        // the consumer drains the final lines gracefully rather than being torn
        // down mid-drain by a `shutdown`.
        const stdoutQueue = yield* Queue.unbounded<string, Cause.Done>();
        const exitDeferred = yield* Deferred.make<ProcessExit>();
        // Line framing + echo suppression are shared with the PTY transport (one
        // framer, no duplicated logic). `offerCompleteLines` re-passes the
        // cumulative body each tick and emits each line once; `flushResidual`
        // flushes the trailing line on exit; `trackOutboundFrame` drops the
        // PTY/`stty -echo` echo of a written stdin frame.
        const framer = yield* makeDaytonaSessionLineFramer(stdoutQueue);
        const { offerCompleteLines, flushResidual, trackOutboundFrame } = framer;

        // Read the authoritative exit code from the command-status endpoint
        // (`null` while the command runs). Both transports end on a non-null code.
        const readExitCode = requestJson(
          "sessionCommandStatus",
          HttpClientRequest.get(`${sessionBase}/${sessionId}/command/${commandId}`),
          SessionCommandStatusResponse,
        ).pipe(
          Effect.orElseSucceed(() => ({ exitCode: undefined }) as const),
          Effect.map((status) => status.exitCode ?? null),
        );

        const resolveExit = (exitCode: number) =>
          Deferred.done(
            exitDeferred,
            Exit.succeed({
              code: exitCode,
              signal: null,
            } satisfies ProcessExit),
          );

        // FALLBACK: re-GET the full cumulative body each tick and frame the newly
        // appended slice. `lastBodyLength` short-circuits the frame pass when the
        // body has not grown (the GET still re-downloads it — the plain endpoint
        // has no Range/offset — but parsing/echo work is skipped). The loop ends
        // once the command-status endpoint reports a non-null exit code.
        const lastBodyLength = yield* Ref.make(-1);
        const pollOnce = Effect.gen(function* () {
          const logReq = HttpClientRequest.get(
            `${sessionBase}/${sessionId}/command/${commandId}/logs`,
          );
          const output = yield* requestText("sessionLogs", logReq).pipe(
            Effect.orElseSucceed(() => ""),
          );
          const previousLength = yield* Ref.get(lastBodyLength);
          if (output.length !== previousLength) {
            yield* Ref.set(lastBodyLength, output.length);
            yield* offerCompleteLines(output);
          }
          const exitCode = yield* readExitCode;
          if (exitCode !== null) {
            yield* flushResidual(output);
          }
          return exitCode;
        });

        const pollLoop = pollOnce.pipe(
          Effect.flatMap((exitCode) =>
            exitCode === null
              ? Effect.void
              : resolveExit(exitCode).pipe(Effect.flatMap(() => Effect.interrupt)),
          ),
          Effect.repeat(SESSION_POLL_INTERVAL),
          Effect.catchCause(() => Effect.void),
        );

        // PRIMARY: one long-lived `?follow=true` GET. The proxy replays the
        // backlog then tails live, so each chunk only advances the cumulative
        // body; framing the growing buffer through the shared `offerCompleteLines`
        // (gated by `consumed`) emits each line exactly once. The stream ends when
        // the process exits or the connection drops; the caller then reconciles
        // against the command-status exit code.
        const followStream = Effect.gen(function* () {
          const followReq = HttpClientRequest.get(
            `${sessionBase}/${sessionId}/command/${commandId}/logs?follow=true`,
          );
          const response = yield* httpClient.execute(authed(followReq));
          if (response.status >= 400) {
            return yield* Effect.fail(
              new DaytonaApiError({
                operation: "sessionLogsFollow",
                status: response.status,
                detail: `HTTP ${response.status}`,
              }),
            );
          }
          const decoder = new TextDecoder();
          const buffer = yield* Ref.make("");
          yield* response.stream.pipe(
            Stream.runForEach((chunk) =>
              Effect.gen(function* () {
                const next = yield* Ref.updateAndGet(
                  buffer,
                  (current) => current + decoder.decode(chunk, { stream: true }),
                );
                yield* offerCompleteLines(next);
              }),
            ),
          );
        });

        // Drive output to the stdout queue, then resolve exit once the command
        // reports a code. The follow stream is the default; any failure (open
        // error, mid-stream drop) or an end-before-exit falls through to the poll
        // loop, which both finishes draining and ends on the exit code. A
        // mid-turn fallback re-reads the cumulative body from offset 0, but
        // `consumed` prevents re-emitting already-seen lines.
        const driveOutput = Effect.gen(function* () {
          yield* followStream.pipe(Effect.catchCause(() => Effect.void));
          // The follow stream ended (process exit, drop, or proxy idle close).
          // If the command has already exited, flush the residual and resolve;
          // otherwise hand off to the poll loop to finish the turn.
          const output = yield* requestText(
            "sessionLogs",
            HttpClientRequest.get(`${sessionBase}/${sessionId}/command/${commandId}/logs`),
          ).pipe(Effect.orElseSucceed(() => ""));
          yield* offerCompleteLines(output);
          const exitCode = yield* readExitCode;
          if (exitCode !== null) {
            yield* flushResidual(output);
            yield* resolveExit(exitCode);
            return;
          }
          yield* Ref.set(lastBodyLength, output.length);
          yield* pollLoop;
        });

        yield* driveOutput.pipe(
          Effect.catchCause(() => Effect.void),
          // `end` (not `shutdown`) so the stream consumer drains the lines already
          // offered before completing — the agent's last output is not dropped on
          // exit. `shutdown` would discard buffered items.
          Effect.ensuring(Queue.end(stdoutQueue)),
          Effect.forkIn(sessionScope),
        );

        const writeStdin: DaytonaSessionProcess["writeStdin"] = (line) => {
          trackOutboundFrame(line);
          return HttpClientRequest.bodyJson(
            HttpClientRequest.post(`${sessionBase}/${sessionId}/command/${commandId}/input`),
            { data: `${line}\n` },
          ).pipe(
            Effect.flatMap((request) => requestVoid("sessionInput", request)),
            Effect.ignore,
          );
        };

        const session: DaytonaSessionProcess = {
          stdoutLines: Stream.fromQueue(stdoutQueue),
          stderrLines: Stream.empty,
          writeStdin,
          exit: Deferred.await(exitDeferred),
          close: Scope.close(sessionScope, Exit.void).pipe(Effect.ignore),
        };
        return session;
      });

    // Resolve the cwd for the PTY session the same way `buildShellCommand` does:
    // a relative cwd resolves under the sandbox root, an absolute cwd is used
    // as-is, and an empty cwd defers to the PTY shell's default working dir.
    const resolvePtyCwd = (cwd: string | undefined): string | undefined => {
      if (cwd === undefined || cwd.length === 0) {
        return undefined;
      }
      return cwd.startsWith("/") ? cwd : `${SANDBOX_ROOT}/${cwd}`;
    };

    // The real-time PTY WebSocket session transport. The daemon (v0.184.0)
    // ignores the create-body command and attaches a bare interactive shell, so
    // codex is launched by writing `exec <command>` into the PTY's stdin after
    // connect (see makeDaytonaPtySession); `exec` replaces the shell so the WS
    // close maps to codex's exit. `stty -echo` best-effort suppresses input echo,
    // with the shared framer's echo multiset as the byte-identical-echo backstop.
    // The transport's readiness gate aborts with a DaytonaApiError if the PTY
    // stays silent, so any failure (REST create, WS upgrade, error control frame,
    // dead attach) falls back to the polling transport.
    const startPtySession: DaytonaSandboxClientShape["startSession"] = (sandboxId, input) =>
      Effect.gen(function* () {
        // The codex launch line, run via the PTY's login shell. `stty -echo` is
        // prefixed so the line discipline drops stdin echo once applied; the
        // framer suppresses any echo written before that takes effect.
        const command = `bash -lc ${quoteArg(
          `stty -echo 2>/dev/null; ${buildShellCommand(input, SANDBOX_ROOT)}`,
        )}`;
        const connection = yield* ptyConnect({
          proxyBaseUrl: toolboxBaseUrl,
          sandboxId,
          cwd: resolvePtyCwd(input.cwd),
          envs: undefined,
          authorize: authed,
          wsHeaders: {
            authorization: `Bearer ${credentials.apiKey}`,
            ...(credentials.organizationId === undefined
              ? {}
              : { "X-Daytona-Organization-ID": credentials.organizationId }),
          },
          redact,
        }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
        return yield* makeDaytonaPtySession(connection, {
          command,
          readyTimeout: PTY_READY_TIMEOUT,
        });
      });

    // Prefer the PTY WebSocket transport when enabled; fall back to the polling
    // transport on any PTY failure (REST create, WS upgrade, error frame). This
    // keeps the working codex-on-Daytona polling path as the safety net.
    const startSession: DaytonaSandboxClientShape["startSession"] = (sandboxId, input) =>
      credentials.ptyTransport
        ? startPtySession(sandboxId, input).pipe(
            Effect.catchTag("DaytonaApiError", () => startPollSession(sandboxId, input)),
          )
        : startPollSession(sandboxId, input);

    const exposePort: DaytonaSandboxClientShape["exposePort"] = (sandboxId, port) =>
      requestJson(
        "exposePort",
        HttpClientRequest.get(apiUrl(`/sandbox/${sandboxId}/ports/${port}/preview-url`)),
        PreviewResponse,
      ).pipe(
        Effect.map((response) => {
          // The preview token gates access to a private sandbox's URL; register it
          // so any later failure that echoes it is redacted. Only `url` surfaces.
          if (response.token !== undefined) {
            registerSecret(response.token);
          }
          return { url: response.url };
        }),
      );

    const snapshot: DaytonaSandboxClientShape["snapshot"] = (sandboxId, label) =>
      Effect.gen(function* () {
        const request = yield* HttpClientRequest.bodyJson(
          HttpClientRequest.post(apiUrl(`/sandbox/${sandboxId}/snapshot`)),
          label === null ? {} : { name: label },
        ).pipe(
          Effect.mapError(
            (cause) =>
              new DaytonaApiError({
                operation: "snapshot",
                status: null,
                detail: redact(String(cause)),
              }),
          ),
        );
        const response = yield* requestJson("snapshot", request, SnapshotResponse);
        const snapshotId = response.snapshotId ?? response.id ?? response.name;
        if (snapshotId === undefined) {
          return yield* Effect.fail(
            new DaytonaApiError({
              operation: "snapshot",
              status: null,
              detail: "Daytona snapshot returned no id",
            }),
          );
        }
        return { snapshotId };
      });

    const refreshActivity: DaytonaSandboxClientShape["refreshActivity"] = (sandboxId) =>
      requestVoid("refreshActivity", HttpClientRequest.post(apiUrl(`/sandbox/${sandboxId}/start`)));

    const stop: DaytonaSandboxClientShape["stop"] = (sandboxId) =>
      requestVoid("stop", HttpClientRequest.post(apiUrl(`/sandbox/${sandboxId}/stop`)));

    const getStatus: DaytonaSandboxClientShape["getStatus"] = (sandboxId) =>
      requestJson(
        "getStatus",
        HttpClientRequest.get(apiUrl(`/sandbox/${sandboxId}`)),
        SandboxResponse,
      ).pipe(
        Effect.map(
          (response): DaytonaSandbox => ({
            id: response.id,
            status: normalizeStatus(response.state ?? response.status),
            rootPath: SANDBOX_ROOT,
          }),
        ),
        // A 404 means the provider no longer knows the id — a lost instance, not
        // a hard failure. Any 404-bearing failure resolves to `null`.
        Effect.catchTag("DaytonaApiError", (error) =>
          error.status === 404 ? Effect.succeed(null) : Effect.fail(error),
        ),
      );

    const destroy: DaytonaSandboxClientShape["destroy"] = (sandboxId) =>
      requestVoid("archive", HttpClientRequest.post(apiUrl(`/sandbox/${sandboxId}/archive`))).pipe(
        Effect.ignore,
        Effect.flatMap(() =>
          requestVoid("destroy", HttpClientRequest.make("DELETE")(apiUrl(`/sandbox/${sandboxId}`))),
        ),
        // Destroying an unknown sandbox is idempotent: a 404 is success.
        Effect.catchTag("DaytonaApiError", (error) =>
          error.status === 404 ? Effect.void : Effect.fail(error),
        ),
      );

    return {
      // The REST client backs only real remote sandboxes, so credential
      // injection is always safe (and required) here.
      isRemoteSandbox: () => true,
      create,
      exec,
      startSession,
      exposePort,
      snapshot,
      refreshActivity,
      stop,
      getStatus,
      destroy,
    } satisfies DaytonaSandboxClientShape;
  });

export const makeHttpDaytonaSandboxClientLive = (credentials: DaytonaCredentials) =>
  Layer.effect(DaytonaSandboxClient, makeHttpDaytonaSandboxClient(credentials));

export { DaytonaSandboxUnknownError };

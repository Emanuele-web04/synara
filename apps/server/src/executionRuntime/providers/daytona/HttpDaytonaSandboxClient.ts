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
 * `startSession` (v1): Daytona has no duplex stdio socket over plain REST, so a
 * long-lived process runs as an async session command. Its output is polled from
 * the command-logs endpoint and line-framed into the stream the runtime forwards
 * into the in-memory JSON-RPC transport; its exit code comes from the
 * command-status endpoint (the logs endpoint streams output only). Stdin frames
 * are delivered via the command-input endpoint. This is enough to run
 * `codex app-server`; a richer duplex transport (websocket toolbox) is a later
 * refinement.
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
import type { DaytonaCredentials } from "./DaytonaConfig.ts";
import { DaytonaApiError, DaytonaSandboxUnknownError } from "./DaytonaErrors.ts";
import {
  DaytonaSandboxClient,
  type DaytonaExecInput,
  type DaytonaSandbox,
  type DaytonaSandboxClientShape,
  type DaytonaSandboxStatus,
  type DaytonaSessionProcess,
} from "./DaytonaSandboxClient.ts";

const SANDBOX_ROOT = "/home/daytona/workspace";
const SESSION_POLL_INTERVAL = Schedule.spaced("250 millis");

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

/** `GET .../command/{cid}/logs` — cumulative output (stdout/stderr also seen). */
const SessionLogResponse = Schema.Struct({
  output: Schema.optional(Schema.String),
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
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

/** Build a `cd && env VAR=... cmd args` shell string for toolbox exec. */
const buildShellCommand = (input: DaytonaExecInput, root: string): string => {
  const cwd = input.cwd === undefined || input.cwd.length === 0 ? root : `${root}/${input.cwd}`;
  const envAssignments = Object.entries(input.env ?? {})
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${quoteArg(value)}`);
  const parts = input.args.map(quoteArg);
  const envPrefix = envAssignments.length > 0 ? `env ${envAssignments.join(" ")} ` : "";
  return `cd ${quoteArg(cwd)} && ${envPrefix}${quoteArg(input.command)} ${parts.join(" ")}`.trim();
};

export const makeHttpDaytonaSandboxClient = (credentials: DaytonaCredentials) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
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

    // Run an authed request, decode the JSON body with `schema`, and turn any
    // transport/non-2xx/decoding failure into a redacted DaytonaApiError that
    // carries the HTTP status (so callers can special-case 404 as idempotent).
    const requestJson = <A, I, RD, RE>(
      operation: string,
      request: HttpClientRequest.HttpClientRequest,
      schema: Schema.Codec<A, I, RD, RE>,
    ): Effect.Effect<A, DaytonaApiError, RD> =>
      Effect.gen(function* () {
        const response = yield* httpClient
          .execute(authed(request))
          .pipe(
            Effect.mapError(
              (cause) =>
                new DaytonaApiError({ operation, status: null, detail: redact(String(cause)) }),
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

    const requestVoid = (
      operation: string,
      request: HttpClientRequest.HttpClientRequest,
    ): Effect.Effect<void, DaytonaApiError> =>
      Effect.gen(function* () {
        const response = yield* httpClient
          .execute(authed(request))
          .pipe(
            Effect.mapError(
              (cause) =>
                new DaytonaApiError({ operation, status: null, detail: redact(String(cause)) }),
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
          HttpClientRequest.post(apiUrl(`/toolbox/${sandboxId}/process/execute`)),
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

    const startSession: DaytonaSandboxClientShape["startSession"] = (sandboxId, input) =>
      Effect.gen(function* () {
        const sessionId = `synara-${crypto.randomUUID()}`;
        const sessionBase = apiUrl(`/toolbox/${sandboxId}/process/session`);

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
          { command: buildShellCommand(input, SANDBOX_ROOT), runAsync: true },
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
        const consumed = yield* Ref.make(0);

        // Poll the session command on each tick: read the cumulative log output
        // and line-frame the newly appended slice, then read the command status
        // for an exit code. The exit code lives on the command-status endpoint,
        // not the logs endpoint; a non-null code ends the loop.
        //
        // Only complete lines (text up to and including a `\n`) are emitted; the
        // residual after the last `\n` is carried in `consumed` and re-examined
        // next tick. This preserves the one-JSON-RPC-message-per-line contract
        // when a single message's bytes arrive split across two poll ticks —
        // emitting the partial line early would yield two corrupt fragments that
        // each fail `JSON.parse`. The trailing residual is flushed on exit.
        const offerCompleteLines = (output: string) =>
          Effect.gen(function* () {
            const seen = yield* Ref.get(consumed);
            const lastNewline = output.lastIndexOf("\n");
            if (lastNewline < seen) {
              return;
            }
            const fresh = output.slice(seen, lastNewline + 1);
            yield* Ref.set(consumed, lastNewline + 1);
            for (const line of fresh.split("\n")) {
              if (line.length > 0) {
                yield* Queue.offer(stdoutQueue, line);
              }
            }
          });

        // Flush any residual after the last emitted `\n` as a final complete
        // line. Called once the process has exited and no further bytes can
        // arrive to terminate it.
        const flushResidual = (output: string) =>
          Effect.gen(function* () {
            const seen = yield* Ref.get(consumed);
            const residual = output.slice(seen);
            if (residual.length > 0) {
              yield* Ref.set(consumed, output.length);
              yield* Queue.offer(stdoutQueue, residual);
            }
          });

        const pollOnce = Effect.gen(function* () {
          const logReq = HttpClientRequest.get(
            `${sessionBase}/${sessionId}/command/${commandId}/logs`,
          );
          const log = yield* requestJson("sessionLogs", logReq, SessionLogResponse).pipe(
            Effect.orElseSucceed(
              () => ({ output: undefined, stdout: undefined, stderr: undefined }) as const,
            ),
          );
          const output = log.output ?? log.stdout ?? "";
          yield* offerCompleteLines(output);
          const statusReq = HttpClientRequest.get(
            `${sessionBase}/${sessionId}/command/${commandId}`,
          );
          const status = yield* requestJson(
            "sessionCommandStatus",
            statusReq,
            SessionCommandStatusResponse,
          ).pipe(Effect.orElseSucceed(() => ({ exitCode: undefined }) as const));
          const exitCode = status.exitCode ?? null;
          if (exitCode !== null) {
            yield* flushResidual(output);
          }
          return exitCode;
        });

        yield* pollOnce.pipe(
          Effect.flatMap((exitCode) =>
            exitCode === null
              ? Effect.void
              : Deferred.done(
                  exitDeferred,
                  Exit.succeed({ code: exitCode, signal: null } satisfies ProcessExit),
                ).pipe(Effect.flatMap(() => Effect.interrupt)),
          ),
          Effect.repeat(SESSION_POLL_INTERVAL),
          Effect.catchCause(() => Effect.void),
          // `end` (not `shutdown`) so the stream consumer drains the lines already
          // offered this final tick before completing — the agent's last output
          // is not dropped on exit. `shutdown` would discard buffered items.
          Effect.ensuring(Queue.end(stdoutQueue)),
          Effect.forkIn(sessionScope),
        );

        const writeStdin: DaytonaSessionProcess["writeStdin"] = (line) =>
          HttpClientRequest.bodyJson(
            HttpClientRequest.post(`${sessionBase}/${sessionId}/command/${commandId}/input`),
            { data: `${line}\n` },
          ).pipe(
            Effect.flatMap((request) => requestVoid("sessionInput", request)),
            Effect.ignore,
          );

        const session: DaytonaSessionProcess = {
          stdoutLines: Stream.fromQueue(stdoutQueue),
          stderrLines: Stream.empty,
          writeStdin,
          exit: Deferred.await(exitDeferred),
          close: Scope.close(sessionScope, Exit.void).pipe(Effect.ignore),
        };
        return session;
      });

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

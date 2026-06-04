/**
 * HttpDaytonaSandboxClient - the real Daytona REST client (credential-gated).
 *
 * Selected only when `DAYTONA_API_KEY` is configured; otherwise the adapter uses
 * the fake client. Talks the documented Daytona API:
 *
 *   - `POST   {api}/sandbox`                          create
 *   - `GET    {api}/sandbox/{id}`                     status (reconnect)
 *   - `POST   {api}/sandbox/{id}/stop`                stop (FS persists)
 *   - `POST   {api}/sandbox/{id}/archive`             archive before delete
 *   - `DELETE {api}/sandbox/{id}`                     destroy
 *   - `POST   {api}/sandbox/{id}/snapshot`            snapshot
 *   - `POST   {api}/toolbox/{id}/toolbox/process/execute`  fire-and-collect exec
 *   - toolbox session endpoints                       long-lived agent session
 *
 * Credential safety: the bearer token and any tokenized URL never reach a log or
 * an error detail — every failure runs through {@link redactSecrets} with the
 * token registered, and the adapter logs only sandbox ids and exit codes.
 *
 * `startSession` (v1): Daytona has no duplex stdio socket over plain REST, so a
 * long-lived process runs as an async session command and its stdout is polled
 * from the session-command log endpoint, line-framed into the stream the runtime
 * forwards into the in-memory JSON-RPC transport. Stdin frames are delivered via
 * the session input endpoint. This is enough to run `codex app-server`; a richer
 * duplex transport (websocket toolbox) is a later refinement.
 *
 * @module daytona/HttpDaytonaSandboxClient
 */
import { Deferred, Effect, Exit, Layer, Queue, Ref, Schedule, Schema, Scope, Stream } from "effect";
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

const SandboxResponse = Schema.Struct({
  id: Schema.String,
  state: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
});

const ExecResponse = Schema.Struct({
  result: Schema.optional(Schema.String),
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
});

const SnapshotResponse = Schema.Struct({
  id: Schema.optional(Schema.String),
  snapshotId: Schema.optional(Schema.String),
});

const PreviewResponse = Schema.Struct({
  url: Schema.String,
});

const SessionCommandResponse = Schema.Struct({
  commandId: Schema.optional(Schema.String),
  cmdId: Schema.optional(Schema.String),
});

const SessionLogResponse = Schema.Struct({
  output: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
});

/** Map Daytona's provider state strings onto the normalized status set. */
const normalizeStatus = (state: string | undefined): DaytonaSandboxStatus => {
  switch ((state ?? "").toLowerCase()) {
    case "started":
    case "running":
      return "running";
    case "starting":
    case "creating":
    case "pending":
      return "starting";
    case "stopped":
      return "stopped";
    case "archived":
      return "archived";
    case "destroyed":
    case "deleted":
      return "destroyed";
    case "error":
    case "failed":
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
    const secrets = [credentials.apiKey];

    const redact = (value: string): string => redactSecrets(value, secrets);

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
          HttpClientRequest.post(apiUrl(`/toolbox/${sandboxId}/toolbox/process/execute`)),
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
        const sessionBase = apiUrl(`/toolbox/${sandboxId}/toolbox/process/session`);

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
        const stdoutQueue = yield* Queue.unbounded<string>();
        const exitDeferred = yield* Deferred.make<ProcessExit>();
        const consumed = yield* Ref.make(0);

        // Poll the session command log: each tick reads the cumulative output,
        // line-frames the newly appended slice, and stops once an exit code
        // appears. Cumulative-length tracking avoids re-emitting old lines.
        const pollOnce = Effect.gen(function* () {
          const logReq = HttpClientRequest.get(
            `${sessionBase}/${sessionId}/command/${commandId}/logs`,
          );
          const log = yield* requestJson("sessionLogs", logReq, SessionLogResponse).pipe(
            Effect.orElseSucceed(() => ({ output: undefined, exitCode: undefined }) as const),
          );
          const output = log.output ?? "";
          const seen = yield* Ref.get(consumed);
          if (output.length > seen) {
            const fresh = output.slice(seen);
            yield* Ref.set(consumed, output.length);
            for (const line of fresh.split("\n")) {
              if (line.length > 0) {
                yield* Queue.offer(stdoutQueue, line);
              }
            }
          }
          return log.exitCode ?? null;
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
          Effect.ensuring(Queue.shutdown(stdoutQueue)),
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
      ).pipe(Effect.map((response) => ({ url: response.url })));

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
        const snapshotId = response.snapshotId ?? response.id;
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

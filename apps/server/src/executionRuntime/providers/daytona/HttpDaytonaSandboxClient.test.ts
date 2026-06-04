/**
 * HttpDaytonaSandboxClient tests — the real REST client against a stubbed
 * HttpClient (no network, no credentials).
 *
 * These cover the wire contract the fake client cannot: exact endpoint paths and
 * request bodies, effect/Schema decoding of each documented response shape, the
 * loud `DaytonaApiError` on a shape mismatch or non-2xx, 404 idempotency on
 * status/destroy, the session exit-code source (the command-status endpoint, not
 * the logs endpoint), and credential redaction of the bearer token and a
 * preview-URL token in error detail.
 *
 * The stub routes by method + URL path and returns a canned `Response`; it also
 * records every request so the test asserts the client hit the documented
 * endpoint with the documented body.
 *
 * @module daytona/HttpDaytonaSandboxClient.test
 */
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vitest";

import type { DaytonaCredentials } from "./DaytonaConfig.ts";
import { DaytonaSandboxClient } from "./DaytonaSandboxClient.ts";
import { makeHttpDaytonaSandboxClientLive } from "./HttpDaytonaSandboxClient.ts";

const API_URL = "https://daytona.test/api";

const credentials: DaytonaCredentials = {
  apiKey: "secret-key-123",
  apiUrl: API_URL,
  target: undefined,
  organizationId: "org-1",
  snapshot: undefined,
};

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
  readonly authorization: string | undefined;
  readonly organization: string | undefined;
}

interface StubRoute {
  /** Matches when both are set (method exact, url substring). */
  readonly method: string;
  readonly path: string;
  readonly status?: number;
  /** JSON body returned (mutually exclusive with `text`). */
  readonly json?: unknown;
  /** Raw text body returned (for malformed-JSON / decode-failure cases). */
  readonly text?: string;
}

const decodeBody = (body: { readonly _tag: string; readonly body?: unknown }): unknown => {
  if (body._tag !== "Uint8Array") {
    return undefined;
  }
  const text = new TextDecoder().decode(body.body as Uint8Array);
  return text.length === 0 ? undefined : JSON.parse(text);
};

/**
 * Build a stub HttpClient layer over `routes`. The first route whose method
 * matches and whose `path` is a substring of the request URL wins; an unmatched
 * request returns 404 (mirroring the real API for an unknown id). Every request
 * is pushed into `recorded`.
 */
const makeStubHttpClient = (
  routes: ReadonlyArray<StubRoute>,
  recorded: RecordedRequest[],
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        recorded.push({
          method: request.method,
          url: request.url,
          body: decodeBody(request.body as { readonly _tag: string; readonly body?: unknown }),
          authorization: request.headers["authorization"],
          organization: request.headers["x-daytona-organization-id"],
        });
        const route = routes.find(
          (candidate) =>
            candidate.method === request.method && request.url.includes(candidate.path),
        );
        if (route === undefined) {
          return HttpClientResponse.fromWeb(request, new Response("not found", { status: 404 }));
        }
        const status = route.status ?? 200;
        if (route.text !== undefined) {
          return HttpClientResponse.fromWeb(request, new Response(route.text, { status }));
        }
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(route.json ?? {}), {
            status,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    ),
  );

const makeRuntime = (routes: ReadonlyArray<StubRoute>, recorded: RecordedRequest[]) =>
  ManagedRuntime.make(
    makeHttpDaytonaSandboxClientLive(credentials).pipe(
      Layer.provide(makeStubHttpClient(routes, recorded)),
    ),
  );

describe("HttpDaytonaSandboxClient", () => {
  let runtime: ReturnType<typeof makeRuntime> | undefined;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
      runtime = undefined;
    }
  });

  it("creates a sandbox at POST /sandbox with the thread label and auth headers", async () => {
    const recorded: RecordedRequest[] = [];
    runtime = makeRuntime(
      [{ method: "POST", path: "/sandbox", json: { id: "sb-1", state: "started" } }],
      recorded,
    );
    const local = runtime;
    const sandbox = await local.runPromise(
      Effect.flatMap(DaytonaSandboxClient.asEffect(), (client) =>
        client.create({ threadId: "t-1", ports: [], snapshotId: null }),
      ),
    );
    expect(sandbox.id).toBe("sb-1");
    expect(sandbox.status).toBe("running");
    expect(sandbox.rootPath.length).toBeGreaterThan(0);

    const create = recorded[0];
    expect(create?.method).toBe("POST");
    expect(create?.url).toBe(`${API_URL}/sandbox`);
    expect(create?.authorization).toBe("Bearer secret-key-123");
    expect(create?.organization).toBe("org-1");
    expect(create?.body).toMatchObject({ labels: { "synara.thread": "t-1" } });
  });

  it("resumes from a snapshot id by sending it as the create snapshot", async () => {
    const recorded: RecordedRequest[] = [];
    runtime = makeRuntime(
      [{ method: "POST", path: "/sandbox", json: { id: "sb-2", state: "creating" } }],
      recorded,
    );
    const local = runtime;
    const sandbox = await local.runPromise(
      Effect.flatMap(DaytonaSandboxClient.asEffect(), (client) =>
        client.create({ threadId: "t-2", ports: [], snapshotId: "snap-prior" }),
      ),
    );
    expect(sandbox.status).toBe("starting");
    expect(recorded[0]?.body).toMatchObject({ snapshot: "snap-prior" });
  });

  it("decodes exec result/exitCode and targets the single-toolbox execute path", async () => {
    const recorded: RecordedRequest[] = [];
    runtime = makeRuntime(
      [
        {
          method: "POST",
          path: "/process/execute",
          json: { result: "hello\n", exitCode: 0 },
        },
      ],
      recorded,
    );
    const local = runtime;
    const result = await local.runPromise(
      Effect.flatMap(DaytonaSandboxClient.asEffect(), (client) =>
        client.exec("sb-1", { command: "echo", args: ["hello"] }),
      ),
    );
    expect(result.stdout).toBe("hello\n");
    expect(result.exitCode).toBe(0);
    // Toolbox/process calls target the Daytona proxy host (proxy.<api-host>, no
    // `/api`), with a single `toolbox` segment — verified against the live API.
    expect(recorded[0]?.url).toBe("https://proxy.daytona.test/toolbox/sb-1/process/execute");
    expect(recorded[0]?.url).not.toContain("toolbox/sb-1/toolbox");
  });

  it("reads a session command's exit code from the command-status endpoint, not the logs", async () => {
    const recorded: RecordedRequest[] = [];
    runtime = makeRuntime(
      [
        // `/exec` is checked before `/process/session` because the exec URL
        // (`.../process/session/{sid}/exec`) also contains the session substring.
        { method: "POST", path: "/exec", json: { cmdId: "cmd-9" } },
        { method: "POST", path: "/process/session", status: 201 },
        // Logs carry output only; the logs endpoint never reports an exit code.
        { method: "GET", path: "/logs", text: "line-a\nline-b\n" },
        // The command-status endpoint is the authoritative exit-code source.
        { method: "GET", path: "/command/cmd-9", json: { exitCode: 0 } },
      ],
      recorded,
    );
    const local = runtime;
    const exit = await local.runPromise(
      Effect.flatMap(DaytonaSandboxClient.asEffect(), (client) =>
        Effect.gen(function* () {
          const session = yield* client.startSession("sb-1", { command: "codex", args: [] });
          // The poll fork offers both lines then `Queue.end`s the stream once it
          // reads the exit code, so the consumer drains to completion gracefully.
          const lines = yield* session.stdoutLines.pipe(Stream.runCollect);
          const status = yield* session.exit;
          yield* session.close;
          return { lines: Array.from(lines), status };
        }),
      ),
    );
    expect(exit.lines).toEqual(["line-a", "line-b"]);
    expect(exit.status).toEqual({ code: 0, signal: null });
    // The status endpoint (no trailing `/logs`) was queried for the exit code.
    expect(
      recorded.some(
        (request) =>
          request.method === "GET" &&
          request.url.endsWith("/command/cmd-9") &&
          !request.url.endsWith("/logs"),
      ),
    ).toBe(true);
  });

  it("carries a partial trailing line across poll ticks instead of splitting it", async () => {
    // A JSON-RPC message whose bytes arrive across two poll ticks: tick 1's
    // cumulative log ends mid-message (no trailing newline), tick 2 completes it.
    // The transport contract is one message per inbound line, so the half-message
    // must NOT be emitted on tick 1 and re-emitted on tick 2 — it must surface as
    // exactly one line once terminated.
    const message = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const half = message.slice(0, 12);
    const cumulativeByLogCall = [
      // Tick 1: a complete line, then the start of the next message (no newline).
      `{"first":true}\n${half}`,
      // Tick 2: the rest of the message arrives, terminated.
      `{"first":true}\n${message}\n`,
    ];
    let logCall = 0;

    const recorded: RecordedRequest[] = [];
    const statefulLogs: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          recorded.push({
            method: request.method,
            url: request.url,
            body: undefined,
            authorization: request.headers["authorization"],
            organization: request.headers["x-daytona-organization-id"],
          });
          const respond = (json: unknown) =>
            HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify(json), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            );
          if (request.method === "POST" && request.url.includes("/exec")) {
            return respond({ cmdId: "cmd-split" });
          }
          if (request.method === "POST" && request.url.includes("/process/session")) {
            return respond({});
          }
          if (request.method === "GET" && request.url.endsWith("/logs")) {
            // The logs endpoint returns cumulative output as raw text. The status
            // endpoint only reports an exit once both ticks have run, so the loop
            // polls logs at least twice (partial then complete).
            const output = cumulativeByLogCall[Math.min(logCall, cumulativeByLogCall.length - 1)];
            logCall += 1;
            return HttpClientResponse.fromWeb(request, new Response(output, { status: 200 }));
          }
          if (request.method === "GET" && request.url.includes("/command/cmd-split")) {
            // Hold the exit until the completing log tick has been served so the
            // residual flush sees the terminated message.
            return respond({ exitCode: logCall >= 2 ? 0 : undefined });
          }
          return HttpClientResponse.fromWeb(request, new Response("not found", { status: 404 }));
        }),
      ),
    );

    const splitRuntime = ManagedRuntime.make(
      makeHttpDaytonaSandboxClientLive(credentials).pipe(Layer.provide(statefulLogs)),
    );
    try {
      const result = await splitRuntime.runPromise(
        Effect.flatMap(DaytonaSandboxClient.asEffect(), (client) =>
          Effect.gen(function* () {
            const session = yield* client.startSession("sb-1", { command: "codex", args: [] });
            const lines = yield* session.stdoutLines.pipe(Stream.runCollect);
            yield* session.exit;
            yield* session.close;
            return Array.from(lines);
          }),
        ),
      );
      expect(result).toEqual([`{"first":true}`, message]);
    } finally {
      await splitRuntime.dispose();
    }
  });

  it("exposes a port at the preview-url endpoint and returns only the url", async () => {
    const recorded: RecordedRequest[] = [];
    runtime = makeRuntime(
      [
        {
          method: "GET",
          path: "/ports/3000/preview-url",
          json: { url: "https://3000-sb-1.proxy.daytona.work", token: "preview-tok" },
        },
      ],
      recorded,
    );
    const local = runtime;
    const route = await local.runPromise(
      Effect.flatMap(DaytonaSandboxClient.asEffect(), (client) => client.exposePort("sb-1", 3000)),
    );
    expect(route).toEqual({ url: "https://3000-sb-1.proxy.daytona.work" });
    expect(recorded[0]?.url).toBe(`${API_URL}/sandbox/sb-1/ports/3000/preview-url`);
  });

  it("snapshots via POST /sandbox/{id}/snapshot and extracts the snapshot id", async () => {
    const recorded: RecordedRequest[] = [];
    runtime = makeRuntime(
      [{ method: "POST", path: "/snapshot", json: { snapshotId: "snap-42" } }],
      recorded,
    );
    const local = runtime;
    const result = await local.runPromise(
      Effect.flatMap(DaytonaSandboxClient.asEffect(), (client) =>
        client.snapshot("sb-1", "checkpoint"),
      ),
    );
    expect(result.snapshotId).toBe("snap-42");
    expect(recorded[0]?.url).toBe(`${API_URL}/sandbox/sb-1/snapshot`);
    expect(recorded[0]?.body).toMatchObject({ name: "checkpoint" });
  });

  it("refreshes activity via POST /sandbox/{id}/start and stops via /stop", async () => {
    const recorded: RecordedRequest[] = [];
    runtime = makeRuntime(
      [
        { method: "POST", path: "/start", status: 200 },
        { method: "POST", path: "/stop", status: 200 },
      ],
      recorded,
    );
    const local = runtime;
    await local.runPromise(
      Effect.flatMap(DaytonaSandboxClient.asEffect(), (client) =>
        Effect.gen(function* () {
          yield* client.refreshActivity("sb-1");
          yield* client.stop("sb-1");
        }),
      ),
    );
    expect(recorded[0]?.url).toBe(`${API_URL}/sandbox/sb-1/start`);
    expect(recorded[1]?.url).toBe(`${API_URL}/sandbox/sb-1/stop`);
  });

  it("normalizes a get-status state and reports a 404 as a lost (null) instance", async () => {
    const recorded: RecordedRequest[] = [];
    runtime = makeRuntime(
      [{ method: "GET", path: "/sandbox/sb-live", json: { id: "sb-live", state: "started" } }],
      recorded,
    );
    const local = runtime;
    const result = await local.runPromise(
      Effect.flatMap(DaytonaSandboxClient.asEffect(), (client) =>
        Effect.gen(function* () {
          const live = yield* client.getStatus("sb-live");
          // sb-gone matches no route -> the stub returns 404 -> resolves to null.
          const gone = yield* client.getStatus("sb-gone");
          return { live, gone };
        }),
      ),
    );
    expect(result.live?.status).toBe("running");
    expect(result.gone).toBeNull();
  });

  it("treats destroy of an unknown sandbox (404) as idempotent success", async () => {
    const recorded: RecordedRequest[] = [];
    // No routes -> archive and DELETE both 404; destroy must still succeed.
    runtime = makeRuntime([], recorded);
    const local = runtime;
    await local.runPromise(
      Effect.flatMap(DaytonaSandboxClient.asEffect(), (client) => client.destroy("sb-missing")),
    );
    expect(recorded.some((request) => request.method === "DELETE")).toBe(true);
  });

  it("fails create with a DaytonaApiError carrying the HTTP status on a non-2xx", async () => {
    const recorded: RecordedRequest[] = [];
    runtime = makeRuntime(
      [{ method: "POST", path: "/sandbox", status: 500, text: "internal error" }],
      recorded,
    );
    const local = runtime;
    const error = await local.runPromise(
      Effect.flatMap(DaytonaSandboxClient.asEffect(), (client) =>
        client.create({ threadId: "t", ports: [], snapshotId: null }),
      ).pipe(Effect.flip),
    );
    expect(error._tag).toBe("DaytonaApiError");
    expect(error.status).toBe(500);
    expect(error.operation).toBe("create");
  });

  it("fails loudly when a create response is missing the required id (shape drift)", async () => {
    const recorded: RecordedRequest[] = [];
    runtime = makeRuntime(
      // A valid 200 but the documented `id` is absent: decoding must reject.
      [{ method: "POST", path: "/sandbox", json: { unexpected: true } }],
      recorded,
    );
    const local = runtime;
    const error = await local.runPromise(
      Effect.flatMap(DaytonaSandboxClient.asEffect(), (client) =>
        client.create({ threadId: "t", ports: [], snapshotId: null }),
      ).pipe(Effect.flip),
    );
    expect(error._tag).toBe("DaytonaApiError");
    expect(error.status).toBe(200);
  });

  it("redacts the bearer token from a DaytonaApiError detail", async () => {
    const recorded: RecordedRequest[] = [];
    runtime = makeRuntime(
      // The error body echoes the API key; it must be masked in the detail.
      [{ method: "POST", path: "/sandbox", status: 401, text: "bad token secret-key-123" }],
      recorded,
    );
    const local = runtime;
    const error = await local.runPromise(
      Effect.flatMap(DaytonaSandboxClient.asEffect(), (client) =>
        client.create({ threadId: "t", ports: [], snapshotId: null }),
      ).pipe(Effect.flip),
    );
    expect(error.detail).not.toContain("secret-key-123");
    expect(error.detail).toContain("***");
  });
});

/**
 * HttpDaytonaSandboxClient PTY-vs-poll selection tests.
 *
 * `startSession` prefers the duplex PTY WebSocket transport when
 * `credentials.ptyTransport` is set and falls back to the logs-polling transport
 * on any PTY connect failure. These tests drive that selection through an
 * injected PTY connector (no real `ws`):
 *
 *   - ptyTransport off: never touches the PTY connector; uses polling.
 *   - ptyTransport on + connector succeeds: streams over the fake PTY socket, the
 *     poll endpoints are never hit.
 *   - ptyTransport on + connector fails: falls back to polling, still producing
 *     the agent's output and exit (the working default stays the safety net).
 *
 * @module daytona/HttpDaytonaSandboxClient.ptySelection.test
 */
import { Effect, ManagedRuntime, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { DaytonaCredentials } from "./DaytonaConfig.ts";
import { DaytonaApiError } from "./DaytonaErrors.ts";
import type { DaytonaPtyConnect } from "./DaytonaPtyConnector.ts";
import type { DaytonaPtyConnection, DaytonaPtyFrame } from "./DaytonaPtyTransport.ts";
import type { DaytonaSandboxClientShape } from "./DaytonaSandboxClient.ts";
import { makeHttpDaytonaSandboxClient } from "./HttpDaytonaSandboxClient.ts";

const API_URL = "https://daytona.test/api";

const makeCredentials = (ptyTransport: boolean): DaytonaCredentials => ({
  apiKey: "secret-key-123",
  apiUrl: API_URL,
  target: undefined,
  organizationId: "org-1",
  snapshot: undefined,
  ptyTransport,
});

/** A controllable in-process PTY socket the connector stub resolves. */
const makeFakePtySocket = () => {
  let frameHandler: ((frame: DaytonaPtyFrame) => void) | undefined;
  let closeHandler: ((reason: string) => void) | undefined;
  const encoder = new TextEncoder();
  const connection: DaytonaPtyConnection = {
    send: () => {},
    close: () => closeHandler?.(""),
    onFrame: (handler) => {
      frameHandler = handler;
    },
    onClose: (handler) => {
      closeHandler = handler;
    },
  };
  return {
    connection,
    pushData: (text: string) => frameHandler?.({ _tag: "data", bytes: encoder.encode(text) }),
    closeWith: (reason: string) => closeHandler?.(reason),
  };
};

/** Stub HttpClient that serves the polling session endpoints and records URLs. */
const makePollHttpClient = (recordedUrls: string[]): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        recordedUrls.push(request.url);
        const json = (value: unknown) =>
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(value), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        if (request.method === "POST" && request.url.includes("/exec")) {
          return json({ cmdId: "cmd-poll" });
        }
        if (request.method === "POST" && request.url.includes("/process/session")) {
          return json({});
        }
        if (request.method === "GET" && request.url.includes("/logs")) {
          if (request.url.includes("follow=true")) {
            return HttpClientResponse.fromWeb(request, new Response("boom", { status: 500 }));
          }
          return HttpClientResponse.fromWeb(request, new Response("poll-line\n", { status: 200 }));
        }
        if (request.method === "GET" && request.url.includes("/command/cmd-poll")) {
          return json({ exitCode: 0 });
        }
        return HttpClientResponse.fromWeb(request, new Response("not found", { status: 404 }));
      }),
    ),
  );

const drainSession = (client: DaytonaSandboxClientShape) =>
  Effect.gen(function* () {
    const session = yield* client.startSession("sb-1", {
      command: "codex",
      args: [],
    });
    const lines = yield* session.stdoutLines.pipe(Stream.runCollect);
    const status = yield* session.exit;
    yield* session.close;
    return { lines: Array.from(lines), status };
  });

describe("HttpDaytonaSandboxClient PTY selection", () => {
  let runtime: ManagedRuntime.ManagedRuntime<HttpClient.HttpClient, never> | undefined;
  afterEach(async () => {
    if (runtime) {
      await runtime.dispose().catch(() => {});
      runtime = undefined;
    }
  });

  const run = <A, E>(
    credentials: DaytonaCredentials,
    ptyConnect: DaytonaPtyConnect,
    recordedUrls: string[],
    body: (client: DaytonaSandboxClientShape) => Effect.Effect<A, E>,
  ): Promise<A> => {
    const made = ManagedRuntime.make(makePollHttpClient(recordedUrls));
    runtime = made;
    return made.runPromise(
      makeHttpDaytonaSandboxClient(credentials, { ptyConnect }).pipe(
        Effect.flatMap((client) => body(client)),
      ) as Effect.Effect<A, E, never>,
    );
  };

  it("uses the polling transport when ptyTransport is off (never opens the PTY)", async () => {
    let ptyOpened = false;
    const ptyConnect: DaytonaPtyConnect = () => {
      ptyOpened = true;
      return Effect.die("PTY must not be opened when disabled");
    };
    const urls: string[] = [];
    const result = await run(makeCredentials(false), ptyConnect, urls, (client) =>
      drainSession(client),
    );
    expect(ptyOpened).toBe(false);
    expect(result.lines).toEqual(["poll-line"]);
    expect(result.status).toEqual({ code: 0, signal: null });
  });

  it("prefers the PTY transport when enabled (no poll endpoints hit)", async () => {
    const fake = makeFakePtySocket();
    const ptyConnect: DaytonaPtyConnect = () =>
      Effect.sync(() => {
        // Stream the agent output over the PTY socket, then exit.
        queueMicrotask(() => {
          fake.pushData("pty-line\n");
          fake.closeWith('{"exitCode":0}');
        });
        return fake.connection;
      });
    const urls: string[] = [];
    const result = await run(makeCredentials(true), ptyConnect, urls, (client) =>
      drainSession(client),
    );
    expect(result.lines).toEqual(["pty-line"]);
    expect(result.status).toEqual({ code: 0, signal: null });
    // The PTY path replaces the polling endpoints entirely.
    expect(urls.some((url) => url.includes("/process/session"))).toBe(false);
    expect(urls.some((url) => url.includes("/logs"))).toBe(false);
  });

  it("falls back to polling when the PTY connector fails", async () => {
    const ptyConnect: DaytonaPtyConnect = () =>
      Effect.fail(
        new DaytonaApiError({
          operation: "startPtySession",
          status: null,
          detail: "WS upgrade refused",
        }),
      );
    const urls: string[] = [];
    const result = await run(makeCredentials(true), ptyConnect, urls, (client) =>
      drainSession(client),
    );
    // The poll transport produced the output and exit despite the PTY failure.
    expect(result.lines).toEqual(["poll-line"]);
    expect(result.status).toEqual({ code: 0, signal: null });
    expect(urls.some((url) => url.includes("/process/session"))).toBe(true);
  });
});

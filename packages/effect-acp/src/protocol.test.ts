import { spawn } from "node:child_process";

import * as Path from "effect/Path";
import * as AcpError from "./errors.ts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Ref from "effect/Ref";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { it, assert } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as AcpSchema from "./_generated/schema.gen.ts";
import * as AcpProtocol from "./protocol.ts";
import {
  encodeJsonl,
  jsonRpcNotification,
  jsonRpcRequest,
  jsonRpcResponse,
} from "./_internal/shared.ts";
import { makeInMemoryStdio, makeTerminationError, makeChildStdio } from "./_internal/stdio.ts";

const SessionCancelNotification = jsonRpcNotification(
  "session/cancel",
  AcpSchema.CancelNotification,
);
const SessionUpdateNotification = jsonRpcNotification(
  "session/update",
  AcpSchema.SessionNotification,
);
const ElicitationCompleteNotification = jsonRpcNotification(
  "session/elicitation/complete",
  AcpSchema.ElicitationCompleteNotification,
);
const RequestPermissionRequest = jsonRpcRequest(
  "session/request_permission",
  AcpSchema.RequestPermissionRequest,
);
const CHILD_PROCESS_FIXTURE_TIMEOUT_MS = 15_000;
const RequestPermissionResponse = jsonRpcResponse(AcpSchema.RequestPermissionResponse);
const ExtResponse = jsonRpcResponse(Schema.Struct({ ok: Schema.Boolean }));
const CursorUpdateTodosRequest = jsonRpcRequest(
  "cursor/update_todos",
  Schema.Struct({
    id: Schema.Number,
    nested: Schema.Struct({ id: Schema.Number }),
  }),
);
const textEncoder = new TextEncoder();
const stdioDiagnosticFixturePath = new URL(
  "../test/fixtures/acp-protocol-stdio-diagnostic.ts",
  import.meta.url,
);

const mockPeerPath = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(import.meta.dirname, "../test/fixtures/acp-mock-peer.ts"),
);

const makeHandle = (env?: Record<string, string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const path = yield* Path.Path;
    const command = ChildProcess.make("bun", ["run", yield* mockPeerPath], {
      cwd: path.join(import.meta.dirname, ".."),
      shell: process.platform === "win32",
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    return yield* spawner.spawn(command);
  });

it.layer(NodeServices.layer)("effect-acp protocol", (it) => {
  it.effect(
    "emits exact JSON-RPC notifications and decodes inbound session/update and elicitation completion",
    () =>
      Effect.gen(function* () {
        const { stdio, input, output } = yield* makeInMemoryStdio();
        const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
          stdio,
          serverRequestMethods: new Set(),
        });

        const notifications =
          yield* Deferred.make<ReadonlyArray<AcpProtocol.AcpIncomingNotification>>();
        yield* transport.incoming.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.flatMap((notificationChunk) => Deferred.succeed(notifications, notificationChunk)),
          Effect.forkScoped,
        );

        yield* transport.notify("session/cancel", { sessionId: "session-1" });
        const outbound = yield* Queue.take(output);
        assert.deepEqual(
          yield* Schema.decodeEffect(Schema.fromJsonString(SessionCancelNotification))(outbound),
          {
            jsonrpc: "2.0",
            method: "session/cancel",
            params: {
              sessionId: "session-1",
            },
          },
        );

        yield* Queue.offer(
          input,
          yield* encodeJsonl(SessionUpdateNotification, {
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "session-1",
              update: {
                sessionUpdate: "plan",
                entries: [
                  {
                    content: "Inspect repository",
                    priority: "high",
                    status: "in_progress",
                  },
                ],
              },
            },
          }),
        );

        yield* Queue.offer(
          input,
          yield* encodeJsonl(ElicitationCompleteNotification, {
            jsonrpc: "2.0",
            method: "session/elicitation/complete",
            params: {
              elicitationId: "elicitation-1",
            },
          }),
        );

        const [update, completion] = yield* Deferred.await(notifications);
        assert.equal(update?._tag, "SessionUpdate");
        assert.equal(completion?._tag, "ElicitationComplete");
      }),
  );

  it.effect("logs outgoing notifications when logOutgoing is enabled", () =>
    Effect.gen(function* () {
      const { stdio } = yield* makeInMemoryStdio();
      const events: Array<AcpProtocol.AcpProtocolLogEvent> = [];
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        logOutgoing: true,
        logger: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
      });

      yield* transport.notify("session/cancel", { sessionId: "session-1" });

      assert.deepEqual(events, [
        {
          direction: "outgoing",
          stage: "decoded",
          payload: {
            _tag: "Request",
            id: "",
            tag: "session/cancel",
            payload: {
              sessionId: "session-1",
            },
            headers: [],
          },
        },
        {
          direction: "outgoing",
          stage: "raw",
          payload: '{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"session-1"}}\n',
        },
      ]);
    }),
  );

  it.effect("maps generic request interruption to and from $/cancel_request", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(["session/request_permission"]),
      });

      yield* transport.clientProtocol.send({
        _tag: "Interrupt",
        requestId: "7",
      });
      const outbound = yield* Queue.take(output);
      assert.deepEqual(
        JSON.parse(typeof outbound === "string" ? outbound : new TextDecoder().decode(outbound)),
        {
          jsonrpc: "2.0",
          method: "$/cancel_request",
          params: { requestId: 7 },
        },
      );

      const messages = yield* Deferred.make<ReadonlyArray<unknown>>();
      const received = yield* Ref.make<ReadonlyArray<unknown>>([]);
      yield* transport.serverProtocol
        .run((_clientId, message) =>
          Ref.updateAndGet(
            received,
            (current) => [...current, message],
          ).pipe(
            Effect.flatMap((current) =>
              current.length === 2 ? Deferred.succeed(messages, current) : Effect.void,
            ),
            Effect.asVoid,
          ),
        )
        .pipe(Effect.forkScoped);

      yield* Queue.offer(
        input,
        textEncoder.encode(
          '{"jsonrpc":"2.0","id":0,"method":"session/request_permission","params":{}}\n',
        ),
      );
      yield* Queue.offer(
        input,
        textEncoder.encode(
          '{"jsonrpc":"2.0","method":"$/cancel_request","params":{"requestId":0}}\n',
        ),
      );

      const [requestMessage, interruptMessage] = yield* Deferred.await(messages);
      assert.match((requestMessage as { id: string }).id, /^-\d+$/);
      assert.deepEqual(requestMessage, {
        _tag: "Request",
        id: (requestMessage as { id: string }).id,
        tag: "session/request_permission",
        payload: {},
        headers: [],
      });
      assert.deepEqual(interruptMessage, {
        _tag: "Interrupt",
        requestId: (requestMessage as { id: string }).id,
      });
    }),
  );

  it.effect("ignores unknown wire cancellations without entering the internal id namespace", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(["x/test"]),
      });
      const received = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const messages = yield* Deferred.make<ReadonlyArray<unknown>>();
      yield* transport.serverProtocol
        .run((_clientId, message) =>
          Ref.updateAndGet(received, (current) => [...current, message]).pipe(
            Effect.flatMap((current) =>
              current.length === 2 ? Deferred.succeed(messages, current) : Effect.void,
            ),
            Effect.asVoid,
          ),
        )
        .pipe(Effect.forkScoped);

      yield* Queue.offer(
        input,
        textEncoder.encode(
          '{"jsonrpc":"2.0","id":5,"method":"x/test","params":{}}\n',
        ),
      );
      yield* Queue.offer(
        input,
        textEncoder.encode(
          '{"jsonrpc":"2.0","method":"$/cancel_request","params":{"requestId":-1}}\n',
        ),
      );
      yield* Queue.offer(
        input,
        textEncoder.encode(
          '{"jsonrpc":"2.0","method":"$/cancel_request","params":{"requestId":5}}\n',
        ),
      );

      assert.deepEqual(yield* Deferred.await(messages), [
        {
          _tag: "Request",
          id: "-1",
          tag: "x/test",
          payload: {},
          headers: [],
        },
        { _tag: "Interrupt", requestId: "-1" },
      ]);
    }),
  );

  it.effect("rejects invalid and non-finite wire ids consistently", () =>
    Effect.gen(function* () {
      const cases = [
        {
          line: '{"jsonrpc":"2.0","id":{"invalid":true},"method":"x/test","params":{}}\n',
          expected: /Invalid ACP JSON-RPC request id/,
        },
        {
          line: '{"jsonrpc":"2.0","id":1e400,"method":"x/test","params":{}}\n',
          expected: /Invalid ACP JSON-RPC request id/,
        },
        {
          line: '{"jsonrpc":"2.0","method":"$/cancel_request","params":{"requestId":1e400}}\n',
          expected: /Invalid \$\/cancel_request requestId/,
        },
        {
          line: '{"jsonrpc":"2.0","id":1e400,"result":{}}\n',
          expected: /Invalid ACP JSON-RPC response id/,
        },
      ] as const;

      for (const testCase of cases) {
        const { stdio, input } = yield* makeInMemoryStdio();
        const termination = yield* Deferred.make<AcpError.AcpError>();
        yield* AcpProtocol.makeAcpPatchedProtocol({
          stdio,
          serverRequestMethods: new Set(["x/test"]),
          onTermination: (error) => Deferred.succeed(termination, error).pipe(Effect.asVoid),
        });

        yield* Queue.offer(input, textEncoder.encode(testCase.line));

        const error = yield* Deferred.await(termination);
        assert.equal(error._tag, "AcpProtocolParseError");
        assert.match(String(error.cause), testCase.expected);
      }
    }),
  );

  it.effect("fails notification encoding through the declared ACP error channel", () =>
    Effect.gen(function* () {
      const { stdio } = yield* makeInMemoryStdio();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
      });

      const bigintError = yield* transport.notify("x/test", 1n).pipe(Effect.flip);
      assert.instanceOf(bigintError, AcpError.AcpProtocolParseError);
      assert.equal(bigintError.detail, "Failed to encode ACP message");

      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const circularError = yield* transport.notify("x/test", circular).pipe(Effect.flip);
      assert.instanceOf(circularError, AcpError.AcpProtocolParseError);
      assert.equal(circularError.detail, "Failed to encode ACP message");
    }),
  );

  it.effect("supports generic extension requests over the patched transport", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
      });

      const response = yield* transport
        .request("x/test", { hello: "world" })
        .pipe(Effect.forkScoped);
      const outbound = yield* Queue.take(output);
      assert.deepEqual(
        JSON.parse(typeof outbound === "string" ? outbound : new TextDecoder().decode(outbound)),
        {
        jsonrpc: "2.0",
        id: 1,
        method: "x/test",
        params: {
          hello: "world",
        },
        },
      );

      yield* Queue.offer(
        input,
        yield* encodeJsonl(ExtResponse, {
          jsonrpc: "2.0",
          id: 1,
          result: {
            ok: true,
          },
        }),
      );

      const resolved = yield* Fiber.join(response);
      assert.deepEqual(resolved, { ok: true });
    }),
  );

  it.effect("replies to extension requests with string ids without losing the id", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        onExtRequest: (method, params) =>
          Effect.succeed({
            method,
            params,
            reloaded: true,
          }),
      });

      yield* Queue.offer(
        input,
        textEncoder.encode(
          '{"jsonrpc":"2.0","id":"skills-reload","method":"x.ai/skills_reload","params":{"source":"grok"}}\n',
        ),
      );

      const outbound = yield* Queue.take(output);
      const decoded = JSON.parse(
        typeof outbound === "string" ? outbound : new TextDecoder().decode(outbound),
      );
      assert.deepEqual(decoded, {
        jsonrpc: "2.0",
        id: "skills-reload",
        result: {
          method: "x.ai/skills_reload",
          params: { source: "grok" },
          reloaded: true,
        },
      });
    }),
  );

  it.effect("drops untracked string-id responses before Effect RPC coerces ids to BigInt", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const dropped = yield* Deferred.make<AcpProtocol.AcpProtocolLogEvent>();
      yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        logIncoming: true,
        logger: (event) =>
          event.stage === "dropped"
            ? Deferred.succeed(dropped, event).pipe(Effect.asVoid)
            : Effect.void,
      });

      yield* Queue.offer(
        input,
        textEncoder.encode('{"jsonrpc":"2.0","id":"skills-reload","result":{"ok":true}}\n'),
      );

      const maybeEvent = yield* Deferred.await(dropped).pipe(Effect.timeoutOption(1000));
      assert.equal(Option.isSome(maybeEvent), true);
      if (Option.isSome(maybeEvent)) {
        assert.deepEqual(maybeEvent.value.payload, {
          reason: "untracked-string-response-id",
          requestId: "skills-reload",
          message: {
            _tag: "Exit",
            requestId: "skills-reload",
            exit: {
              _tag: "Success",
              value: { ok: true },
            },
          },
        });
      }
    }),
  );

  it.effect("keeps built-in dropped-message diagnostics off ACP stdout", () =>
    Effect.gen(function* () {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let ready: (() => void) | undefined;
      const readyOutput = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const child = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const process = spawn("bun", [stdioDiagnosticFixturePath.pathname], {
            cwd: import.meta.dirname,
            stdio: ["pipe", "pipe", "pipe"],
          });
          process.stdout.on("data", (chunk: Buffer) => {
            stdoutChunks.push(chunk);
            if (Buffer.concat(stdoutChunks).includes(0x0a)) {
              ready?.();
            }
          });
          process.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
          return process;
        }),
        (process) =>
          Effect.sync(() => {
            if (process.exitCode === null && process.signalCode === null) {
              process.kill("SIGTERM");
            }
          }),
      );

      yield* Effect.promise(() => readyOutput);
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.once("close", (code, signal) => resolve({ code, signal })),
      );
      child.stdin.end('{"jsonrpc":"2.0","id":"orphan","result":{"ok":true}}\n');
      assert.deepEqual(yield* Effect.promise(() => closed), { code: 0, signal: null });

      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const messages = stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown);
      assert.deepEqual(messages, [
        {
          jsonrpc: "2.0",
          method: "conformance/ready",
          params: { ready: true },
        },
      ]);
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      assert.match(stderr, /acp\.protocol\.dropped/);
      assert.match(stderr, /untracked-string-response-id/);
    }),
    CHILD_PROCESS_FIXTURE_TIMEOUT_MS,
  );

  it.effect("accepts agent response metadata with primitive extension values", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
      });

      const response = yield* transport
        .request("x/test", { hello: "world" })
        .pipe(Effect.forkScoped);
      yield* Queue.take(output);

      yield* Queue.offer(
        input,
        textEncoder.encode(
          '{"jsonrpc":"2.0","id":1,"result":{"ok":true,"_meta":{"grokShell":true},"agentCapabilities":{"_meta":{"x.ai/fs_notify":true}}}}\n',
        ),
      );

      const resolved = yield* Fiber.join(response);
      assert.deepEqual(resolved, {
        ok: true,
        _meta: { grokShell: true },
        agentCapabilities: { _meta: { "x.ai/fs_notify": true } },
      });
    }),
  );

  it.effect("accepts agent response metadata nested inside array results", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
      });

      const response = yield* transport
        .request("x/test", { hello: "world" })
        .pipe(Effect.forkScoped);
      yield* Queue.take(output);

      yield* Queue.offer(
        input,
        textEncoder.encode(
          '{"jsonrpc":"2.0","id":1,"result":[{"ok":true,"_meta":{"grokShell":true}}]}\n',
        ),
      );

      const resolved = yield* Fiber.join(response);
      assert.deepEqual(resolved, [{ ok: true, _meta: { grokShell: true } }]);
    }),
  );

  it.effect("preserves zero-valued ids for inbound core client requests", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(["session/request_permission"]),
      });
      const inboundRequest = yield* Deferred.make<unknown>();

      yield* transport.serverProtocol
        .run((_clientId, message) => Deferred.succeed(inboundRequest, message).pipe(Effect.asVoid))
        .pipe(Effect.forkScoped);

      yield* Queue.offer(
        input,
        yield* encodeJsonl(RequestPermissionRequest, {
          jsonrpc: "2.0",
          id: 0,
          method: "session/request_permission",
          params: {
            sessionId: "session-1",
            toolCall: {
              toolCallId: "tool-1",
              title: "Allow mock action",
            },
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
          },
          headers: [],
        }),
      );

      const message = yield* Deferred.await(inboundRequest);
      const requestId = (message as { id: string }).id;
      assert.match(requestId, /^-\d+$/);
      assert.deepEqual(message, {
        _tag: "Request",
        id: requestId,
        tag: "session/request_permission",
        payload: {
          sessionId: "session-1",
          toolCall: {
            toolCallId: "tool-1",
            title: "Allow mock action",
          },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        },
        headers: [],
      });

      yield* transport.serverProtocol.send(0, {
        _tag: "Exit",
        requestId,
        exit: {
          _tag: "Success",
          value: {
            outcome: {
              outcome: "selected",
              optionId: "allow",
            },
          },
        },
      });

      const outbound = yield* Queue.take(output);
      assert.deepEqual(
        yield* Schema.decodeEffect(Schema.fromJsonString(RequestPermissionResponse))(outbound),
        {
          jsonrpc: "2.0",
          id: 0,
          result: {
            outcome: {
              outcome: "selected",
              optionId: "allow",
            },
          },
        },
      );
    }),
  );

  it.effect("replies to core client requests with string ids without losing the id", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(["session/request_permission"]),
      });
      const inboundRequest = yield* Deferred.make<unknown>();

      yield* transport.serverProtocol
        .run((_clientId, message) => Deferred.succeed(inboundRequest, message).pipe(Effect.asVoid))
        .pipe(Effect.forkScoped);

      yield* Queue.offer(
        input,
        textEncoder.encode(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "perm-1",
            method: "session/request_permission",
            params: {
              sessionId: "session-1",
              toolCall: {
                toolCallId: "tool-1",
                title: "Allow mock action",
              },
              options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
            },
            headers: [],
          }) + "\n",
        ),
      );

      const message = yield* Deferred.await(inboundRequest);
      const requestId = (message as { id: string }).id;
      assert.match(requestId, /^-\d+$/);
      assert.deepEqual(message, {
        _tag: "Request",
        id: requestId,
        tag: "session/request_permission",
        payload: {
          sessionId: "session-1",
          toolCall: {
            toolCallId: "tool-1",
            title: "Allow mock action",
          },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        },
        headers: [],
      });

      yield* transport.serverProtocol.send(0, {
        _tag: "Exit",
        requestId,
        exit: {
          _tag: "Success",
          value: {
            outcome: {
              outcome: "selected",
              optionId: "allow",
            },
          },
        },
      });

      const outbound = yield* Queue.take(output);
      assert.deepEqual(
        JSON.parse(typeof outbound === "string" ? outbound : new TextDecoder().decode(outbound)),
        {
          jsonrpc: "2.0",
          id: "perm-1",
          result: {
            outcome: {
              outcome: "selected",
              optionId: "allow",
            },
          },
        },
      );
    }),
  );

  it.effect(
    "correlates concurrent 0, '0', empty-string, and discouraged null ids out of order",
    () =>
      Effect.gen(function* () {
        const { stdio, input, output } = yield* makeInMemoryStdio();
        const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
          stdio,
          serverRequestMethods: new Set(["x/test"]),
        });
        const received = yield* Ref.make<ReadonlyArray<unknown>>([]);
        const allMessages = yield* Deferred.make<ReadonlyArray<unknown>>();
        yield* transport.serverProtocol
          .run((_clientId, message) =>
            Ref.updateAndGet(received, (current) => [...current, message]).pipe(
              Effect.flatMap((current) =>
              current.length === 6 ? Deferred.succeed(allMessages, current) : Effect.void,
              ),
              Effect.asVoid,
            ),
          )
          .pipe(Effect.forkScoped);

        for (const id of [0, "0", "", null] as const) {
          yield* Queue.offer(
            input,
            textEncoder.encode(
              `${JSON.stringify({ jsonrpc: "2.0", id, method: "x/test", params: { id } })}\n`,
            ),
          );
        }
        yield* Queue.offer(
          input,
          textEncoder.encode(
            '{"jsonrpc":"2.0","method":"$/cancel_request","params":{"requestId":"0"}}\n',
          ),
        );
        yield* Queue.offer(
          input,
          textEncoder.encode(
            '{"jsonrpc":"2.0","method":"$/cancel_request","params":{"requestId":null}}\n',
          ),
        );

        const messages = yield* Deferred.await(allMessages);
        const requests = messages.slice(0, 4) as ReadonlyArray<{ id: string }>;
        assert.equal(new Set(requests.map((request) => request.id)).size, 4);
        assert.deepEqual(messages[4], {
          _tag: "Interrupt",
          requestId: requests[1]!.id,
        });
        assert.deepEqual(messages[5], {
          _tag: "Interrupt",
          requestId: requests[3]!.id,
        });

        const responseOrder = [requests[3]!, requests[2]!, requests[1]!, requests[0]!];
        const wireIds: unknown[] = [];
        for (const request of responseOrder) {
          yield* transport.serverProtocol.send(0, {
            _tag: "Exit",
            requestId: request.id,
            exit: { _tag: "Success", value: { ok: true } },
          });
          const outbound = yield* Queue.take(output);
          wireIds.push(
            (
              JSON.parse(
                typeof outbound === "string" ? outbound : new TextDecoder().decode(outbound),
              ) as { id: unknown }
            ).id,
          );
        }
        assert.deepEqual(wireIds, [null, "", "0", 0]);
      }),
  );

  it.effect("does not rewrite nested zero-valued ids in extension request payloads", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const receivedParams = yield* Deferred.make<unknown>();
      yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        onExtRequest: (_method, params) =>
          Deferred.succeed(receivedParams, params).pipe(Effect.as({ ok: true })),
      });

      yield* Queue.offer(
        input,
        yield* encodeJsonl(CursorUpdateTodosRequest, {
          jsonrpc: "2.0",
          id: 0,
          method: "cursor/update_todos",
          headers: [],
          params: {
            id: 0,
            nested: { id: 0 },
          },
        }),
      );

      assert.deepEqual(yield* Deferred.await(receivedParams), {
        id: 0,
        nested: { id: 0 },
      });
    }),
  );

  it.effect("keeps split UTF-8 chunks intact while normalizing inbound messages", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
      });
      const notifications =
        yield* Deferred.make<ReadonlyArray<AcpProtocol.AcpIncomingNotification>>();
      yield* transport.incoming.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.flatMap((notificationChunk) => Deferred.succeed(notifications, notificationChunk)),
        Effect.forkScoped,
      );

      const encoded = yield* encodeJsonl(SessionUpdateNotification, {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "accento è",
            },
          },
        },
      });
      const splitIndex = encoded.findIndex((byte) => byte === 0xc3) + 1;
      yield* Queue.offer(input, encoded.slice(0, splitIndex));
      yield* Queue.offer(input, encoded.slice(splitIndex));

      const [update] = yield* Deferred.await(notifications);
      assert.equal(update?._tag, "SessionUpdate");
      if (update?._tag === "SessionUpdate") {
        assert.deepEqual(update.params.update, {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "accento è",
          },
        });
      }
    }),
  );

  it.effect("flushes a final inbound message without a trailing newline", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
      });
      const notifications =
        yield* Deferred.make<ReadonlyArray<AcpProtocol.AcpIncomingNotification>>();
      yield* transport.incoming.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.flatMap((notificationChunk) => Deferred.succeed(notifications, notificationChunk)),
        Effect.forkScoped,
      );

      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(SessionUpdateNotification))({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "final message",
            },
          },
        },
      });
      yield* Queue.offer(input, textEncoder.encode(encoded));
      yield* Queue.end(input);

      const [update] = yield* Deferred.await(notifications);
      assert.equal(update?._tag, "SessionUpdate");
      if (update?._tag === "SessionUpdate") {
        assert.deepEqual(update.params.update, {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "final message",
          },
        });
      }
    }),
  );

  it.effect("cleans up interrupted extension requests before a late response arrives", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
      });
      const lateResponse = yield* Deferred.make<unknown>();

      yield* transport.clientProtocol
        .run((message) => Deferred.succeed(lateResponse, message).pipe(Effect.asVoid))
        .pipe(Effect.forkScoped);

      const response = yield* transport
        .request("x/test", { hello: "world" })
        .pipe(Effect.forkScoped);
      const outbound = yield* Queue.take(output);
      assert.deepEqual(
        JSON.parse(typeof outbound === "string" ? outbound : new TextDecoder().decode(outbound)),
        {
        jsonrpc: "2.0",
        id: 1,
        method: "x/test",
        params: {
          hello: "world",
        },
        },
      );

      yield* Fiber.interrupt(response);
      yield* Queue.offer(
        input,
        yield* encodeJsonl(ExtResponse, {
          jsonrpc: "2.0",
          id: 1,
          result: {
            ok: true,
          },
        }),
      );

      const message = yield* Deferred.await(lateResponse);
      assert.deepEqual(message, {
        _tag: "Exit",
        requestId: "1",
        exit: {
          _tag: "Success",
          value: {
            ok: true,
          },
        },
      });
    }),
  );

  it.effect("propagates the real child exit code when the input stream ends", () =>
    Effect.gen(function* () {
      const handle = yield* makeHandle({ ACP_MOCK_EXIT_IMMEDIATELY_CODE: "7" });
      const firstMessage = yield* Deferred.make<unknown>();
      const termination = yield* Deferred.make<AcpError.AcpError>();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio: makeChildStdio(handle),
        terminationError: makeTerminationError(handle),
        serverRequestMethods: new Set(),
        onTermination: (error) => Deferred.succeed(termination, error).pipe(Effect.asVoid),
      });

      yield* transport.clientProtocol
        .run((message) => Deferred.succeed(firstMessage, message).pipe(Effect.asVoid))
        .pipe(Effect.forkScoped);

      const message = yield* Deferred.await(firstMessage);
      const exitError = yield* Deferred.await(termination);
      assert.instanceOf(exitError, AcpError.AcpProcessExitedError);
      assert.equal((exitError as AcpError.AcpProcessExitedError).code, 7);
      assert.equal((message as { readonly _tag?: string })._tag, "ClientProtocolError");
      const defect = (message as { readonly error: { readonly reason: unknown } }).error.reason as {
        readonly _tag: string;
        readonly cause: unknown;
      };
      assert.equal(defect._tag, "RpcClientDefect");
      assert.instanceOf(defect.cause, AcpError.AcpProcessExitedError);
      assert.equal((defect.cause as AcpError.AcpProcessExitedError).code, 7);
    }),
  );

  it.effect(
    "does not emit a second process-exit error after a decode failure",
    () =>
      Effect.gen(function* () {
        const handle = yield* makeHandle({
          ACP_MOCK_MALFORMED_OUTPUT: "1",
          ACP_MOCK_MALFORMED_OUTPUT_EXIT_CODE: "23",
        });
        const terminationCalls = yield* Ref.make(0);
        const firstMessage = yield* Deferred.make<unknown>();
        const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
          stdio: makeChildStdio(handle),
          terminationError: makeTerminationError(handle),
          serverRequestMethods: new Set(),
          onTermination: () => Ref.update(terminationCalls, (count) => count + 1),
        });

        yield* transport.clientProtocol
          .run((message) => Deferred.succeed(firstMessage, message).pipe(Effect.asVoid))
          .pipe(Effect.forkScoped);

        const message = yield* Deferred.await(firstMessage);
        assert.equal(yield* Ref.get(terminationCalls), 1);
        assert.equal((message as { readonly _tag?: string })._tag, "ClientProtocolError");
        const defect = (message as { readonly error: { readonly reason: unknown } }).error
          .reason as {
          readonly _tag: string;
          readonly cause: unknown;
        };
        assert.equal(defect._tag, "RpcClientDefect");
        assert.instanceOf(defect.cause, AcpError.AcpProtocolParseError);
      }),
    CHILD_PROCESS_FIXTURE_TIMEOUT_MS,
  );

  it.effect("fails pending extension requests with the propagated exit code", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        terminationError: Effect.succeed(new AcpError.AcpProcessExitedError({ code: 0 })),
        serverRequestMethods: new Set(),
      });

      const response = yield* transport
        .request("x/test", { hello: "world" })
        .pipe(Effect.forkScoped);
      yield* Queue.take(output);
      yield* Queue.end(input);

      const error = yield* Fiber.join(response).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => assert.fail("Expected request to fail after process exit"),
        }),
      );
      assert.instanceOf(error, AcpError.AcpProcessExitedError);
      assert.equal(error.code, 0);
    }),
  );
});

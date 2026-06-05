/**
 * DaytonaPtyTransport tests — the duplex PTY session over a fake in-process
 * socket (no `ws`, no network).
 *
 * These cover the PTY transport contract the polling tests cannot: binary frames
 * line-frame into inbound lines, a control text frame never reaches the JSON-RPC
 * stream, a written stdin frame is sent as raw bytes and its byte-identical echo
 * is suppressed, a single message split across two binary frames surfaces as one
 * line, and a WS close reason maps to the process exit.
 *
 * @module daytona/DaytonaPtyTransport.test
 */
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { DaytonaApiError } from "./DaytonaErrors.ts";
import {
  makeDaytonaPtySession,
  parsePtyExit,
  type DaytonaPtyConnection,
  type DaytonaPtyFrame,
} from "./DaytonaPtyTransport.ts";

/**
 * A controllable in-process PTY socket. Tests push frames / close it and read
 * back the raw stdin bytes the transport sent, with no real WebSocket.
 */
interface FakePtySocket extends DaytonaPtyConnection {
  readonly pushData: (text: string) => void;
  readonly pushControl: (status: string) => void;
  readonly closeWith: (reason: string) => void;
  readonly sentBytes: () => string[];
  readonly closed: () => boolean;
}

interface FakePtySocketOptions {
  /**
   * Echo each `send` back as an inbound data frame on the next microtask,
   * modeling a real PTY echoing stdin before `stty -echo` applies. Lets the
   * launch readiness gate resolve without a manual `pushData`.
   */
  readonly echoSends?: boolean;
}

const makeFakePtySocket = (options: FakePtySocketOptions = {}): FakePtySocket => {
  let frameHandler: ((frame: DaytonaPtyFrame) => void) | undefined;
  let closeHandler: ((reason: string) => void) | undefined;
  const sent: string[] = [];
  let isClosed = false;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const closeWith = (reason: string) => {
    if (!isClosed) {
      isClosed = true;
      closeHandler?.(reason);
    }
  };
  const pushData = (text: string) => frameHandler?.({ _tag: "data", bytes: encoder.encode(text) });
  return {
    send: (bytes) => {
      const text = decoder.decode(bytes);
      sent.push(text);
      if (options.echoSends) {
        queueMicrotask(() => pushData(text));
      }
    },
    close: () => closeWith(""),
    onFrame: (handler) => {
      frameHandler = handler;
    },
    onClose: (handler) => {
      closeHandler = handler;
    },
    pushData,
    pushControl: (status) => frameHandler?.({ _tag: "control", status }),
    closeWith,
    sentBytes: () => sent,
    closed: () => isClosed,
  };
};

type EmptyRuntime = ManagedRuntime.ManagedRuntime<never, never>;

describe("parsePtyExit", () => {
  it("reads the daemon exit JSON, defaults an empty/clean close to exit 0", () => {
    expect(parsePtyExit('{"exitCode":7}')).toEqual({ code: 7, signal: null });
    expect(parsePtyExit("")).toEqual({ code: 0, signal: null });
    expect(parsePtyExit("not json")).toEqual({ code: 0, signal: null });
    expect(parsePtyExit('{"exitReason":"ctrl-c"}')).toEqual({
      code: 0,
      signal: null,
    });
  });
});

describe("makeDaytonaPtySession", () => {
  let runtime: EmptyRuntime | undefined;

  const makeRuntime = (): EmptyRuntime => {
    const made = ManagedRuntime.make(Layer.empty);
    runtime = made;
    return made;
  };

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose().catch(() => {});
      runtime = undefined;
    }
  });

  const collect = (
    rt: EmptyRuntime,
    lines: Stream.Stream<string>,
    count: number,
  ): Promise<ReadonlyArray<string>> =>
    rt.runPromise(
      Stream.take(lines, count).pipe(
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );

  it("frames binary frames into lines and ignores control frames", async () => {
    const rt = makeRuntime();
    const socket = makeFakePtySocket();
    const session = await rt.runPromise(makeDaytonaPtySession(socket));
    const linesPromise = collect(rt, session.stdoutLines, 2);
    // A control frame must never become an inbound line.
    socket.pushControl("connected");
    socket.pushData("line-a\nline-b\n");
    expect(await linesPromise).toEqual(["line-a", "line-b"]);
    await rt.runPromise(session.close).catch(() => {});
  });

  it("carries a message split across two binary frames as a single line", async () => {
    const rt = makeRuntime();
    const socket = makeFakePtySocket();
    const message = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const session = await rt.runPromise(makeDaytonaPtySession(socket));
    const linesPromise = collect(rt, session.stdoutLines, 1);
    socket.pushData(message.slice(0, 10));
    socket.pushData(`${message.slice(10)}\n`);
    expect(await linesPromise).toEqual([message]);
    await rt.runPromise(session.close).catch(() => {});
  });

  it("sends stdin as raw bytes and suppresses its byte-identical echo", async () => {
    const rt = makeRuntime();
    const socket = makeFakePtySocket();
    const frame = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
    });
    const session = await rt.runPromise(makeDaytonaPtySession(socket));
    await rt.runPromise(session.writeStdin(frame));
    const linesPromise = collect(rt, session.stdoutLines, 1);
    // The PTY echoes the written frame back (before `stty -echo` applies); it
    // must be dropped, not dispatched. A real response line still flows through.
    socket.pushData(`${frame}\n`);
    socket.pushData('{"jsonrpc":"2.0","id":2,"result":{}}\n');
    const lines = await linesPromise;
    expect(socket.sentBytes()).toEqual([`${frame}\n`]);
    expect(lines).toEqual(['{"jsonrpc":"2.0","id":2,"result":{}}']);
    await rt.runPromise(session.close).catch(() => {});
  });

  it("maps a non-zero close reason to the process exit code", async () => {
    const rt = makeRuntime();
    const socket = makeFakePtySocket();
    const session = await rt.runPromise(makeDaytonaPtySession(socket));
    socket.closeWith('{"exitCode":137,"exitReason":"SIGKILL"}');
    const status = await rt.runPromise(session.exit);
    expect(status).toEqual({ code: 137, signal: null });
  });

  it("flushes an unterminated residual line on exit", async () => {
    const rt = makeRuntime();
    const socket = makeFakePtySocket();
    const session = await rt.runPromise(makeDaytonaPtySession(socket));
    const linesPromise = collect(rt, session.stdoutLines, 1);
    // A final message with no trailing newline must still surface once the PTY
    // exits, since no further bytes can arrive to terminate it.
    socket.pushData('{"final":true}');
    socket.closeWith('{"exitCode":0}');
    expect(await linesPromise).toEqual(['{"final":true}']);
  });

  it("close() tears the socket down and drains buffered lines", async () => {
    const rt = makeRuntime();
    const socket = makeFakePtySocket();
    const session = await rt.runPromise(makeDaytonaPtySession(socket));
    const linesPromise = collect(rt, session.stdoutLines, 1);
    socket.pushData("only-line\n");
    // A caller-initiated close (no prior socket exit) still drains the buffered
    // line, closes the socket (killing the remote PTY), and resolves exit.
    const status = await rt.runPromise(
      Effect.gen(function* () {
        yield* session.close;
        return yield* session.exit;
      }),
    );
    expect(socket.closed()).toBe(true);
    expect(await linesPromise).toEqual(["only-line"]);
    expect(status.signal).toBeNull();
  });

  it("writes the launch line as `exec <command>` once the PTY is live", async () => {
    const rt = makeRuntime();
    const socket = makeFakePtySocket({ echoSends: true });
    // The launch write is what makes the echoing socket emit its first frame,
    // which resolves the readiness gate so the session is returned.
    const session = await rt.runPromise(
      makeDaytonaPtySession(socket, {
        command: "bash -lc 'codex app-server'",
        readyTimeout: "2 seconds",
      }),
    );
    expect(socket.sentBytes()).toEqual(["exec bash -lc 'codex app-server'\n"]);
    await rt.runPromise(session.close).catch(() => {});
  });

  it("suppresses the launch line's echo so it never becomes an inbound frame", async () => {
    const rt = makeRuntime();
    const socket = makeFakePtySocket();
    const launchCommand = "bash -lc 'codex app-server'";
    const sessionPromise = rt.runPromise(
      makeDaytonaPtySession(socket, {
        command: launchCommand,
        readyTimeout: "2 seconds",
      }),
    );
    // The PTY echoes the exact launch line back (before `stty -echo` applies); it
    // must be dropped, while a real codex frame after it still flows through.
    socket.pushData(`exec ${launchCommand}\n`);
    const session = await sessionPromise;
    const linesPromise = collect(rt, session.stdoutLines, 1);
    socket.pushData('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    expect(await linesPromise).toEqual(['{"jsonrpc":"2.0","id":1,"result":{}}']);
    await rt.runPromise(session.close).catch(() => {});
  });

  it("fails closed with a DaytonaApiError when the PTY stays silent past the deadline", async () => {
    const rt = makeRuntime();
    const socket = makeFakePtySocket();
    // No frame is ever pushed: the attach is dead. The gate must abort with a
    // DaytonaApiError (so the caller's catchTag falls back to polling) and close
    // the socket rather than hang.
    const error = await rt.runPromise(
      makeDaytonaPtySession(socket, {
        command: "bash -lc 'codex app-server'",
        readyTimeout: "50 millis",
      }).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(DaytonaApiError);
    expect(error.operation).toBe("startPtySession");
    expect(socket.closed()).toBe(true);
  });
});

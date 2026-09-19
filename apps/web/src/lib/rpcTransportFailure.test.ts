// FILE: rpcTransportFailure.test.ts
// Purpose: Verifies transport-failure classification, delivery tagging, and the
//          redacted diagnostic shape that must never leak raw causes.
// Layer: Web transport helper tests

import { RpcClientError } from "effect/unstable/rpc";
import { Socket } from "effect/unstable/socket";
import { describe, expect, it } from "vitest";

import {
  classifyRpcTransportFailure,
  describeTransportFailureForDiagnostics,
  formatTransportFailureMessage,
  isRequestNotSent,
  markRequestNotSent,
  nextTransportFailureRef,
} from "./rpcTransportFailure";

function rpcFailure(reason: unknown): RpcClientError.RpcClientError {
  return new RpcClientError.RpcClientError({ reason: reason as never });
}

describe("classifyRpcTransportFailure", () => {
  it("classifies an open timeout without claiming the cause message", () => {
    const failure = classifyRpcTransportFailure(
      rpcFailure(
        new Socket.SocketOpenError({ kind: "Timeout", cause: new Error("timeout waiting") }),
      ),
    );

    expect(failure).not.toBeNull();
    expect(failure?.reason).toEqual({ tag: "SocketOpenError", kind: "Timeout" });
    expect(failure?.delivery).toBe("unknown");
    expect(failure?.pingTimeout).toBe(false);
    expect(failure?.ref).toMatch(/^sock-[0-9a-f]{4}$/);
  });

  it("flags the library ping timeout as a ping timeout", () => {
    const failure = classifyRpcTransportFailure(
      rpcFailure(new Socket.SocketOpenError({ kind: "Timeout", cause: new Error("ping timeout") })),
    );

    expect(failure?.reason).toEqual({ tag: "SocketOpenError", kind: "Timeout" });
    expect(failure?.pingTimeout).toBe(true);
  });

  it("classifies an unknown open failure, close codes, read and write errors", () => {
    expect(
      classifyRpcTransportFailure(
        rpcFailure(new Socket.SocketOpenError({ kind: "Unknown", cause: new Error("refused") })),
      )?.reason,
    ).toEqual({ tag: "SocketOpenError", kind: "Unknown" });
    expect(
      classifyRpcTransportFailure(
        rpcFailure(new Socket.SocketCloseError({ code: 1006, closeReason: "" })),
      )?.reason,
    ).toEqual({ tag: "SocketCloseError", code: 1006 });
    expect(
      classifyRpcTransportFailure(rpcFailure(new Socket.SocketReadError({ cause: new Error("x") })))
        ?.reason,
    ).toEqual({ tag: "SocketReadError" });
    expect(
      classifyRpcTransportFailure(
        rpcFailure(new Socket.SocketWriteError({ cause: new Error("x") })),
      )?.reason,
    ).toEqual({ tag: "SocketWriteError" });
  });

  it("classifies protocol defects with their stable message", () => {
    const failure = classifyRpcTransportFailure(
      rpcFailure(
        new RpcClientError.RpcClientDefect({
          message: "Error decoding message",
          cause: new Error("bad frame"),
        }),
      ),
    );

    expect(failure?.reason).toEqual({ tag: "RpcClientDefect", message: "Error decoding message" });
    expect(failure?.delivery).toBe("unknown");
  });

  it("only grants not_sent to the tagged pre-flight copy", () => {
    const shared = rpcFailure(
      new Socket.SocketOpenError({ kind: "Timeout", cause: new Error("ping timeout") }),
    );
    const tagged = markRequestNotSent(rpcFailure(shared.reason));

    expect(isRequestNotSent(tagged)).toBe(true);
    expect(isRequestNotSent(shared)).toBe(false);
    expect(classifyRpcTransportFailure(tagged)?.delivery).toBe("not_sent");
    expect(classifyRpcTransportFailure(shared)?.delivery).toBe("unknown");
  });

  it("ignores anything that is not an RpcClientError", () => {
    expect(classifyRpcTransportFailure(new Error("boom"))).toBeNull();
    expect(classifyRpcTransportFailure("boom")).toBeNull();
    expect(classifyRpcTransportFailure(null)).toBeNull();
    expect(classifyRpcTransportFailure({ _tag: "SocketOpenError" })).toBeNull();
  });

  it("uses the caller's episode ref when provided", () => {
    const failure = classifyRpcTransportFailure(
      rpcFailure(new Socket.SocketOpenError({ kind: "Unknown", cause: new Error("x") })),
      "sock-beef",
    );

    expect(failure?.ref).toBe("sock-beef");
  });
});

describe("transport failure messages and diagnostics", () => {
  it("renders a user-facing message that never denies delivery", () => {
    const message = formatTransportFailureMessage("sock-00aa");

    expect(message).toBe("Connection interrupted. Check the operation's status. (ref: sock-00aa)");
    expect(message).not.toMatch(/not sent|SocketOpenError|timeout waiting/i);
  });

  it("keeps diagnostics to the allowed fields only", () => {
    const failure = classifyRpcTransportFailure(
      rpcFailure(new Socket.SocketOpenError({ kind: "Timeout", cause: new Error("ping timeout") })),
      "sock-0007",
    );
    expect(failure).not.toBeNull();
    const diagnostics = describeTransportFailureForDiagnostics(failure!);
    const serialized = JSON.stringify(diagnostics);

    expect(diagnostics).toEqual({
      ref: "sock-0007",
      reason: "SocketOpenError",
      kind: "Timeout",
      pingTimeout: true,
      delivery: "unknown",
    });
    expect(serialized).not.toContain("ping timeout");
    expect(serialized).not.toContain("ws://");
    expect(serialized).not.toContain("stack");
  });
});

describe("nextTransportFailureRef", () => {
  it("produces short stable page-local refs", () => {
    const first = nextTransportFailureRef();
    const second = nextTransportFailureRef();

    expect(first).toMatch(/^sock-[0-9a-f]{4}$/);
    expect(second).toMatch(/^sock-[0-9a-f]{4}$/);
    expect(first).not.toBe(second);
  });
});

import { describe, expect, it } from "vitest";

import { rpcErrorMessage } from "./rpcErrorMessage";

describe("rpcErrorMessage", () => {
  it("reads the message from a real Error instance", () => {
    expect(rpcErrorMessage(new Error("Pull request not found."))).toBe("Pull request not found.");
  });

  it("reads the message from a plain decoded WsRpcError object (no Error prototype)", () => {
    const decoded = { _tag: "WsRpcError", message: "GitHub CLI failed: not a git repository" };
    expect(rpcErrorMessage(decoded)).toBe("GitHub CLI failed: not a git repository");
  });

  it("falls back to a detail field when message is absent", () => {
    expect(rpcErrorMessage({ _tag: "GitHubCliError", detail: "Not authenticated." })).toBe(
      "Not authenticated.",
    );
  });

  it("unwraps a nested cause when the outer wrapper has no message", () => {
    const wrapped = { _tag: "RequestError", cause: { message: "Could not resolve PR." } };
    expect(rpcErrorMessage(wrapped)).toBe("Could not resolve PR.");
  });

  it("returns a trimmed string error verbatim", () => {
    expect(rpcErrorMessage("  boom  ")).toBe("boom");
  });

  it("returns null for empty or message-less errors so callers can show a fallback", () => {
    expect(rpcErrorMessage(null)).toBeNull();
    expect(rpcErrorMessage({})).toBeNull();
    expect(rpcErrorMessage({ message: "   " })).toBeNull();
  });

  it("does not recurse forever on a self-referential cause", () => {
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(rpcErrorMessage(cyclic)).toBeNull();
  });
});

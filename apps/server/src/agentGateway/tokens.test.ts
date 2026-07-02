import { assert, describe, it } from "@effect/vitest";

import { extractBearerToken, signAgentSessionToken, verifyAgentSessionToken } from "./tokens.ts";

const secret = new Uint8Array(32).fill(7);
const otherSecret = new Uint8Array(32).fill(8);

describe("agent gateway tokens", () => {
  it("round-trips a thread id through sign/verify", () => {
    const token = signAgentSessionToken({ secret, threadId: "thread-1" });
    assert.equal(verifyAgentSessionToken({ secret, token }), "thread-1");
  });

  it("supports thread ids with separators and unicode", () => {
    const threadId = "subagent:parent-1:prov/thread.9 ü";
    const token = signAgentSessionToken({ secret, threadId });
    assert.equal(verifyAgentSessionToken({ secret, token }), threadId);
  });

  it("rejects tokens signed with a different secret", () => {
    const token = signAgentSessionToken({ secret, threadId: "thread-1" });
    assert.isNull(verifyAgentSessionToken({ secret: otherSecret, token }));
  });

  it("rejects tampered thread ids", () => {
    const token = signAgentSessionToken({ secret, threadId: "thread-1" });
    const forgedThreadPart = Buffer.from("thread-2", "utf8").toString("base64url");
    const signaturePart = token.slice("sagw_".length).split(".")[1]!;
    const forged = `sagw_${forgedThreadPart}.${signaturePart}`;
    assert.isNull(verifyAgentSessionToken({ secret, token: forged }));
  });

  it("rejects malformed tokens", () => {
    assert.isNull(verifyAgentSessionToken({ secret, token: "" }));
    assert.isNull(verifyAgentSessionToken({ secret, token: "not-a-token" }));
    assert.isNull(verifyAgentSessionToken({ secret, token: "sagw_onlyonepart" }));
    assert.isNull(verifyAgentSessionToken({ secret, token: "sagw_." }));
  });

  it("extracts bearer tokens case-insensitively", () => {
    assert.equal(extractBearerToken("Bearer abc"), "abc");
    assert.equal(extractBearerToken("bearer abc"), "abc");
    assert.isNull(extractBearerToken(undefined));
    assert.isNull(extractBearerToken("Basic abc"));
    assert.isNull(extractBearerToken("Bearer "));
  });
});

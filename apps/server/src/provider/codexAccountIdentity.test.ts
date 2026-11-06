import { describe, expect, it } from "vitest";

import { codexAccountIdentityFromAuthRecord } from "./codexAccountIdentity";

const base64Url = (value: string) => Buffer.from(value).toString("base64url");
const idToken = (payload: unknown) =>
  `${base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64Url(JSON.stringify(payload))}.signature`;

describe("codexAccountIdentityFromAuthRecord", () => {
  it("reads the email and plan from the stored ChatGPT id token", () => {
    const identity = codexAccountIdentityFromAuthRecord({
      tokens: {
        access_token: "access",
        refresh_token: "refresh",
        id_token: idToken({
          email: "work@example.com",
          "https://api.openai.com/auth": {
            chatgpt_plan_type: "plus",
            chatgpt_account_id: "acct_1",
          },
        }),
      },
    });

    expect(identity).toEqual({ email: "work@example.com", planType: "plus" });
  });

  it("keeps the email when the token carries no plan", () => {
    const identity = codexAccountIdentityFromAuthRecord({
      tokens: { access_token: "access", id_token: idToken({ email: "work@example.com" }) },
    });

    expect(identity).toEqual({ email: "work@example.com" });
  });

  it("reports no identity for a token it cannot read", () => {
    expect(
      codexAccountIdentityFromAuthRecord({ tokens: { access_token: "a", id_token: "not-a-jwt" } }),
    ).toEqual({});
    expect(
      codexAccountIdentityFromAuthRecord({
        tokens: { access_token: "a", id_token: "header.!!!not-base64-json!!!.signature" },
      }),
    ).toEqual({});
    expect(
      codexAccountIdentityFromAuthRecord({
        tokens: { access_token: "a", id_token: `header.${base64Url("[1,2]")}.signature` },
      }),
    ).toEqual({});
    expect(
      codexAccountIdentityFromAuthRecord({
        tokens: {
          access_token: "a",
          id_token: idToken({ email: 42, "https://api.openai.com/auth": "plus" }),
        },
      }),
    ).toEqual({});
  });

  it("reports no identity for an API-key-only auth record", () => {
    expect(codexAccountIdentityFromAuthRecord({ OPENAI_API_KEY: "sk-test" })).toEqual({});
  });

  it("reports no identity for an API-key login that still carries old ChatGPT tokens", () => {
    const tokens = {
      access_token: "stale",
      id_token: idToken({
        email: "old@example.com",
        "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
      }),
    };

    expect(
      codexAccountIdentityFromAuthRecord({
        auth_mode: "apikey",
        OPENAI_API_KEY: "sk-test",
        tokens,
      }),
    ).toEqual({});
    expect(codexAccountIdentityFromAuthRecord({ auth_mode: "API-Key", tokens })).toEqual({});
    expect(
      codexAccountIdentityFromAuthRecord({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: "sk-test",
        tokens,
      }),
    ).toEqual({ email: "old@example.com", planType: "plus" });
  });

  it("reports no identity for a missing or malformed record", () => {
    expect(codexAccountIdentityFromAuthRecord(null)).toEqual({});
    expect(codexAccountIdentityFromAuthRecord("tokens")).toEqual({});
    expect(codexAccountIdentityFromAuthRecord({ tokens: "id_token" })).toEqual({});
  });
});

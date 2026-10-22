import { describe, expect, it, vi } from "vitest";
import { NotionOAuthBroker, notionSecretDigest } from "./oauthBroker.ts";
const origin = "https://oauth.example.test";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const botId = "22222222-2222-4222-8222-222222222222";
const verifier = "a".repeat(43);
const post = (path: string, value: unknown, authorization?: string) =>
  new Request(`${origin}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify(value),
  });
async function fixture() {
  let stored: string | null = null;
  let time = Date.parse("2026-10-15T12:00:00Z");
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (String(url).endsWith("/revoke")) return Response.json({});
    const refresh = String(init?.body).includes("refresh_token");
    return Response.json({
      access_token: refresh ? "access-2" : "access-1",
      refresh_token: refresh ? "refresh-2" : "refresh-1",
      workspace_id: workspaceId,
      workspace_name: "Team",
      bot_id: botId,
    });
  });
  const save = vi.fn(async (document: string) => {
    stored = document;
  });
  const broker = new NotionOAuthBroker({
    origin,
    clientId: "client",
    clientSecret: "client-secret",
    load: async () => stored,
    save,
    fetch: fetcher,
    now: () => time,
  });
  await broker.init();
  const start = async () => {
    const created = (await (
      await broker.handle(post("/transactions", { challenge: notionSecretDigest(verifier) }))
    ).json()) as { transactionId: string; authorizationUrl: string };
    const authorization = await broker.handle(new Request(created.authorizationUrl));
    const state = new URL(authorization.headers.get("location")!).searchParams.get("state")!;
    const cookie = authorization.headers.get("set-cookie")!.split(";")[0]!;
    return { ...created, state, cookie };
  };
  return {
    broker,
    save,
    fetcher,
    start,
    advance: () => {
      time += 11 * 60_000;
    },
  };
}
describe("hosted confidential Notion OAuth broker", () => {
  it("binds state to the initiating browser and exchanges code only once", async () => {
    const { broker, start, fetcher } = await fixture();
    const tx = await start();
    const callback = `${origin}/oauth/notion/callback?state=${tx.state}&code=once`;
    expect((await broker.handle(new Request(callback))).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    const response = await broker.handle(new Request(callback, { headers: { Cookie: tx.cookie } }));
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("access-1");
    expect(
      (await broker.handle(new Request(callback, { headers: { Cookie: tx.cookie } }))).status,
    ).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const wrong = await broker.handle(
      post(`/transactions/${tx.transactionId}/redeem`, { verifier: "b".repeat(43) }),
    );
    expect(wrong.status).toBe(403);
    const grant = (await (
      await broker.handle(post(`/transactions/${tx.transactionId}/redeem`, { verifier }))
    ).json()) as { accessToken: string; refreshToken?: string; workspaceId: string };
    expect(grant.accessToken).toBe("access-1");
    expect(grant.refreshToken).toBeUndefined();
    expect(grant.workspaceId).toBe(workspaceId);
  });
  it("refreshes through the confidential client and recovers a lost refresh reply", async () => {
    const { broker, start, fetcher } = await fixture();
    const tx = await start();
    await broker.handle(
      new Request(`${origin}/oauth/notion/callback?state=${tx.state}&code=c`, {
        headers: { Cookie: tx.cookie },
      }),
    );
    const grant = (await (
      await broker.handle(post(`/transactions/${tx.transactionId}/redeem`, { verifier }))
    ).json()) as { brokerSession: string };
    const request = () =>
      post(
        "/sessions/refresh",
        { accessTokenDigest: notionSecretDigest("access-1") },
        `Bearer ${grant.brokerSession}`,
      );
    expect(
      ((await (await broker.handle(request())).json()) as { accessToken: string }).accessToken,
    ).toBe("access-2");
    expect(
      ((await (await broker.handle(request())).json()) as { accessToken: string }).accessToken,
    ).toBe("access-2");
    expect(fetcher).toHaveBeenCalledTimes(2);
    const revoked = await broker.handle(
      post("/sessions/revoke", {}, `Bearer ${grant.brokerSession}`),
    );
    expect(revoked.status).toBe(200);
    expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body))).toEqual({ token: "access-2" });
    expect((await broker.handle(request())).status).toBe(401);
  });
  it("rejects expired transactions, browser JSON calls, and untrusted origins", async () => {
    const { broker, start, advance } = await fixture();
    const tx = await start();
    advance();
    expect(
      (await broker.handle(post(`/transactions/${tx.transactionId}/redeem`, { verifier }))).status,
    ).toBe(410);
    const request = post("/transactions", { challenge: notionSecretDigest(verifier) });
    request.headers.set("Origin", "https://evil.test");
    expect((await broker.handle(request)).status).toBe(403);
    expect((await broker.handle(new Request("https://evil.test/authorize"))).status).toBe(404);
  });
  it("fails closed if credential persistence fails", async () => {
    const { broker, save } = await fixture();
    save.mockRejectedValueOnce(new Error("disk full"));
    expect(
      (await broker.handle(post("/transactions", { challenge: notionSecretDigest(verifier) })))
        .status,
    ).toBe(503);
    expect(
      (await broker.handle(post("/transactions", { challenge: notionSecretDigest(verifier) })))
        .status,
    ).toBe(503);
  });
  it("does not accept malformed persisted documents", async () => {
    const broker = new NotionOAuthBroker({
      origin,
      clientId: "c",
      clientSecret: "s",
      load: async () => '{"version":1,"transactions":[{}],"sessions":[]}',
      save: async () => {},
    });
    await expect(broker.init()).rejects.toThrow("store is invalid");
  });
});

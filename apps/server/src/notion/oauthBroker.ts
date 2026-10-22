/** Hosted confidential OAuth client. Never import this module from the desktop bundle. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Schema } from "effect";
import { NotionId } from "@synara/contracts";
import { notionObject, notionResourceId, notionString } from "@synara/shared/notion";
import { readNotionJson } from "./client.ts";

const TTL = 10 * 60_000;
const MAX_TRANSACTIONS = 1_000;
const MAX_SESSIONS = 10_000;
const secret = () => randomBytes(32).toString("base64url");
export const notionSecretDigest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const digestSchema = Schema.String.check(Schema.isPattern(/^[a-f\d]{64}$/));
const secretSchema = Schema.String.check(Schema.isPattern(/^[A-Za-z\d_-]{43}$/));
const tokenSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096));
const TransactionSchema = Schema.Struct({
  id: NotionId,
  challenge: digestSchema,
  state: secretSchema,
  browserDigest: Schema.NullOr(digestSchema),
  expiresAt: Schema.Number,
  status: Schema.Literals(["pending", "exchanging", "complete", "failed"]),
  sessionId: Schema.NullOr(NotionId),
  sessionSecret: Schema.NullOr(secretSchema),
});
const SessionSchema = Schema.Struct({
  id: NotionId,
  secretDigest: digestSchema,
  accessToken: tokenSchema,
  refreshToken: tokenSchema,
  workspaceId: NotionId,
  workspaceName: Schema.String,
  botId: NotionId,
  needsAuth: Schema.Boolean,
  claimed: Schema.Boolean,
});
const DocumentSchema = Schema.Struct({
  version: Schema.Literal(1),
  transactions: Schema.Array(TransactionSchema).check(Schema.isMaxLength(MAX_TRANSACTIONS)),
  sessions: Schema.Array(SessionSchema).check(Schema.isMaxLength(MAX_SESSIONS)),
});
type Transaction = {
  -readonly [K in keyof typeof TransactionSchema.Type]: (typeof TransactionSchema.Type)[K];
};
type Session = { -readonly [K in keyof typeof SessionSchema.Type]: (typeof SessionSchema.Type)[K] };
export interface NotionBrokerOptions {
  origin: string;
  clientId: string;
  clientSecret: string;
  load: () => Promise<string | null>;
  save: (document: string) => Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
}
class BrokerFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
function matchesDigest(value: string, expected: string): boolean {
  const actual = Buffer.from(notionSecretDigest(value), "hex");
  const target = Buffer.from(expected, "hex");
  return actual.length === target.length && timingSafeEqual(actual, target);
}
function originOnly(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("The Notion broker requires an HTTPS origin without a path or credentials.");
  return url.origin;
}
const noStore = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
};
function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: noStore });
}
function message(text: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(text, {
    status,
    headers: { ...noStore, "Content-Type": "text/plain; charset=utf-8", ...headers },
  });
}
async function body(request: Request): Promise<Record<string, unknown>> {
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json"))
    throw new BrokerFailure(415, "json_required");
  try {
    return await readNotionJson(new Response(request.body, { headers: request.headers }), 8_192);
  } catch {
    throw new BrokerFailure(400, "invalid_request");
  }
}

/** One process owns this store. Multi-replica deployments require a transactional adapter. */
export class NotionOAuthBroker {
  readonly origin: string;
  private readonly transactions = new Map<string, Transaction>();
  private readonly sessions = new Map<string, Session>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private persistence: Promise<void> = Promise.resolve();
  private storageFailed = false;
  private initialized = false;
  private readonly now: () => number;
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: NotionBrokerOptions) {
    this.origin = originOnly(options.origin);
    if (!options.clientId || !options.clientSecret)
      throw new Error("The hosted Notion OAuth client is not configured.");
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetch ?? fetch;
  }
  async init(): Promise<void> {
    if (this.initialized) throw new Error("Notion broker already initialized.");
    const raw = await this.options.load();
    if (raw !== null) {
      if (Buffer.byteLength(raw) > 16 * 1024 * 1024)
        throw new Error("Notion broker store exceeds its size limit.");
      let parsed: typeof DocumentSchema.Type;
      try {
        parsed = Schema.decodeUnknownSync(DocumentSchema)(JSON.parse(raw));
      } catch {
        throw new Error(
          "Notion broker store is invalid. Preserve it and restore a valid encrypted backup.",
        );
      }
      for (const item of parsed.sessions) {
        if (this.sessions.has(item.id))
          throw new Error("Duplicate session in Notion broker store.");
        this.sessions.set(item.id, { ...item });
      }
      for (const item of parsed.transactions) {
        if (
          this.transactions.has(item.id) ||
          !Number.isFinite(item.expiresAt) ||
          (item.sessionId !== null && !this.sessions.has(item.sessionId))
        )
          throw new Error("Invalid transaction in Notion broker store.");
        // An interrupted code exchange is never replayed after a crash.
        this.transactions.set(item.id, {
          ...item,
          status: item.status === "exchanging" ? "failed" : item.status,
        });
      }
    }
    this.initialized = true;
  }
  private ready(): void {
    if (!this.initialized || this.storageFailed)
      throw new BrokerFailure(503, "credential_storage_unavailable");
  }
  private async persist(): Promise<void> {
    this.ready();
    const document = JSON.stringify({
      version: 1,
      transactions: [...this.transactions.values()],
      sessions: [...this.sessions.values()],
    });
    if (Buffer.byteLength(document) > 16 * 1024 * 1024) {
      this.storageFailed = true;
      throw new BrokerFailure(503, "credential_storage_full");
    }
    const operation = this.persistence.then(async () => {
      this.ready();
      await this.options.save(document);
    });
    this.persistence = operation.catch(() => {
      this.storageFailed = true;
    });
    try {
      await operation;
    } catch {
      throw new BrokerFailure(503, "credential_storage_unavailable");
    }
  }
  private async exclusive<T>(key: string, run: () => Promise<T>): Promise<T> {
    if (this.locks.size > 128 && !this.locks.has(key)) throw new BrokerFailure(429, "broker_busy");
    const previous = this.locks.get(key) ?? Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(() => {
        this.ready();
        return run();
      });
    this.locks.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.locks.get(key) === operation) this.locks.delete(key);
    }
  }
  private transaction(id: string): Transaction {
    const value = this.transactions.get(id);
    if (!value || value.expiresAt <= this.now())
      throw new BrokerFailure(410, "authorization_expired");
    return value;
  }
  private async notion(
    path: "token" | "revoke",
    value: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetcher(`https://api.notion.com/v1/oauth/${path}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString("base64")}`,
        },
        body: JSON.stringify(value),
      });
    } catch {
      throw new BrokerFailure(502, "notion_delivery_uncertain");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new BrokerFailure(
        response.status === 400 || response.status === 401 ? 401 : 502,
        "notion_authorization_failed",
      );
    }
    try {
      return await readNotionJson(response, 65_536);
    } catch {
      throw new BrokerFailure(502, "notion_delivery_uncertain");
    }
  }
  private tokenPair(result: Record<string, unknown>): {
    accessToken: string;
    refreshToken: string;
  } {
    const accessToken = notionString(result.access_token);
    const refreshToken = notionString(result.refresh_token);
    if (!accessToken || accessToken.length > 4_096 || !refreshToken || refreshToken.length > 4_096)
      throw new BrokerFailure(502, "notion_token_response_invalid");
    return { accessToken, refreshToken };
  }
  private grant(session: Session, sessionSecret: string): Record<string, unknown> {
    this.ready();
    return {
      accessToken: session.accessToken,
      brokerSession: `${session.id}.${sessionSecret}`,
      workspaceId: session.workspaceId,
      workspaceName: session.workspaceName,
      botId: session.botId,
    };
  }
  private session(request: Request): { session: Session; sessionSecret: string } {
    const authorization = request.headers.get("authorization") ?? "";
    const match = /^Bearer ([a-f\d-]{36})\.([A-Za-z\d_-]{43})$/i.exec(authorization);
    const session = match ? this.sessions.get(match[1]!) : undefined;
    if (!match || !session || !session.claimed || !matchesDigest(match[2]!, session.secretDigest))
      throw new BrokerFailure(401, "invalid_broker_session");
    return { session, sessionSecret: match[2]! };
  }
  async handle(request: Request): Promise<Response> {
    try {
      this.ready();
      const url = new URL(request.url);
      if (url.origin !== this.origin) return message("Not found", 404);
      // Only the trusted Synara backend talks to JSON endpoints, never a web origin.
      if (request.method === "POST" && request.headers.has("origin"))
        return json({ error: "browser_request_not_allowed" }, 403);
      if (request.method === "POST" && url.pathname === "/transactions") {
        const input = await body(request);
        const challenge = notionString(input.challenge);
        if (!/^[a-f\d]{64}$/.test(challenge)) throw new BrokerFailure(400, "invalid_challenge");
        return await this.exclusive("create", async () => {
          if (this.transactions.size >= MAX_TRANSACTIONS || this.sessions.size >= MAX_SESSIONS)
            throw new BrokerFailure(429, "broker_capacity_reached");
          const transaction: Transaction = {
            id: randomUUID(),
            challenge,
            state: secret(),
            browserDigest: null,
            expiresAt: this.now() + TTL,
            status: "pending",
            sessionId: null,
            sessionSecret: null,
          };
          this.transactions.set(transaction.id, transaction);
          await this.persist();
          return json({
            transactionId: transaction.id,
            authorizationUrl: `${this.origin}/authorize?transaction_id=${transaction.id}`,
            expiresAt: new Date(transaction.expiresAt).toISOString(),
          });
        });
      }
      if (request.method === "GET" && url.pathname === "/authorize") {
        const id = url.searchParams.get("transaction_id") ?? "";
        return await this.exclusive(`transaction:${id}`, async () => {
          const transaction = this.transaction(id);
          if (transaction.status !== "pending")
            throw new BrokerFailure(409, "authorization_already_used");
          const browser = secret();
          transaction.browserDigest = notionSecretDigest(browser);
          transaction.state = secret();
          await this.persist();
          const authorize = new URL("https://api.notion.com/v1/oauth/authorize");
          authorize.search = new URLSearchParams({
            owner: "user",
            client_id: this.options.clientId,
            response_type: "code",
            redirect_uri: `${this.origin}/oauth/notion/callback`,
            state: transaction.state,
          }).toString();
          return message("Continue to Notion", 302, {
            Location: authorize.href,
            "Set-Cookie": `__Host-synara-notion-${id}=${browser}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
          });
        });
      }
      if (request.method === "GET" && url.pathname === "/oauth/notion/callback") {
        const state = url.searchParams.get("state") ?? "";
        const found = [...this.transactions.values()].find((item) => item.state === state);
        if (!found) throw new BrokerFailure(400, "invalid_oauth_state");
        return await this.exclusive(`transaction:${found.id}`, async () => {
          const transaction = this.transaction(found.id);
          const cookieName = `__Host-synara-notion-${transaction.id}`;
          const cookie =
            (request.headers.get("cookie") ?? "")
              .split(";")
              .map((value) => value.trim())
              .find((value) => value.startsWith(`${cookieName}=`))
              ?.slice(cookieName.length + 1) ?? "";
          if (
            transaction.state !== state ||
            transaction.status !== "pending" ||
            !transaction.browserDigest ||
            !matchesDigest(cookie, transaction.browserDigest)
          )
            throw new BrokerFailure(400, "invalid_oauth_state");
          const cleared = {
            "Set-Cookie": `${cookieName}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
          };
          if (url.searchParams.has("error")) {
            transaction.status = "failed";
            await this.persist();
            return message(
              "Notion authorization was cancelled. Return to Synara to reconnect.",
              400,
              cleared,
            );
          }
          const code = url.searchParams.get("code");
          if (!code || code.length > 4_096)
            throw new BrokerFailure(400, "authorization_code_missing");
          transaction.status = "exchanging";
          await this.persist();
          try {
            const result = await this.notion("token", {
              grant_type: "authorization_code",
              code,
              redirect_uri: `${this.origin}/oauth/notion/callback`,
            });
            const pair = this.tokenPair(result);
            const sessionSecret = secret();
            const session: Session = {
              id: randomUUID(),
              secretDigest: notionSecretDigest(sessionSecret),
              ...pair,
              workspaceId: notionResourceId(notionString(result.workspace_id)),
              workspaceName: notionString(result.workspace_name).slice(0, 500),
              botId: notionResourceId(notionString(result.bot_id)),
              needsAuth: false,
              claimed: false,
            };
            this.sessions.set(session.id, session);
            transaction.sessionId = session.id;
            transaction.sessionSecret = sessionSecret;
            transaction.status = "complete";
            await this.persist();
            return message(
              "Notion is authorized. Return to Synara to finish connecting. You can close this browser tab.",
              200,
              cleared,
            );
          } catch {
            transaction.status = "failed";
            if (!this.storageFailed) await this.persist();
            return message(
              "Notion sign-in could not be completed. Return to Synara and reconnect. No authorization code will be replayed.",
              502,
              cleared,
            );
          }
        });
      }
      const redeem = /^\/transactions\/([a-f\d-]{36})\/redeem$/i.exec(url.pathname);
      if (request.method === "POST" && redeem) {
        const input = await body(request);
        const verifier = notionString(input.verifier);
        return await this.exclusive(`transaction:${redeem[1]!}`, async () => {
          const transaction = this.transaction(redeem[1]!);
          if (
            !/^[A-Za-z\d_-]{43}$/.test(verifier) ||
            !matchesDigest(verifier, transaction.challenge)
          )
            throw new BrokerFailure(403, "invalid_verifier");
          if (transaction.status === "failed") throw new BrokerFailure(401, "authorization_failed");
          if (transaction.status !== "complete") return json({ pending: true });
          const session = transaction.sessionId
            ? this.sessions.get(transaction.sessionId)
            : undefined;
          if (!session || !transaction.sessionSecret || session.needsAuth)
            throw new BrokerFailure(401, "authorization_failed");
          // Idempotent redemption with the same proof recovers a lost successful reply.
          session.claimed = true;
          await this.persist();
          return json({ pending: false, ...this.grant(session, transaction.sessionSecret) });
        });
      }
      if (
        request.method === "POST" &&
        ["/sessions/refresh", "/sessions/revoke"].includes(url.pathname)
      ) {
        const { session, sessionSecret } = this.session(request);
        const input = await body(request);
        return await this.exclusive(`session:${session.id}`, async () => {
          if (this.sessions.get(session.id) !== session)
            throw new BrokerFailure(401, "invalid_broker_session");
          if (url.pathname.endsWith("/revoke")) {
            await this.notion("revoke", { token: session.accessToken });
            this.sessions.delete(session.id);
            for (const transaction of this.transactions.values())
              if (transaction.sessionId === session.id) this.transactions.delete(transaction.id);
            await this.persist();
            return json({ revoked: true });
          }
          if (session.needsAuth) throw new BrokerFailure(401, "reconnect_required");
          const expected = notionString(input.accessTokenDigest);
          if (!/^[a-f\d]{64}$/.test(expected))
            throw new BrokerFailure(400, "token_digest_required");
          // A refresh already completed but its response was lost: return the durable pair.
          if (!matchesDigest(session.accessToken, expected))
            return json(this.grant(session, sessionSecret));
          session.needsAuth = true;
          await this.persist();
          const result = await this.notion("token", {
            grant_type: "refresh_token",
            refresh_token: session.refreshToken,
          });
          Object.assign(session, this.tokenPair(result), { needsAuth: false });
          await this.persist();
          return json(this.grant(session, sessionSecret));
        });
      }
      return message("Not found", 404);
    } catch (error) {
      return json(
        { error: error instanceof BrokerFailure ? error.code : "broker_request_failed" },
        error instanceof BrokerFailure ? error.status : 500,
      );
    }
  }
  /** Bounded maintenance, scheduled by the hosted entrypoint. No local webhook port is opened. */
  async expireUnclaimed(): Promise<void> {
    this.ready();
    const expired = [...this.transactions.values()]
      .filter((value) => value.expiresAt <= this.now())
      .slice(0, 10);
    for (const candidate of expired)
      await this.exclusive(`transaction:${candidate.id}`, async () => {
        const transaction = this.transactions.get(candidate.id);
        if (!transaction || transaction.expiresAt > this.now()) return;
        const session = transaction.sessionId
          ? this.sessions.get(transaction.sessionId)
          : undefined;
        if (session && !session.claimed) {
          const sharedToken = [...this.sessions.values()].some(
            (other) =>
              other !== session && other.claimed && other.accessToken === session.accessToken,
          );
          if (!sharedToken) await this.notion("revoke", { token: session.accessToken });
          this.sessions.delete(session.id);
        }
        this.transactions.delete(transaction.id);
        await this.persist();
      });
  }
  async close(): Promise<void> {
    await Promise.allSettled([...this.locks.values()]);
    await this.persistence;
  }
}

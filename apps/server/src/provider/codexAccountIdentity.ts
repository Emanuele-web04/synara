// FILE: codexAccountIdentity.ts
// Purpose: Read who a Codex account is from the CLI's own auth record. The
//   email and plan come from the unverified ChatGPT id token, so they label the
//   account and never decide authorization.
// Layer: Provider utility (no IO, no Effect dependencies)

import { decodeJwtClaims } from "../jwtClaims";
import { asRecord, asString } from "../providerUsage/parse";

export interface CodexAccountIdentity {
  /** Email of the ChatGPT account, when the id token carries one. */
  readonly email?: string;
  /** Raw ChatGPT plan type (`plus`, `pro`, `team`, …), when the id token carries one. */
  readonly planType?: string;
}

const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

/** An API-key login, even when the record still holds tokens from an older ChatGPT login. */
export function isCodexApiKeyAuthRecord(auth: Record<string, unknown>): boolean {
  const mode = asString(auth.auth_mode ?? auth.authMode)?.toLowerCase();
  const apiKey = asString(auth.OPENAI_API_KEY ?? auth.openai_api_key ?? auth.apiKey);
  const hasTokenRecord = asRecord(auth.tokens) !== null && !Array.isArray(auth.tokens);
  return mode === "apikey" || mode === "api-key" || (apiKey !== undefined && !hasTokenRecord);
}

export function codexAccountIdentityFromAuthRecord(record: unknown): CodexAccountIdentity {
  const auth = asRecord(record);
  if (!auth || isCodexApiKeyAuthRecord(auth)) return {};
  const tokens = asRecord(auth.tokens);
  const payload = decodeJwtClaims(asString(tokens?.id_token ?? tokens?.idToken));
  if (!payload) return {};
  const email = asString(payload.email);
  const planType = asString(asRecord(payload[OPENAI_AUTH_CLAIM])?.chatgpt_plan_type);
  return { ...(email ? { email } : {}), ...(planType ? { planType } : {}) };
}

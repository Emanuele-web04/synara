// FILE: codexAccountIdentity.ts
// Purpose: Pure reading of who a Codex account is, from the CLI's own auth
//   record. `codex login status` prints no identity, so the signed-in email
//   and plan come from the ChatGPT id token the CLI stores beside the access
//   token. Nothing here verifies the token: it is a label for the account,
//   never an authorization decision.
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

export function codexAccountIdentityFromAuthRecord(record: unknown): CodexAccountIdentity {
  const auth = asRecord(record);
  const tokens = asRecord(auth?.tokens);
  const rawMode = asString(auth?.auth_mode ?? auth?.authMode)?.toLowerCase();
  const apiKey = asString(auth?.OPENAI_API_KEY ?? auth?.openai_api_key ?? auth?.apiKey);
  if (rawMode === "apikey" || rawMode === "api-key" || (apiKey && !tokens)) return {};
  const payload = decodeJwtClaims(asString(tokens?.id_token));
  if (!payload) return {};
  const email = asString(payload.email);
  const planType = asString(asRecord(payload[OPENAI_AUTH_CLAIM])?.chatgpt_plan_type);
  return { ...(email ? { email } : {}), ...(planType ? { planType } : {}) };
}

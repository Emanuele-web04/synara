// FILE: codexAccountIdentity.ts
// Purpose: Pure reading of who a Codex account is, from the CLI's own auth
//   record. `codex login status` prints no identity, so the signed-in email
//   and plan come from the ChatGPT id token the CLI stores beside the access
//   token. Nothing here verifies the token: it is a label for the account,
//   never an authorization decision.
// Layer: Provider utility (no IO, no Effect dependencies)

export interface CodexAccountIdentity {
  /** Email of the ChatGPT account, when the id token carries one. */
  readonly email?: string;
  /** Raw ChatGPT plan type (`plus`, `pro`, `team`, …), when the id token carries one. */
  readonly planType?: string;
}

export function codexAccountIdentityFromAuthRecord(record: unknown): CodexAccountIdentity {
  void record;
  throw new Error("Not implemented");
}

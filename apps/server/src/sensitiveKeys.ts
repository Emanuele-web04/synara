import { isProviderCredentialKey } from "./providerChildEnvironment.ts";

const EXACT_SENSITIVE_KEYS: Record<string, true> = {
  accesskey: true,
  accesskeyid: true,
  apikey: true,
  authtoken: true,
  authorization: true,
  clientsecret: true,
  cookie: true,
  cookies: true,
  credential: true,
  credentials: true,
  idtoken: true,
  passphrase: true,
  passwd: true,
  password: true,
  privatekey: true,
  proxyauthorization: true,
  pwd: true,
  refreshtoken: true,
  secret: true,
  secretkey: true,
  sessiontoken: true,
  setcookie: true,
  token: true,
};
const SECRET_TERMINAL_WORDS: Record<string, true> = {
  authorization: true,
  cookie: true,
  cookies: true,
  credential: true,
  credentials: true,
  passphrase: true,
  passwd: true,
  password: true,
  pwd: true,
  secret: true,
  secrets: true,
};
const TOKEN_TERMINAL_WORDS: Record<string, true> = {
  token: true,
  tokens: true,
};
const SECRET_TOKEN_QUALIFIERS: Record<string, true> = {
  access: true,
  api: true,
  auth: true,
  bearer: true,
  bot: true,
  client: true,
  gateway: true,
  id: true,
  jwt: true,
  machine: true,
  oauth: true,
  personal: true,
  refresh: true,
  secret: true,
  service: true,
  session: true,
  sso: true,
  user: true,
  webhook: true,
};

function keyTokens(key: string): string[] {
  return (
    key
      .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
      .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
      .toLowerCase()
      .match(/[a-z0-9]+/gu) ?? []
  );
}

/** True when a JSON object key names a credential rather than benign metadata. */
export function isSensitiveKey(key: string): boolean {
  if (isProviderCredentialKey(key)) {
    return true;
  }
  const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
  if (EXACT_SENSITIVE_KEYS[normalized]) {
    return true;
  }
  const tokens = keyTokens(key);
  const terminal = tokens.at(-1);
  if (terminal === undefined) {
    return false;
  }
  if (SECRET_TERMINAL_WORDS[terminal]) {
    return true;
  }
  if (TOKEN_TERMINAL_WORDS[terminal]) {
    // `prompt_tokens`, `total_tokens`, `completion_tokens` are usage counters, not secrets.
    const qualifier = tokens.at(-2);
    return qualifier === undefined || SECRET_TOKEN_QUALIFIERS[qualifier] === true;
  }
  return (
    terminal === "key" &&
    tokens.slice(0, -1).some((token) => ["api", "private", "proxy", "secret"].includes(token))
  );
}

export const REDACTED_SENSITIVE_VALUE = "[redacted]";

/** `JSON.stringify` replacer that hides the value of every credential-named field. */
export function redactSensitiveJsonFields(key: string, value: unknown): unknown {
  return isSensitiveKey(key) ? REDACTED_SENSITIVE_VALUE : value;
}

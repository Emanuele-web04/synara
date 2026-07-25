// FILE: oauthLogin.ts
// Purpose: Provider OAuth login runners for managed account connects.
//          Each runner drives the provider's official login command inside an
//          isolated profile home and reports verification info and completion.
// Layer: Server service internals
// Exports: OAuthLoginRunner types, codexOauthLoginRunner, defaultOauthLoginRunners.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { SupportedAccountProvider } from "@synara/contracts";
import {
  SYNARA_LAUNCHER_BYPASS,
  SYNARA_LAUNCHER_BYPASS_VALUE,
} from "@synara/shared/providerAccounts/launcherProtocol";

export interface OAuthVerificationInfo {
  readonly verificationUrl?: string;
  readonly userCode?: string;
}

export type OAuthLoginOutcome =
  | { readonly ok: true; readonly identityHint?: string }
  | { readonly ok: false; readonly error: string };

export interface OAuthLoginRequest {
  readonly provider: SupportedAccountProvider;
  /** Isolated profile home the provider login must write credentials into. */
  readonly profileHome: string;
  readonly onVerification: (info: OAuthVerificationInfo) => void;
}

export interface OAuthLoginHandle {
  readonly done: Promise<OAuthLoginOutcome>;
  cancel(): void;
}

export type OAuthLoginRunner = (request: OAuthLoginRequest) => OAuthLoginHandle;

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const URL_PATTERN = /https:\/\/[^\s"'<>)\]]+/;

// Environment variables that could redirect the login away from the isolated
// profile home or reuse the native identity.
const CODEX_LOGIN_CONFLICTS = ["CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL"];

function readCodexIdentityHint(profileHome: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(profileHome, "auth.json"), "utf8");
    const parsed = JSON.parse(raw) as { tokens?: { id_token?: string } };
    const idToken = parsed.tokens?.id_token;
    if (typeof idToken !== "string") return undefined;
    const payload = idToken.split(".")[1];
    if (payload === undefined) return undefined;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      email?: string;
    };
    const email = claims.email;
    if (typeof email !== "string" || !email.includes("@")) return undefined;
    const [local = "", domain = ""] = email.split("@");
    return `${local.slice(0, 1)}\u2022\u2022\u2022\u2022@${domain}`;
  } catch {
    return undefined;
  }
}

/**
 * Runs the official `codex login` flow with CODEX_HOME pinned to the isolated
 * profile home. Verification URLs printed by the CLI are surfaced to the
 * caller; success requires both a zero exit code and a written auth.json.
 */
export const codexOauthLoginRunner: OAuthLoginRunner = (request) => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of CODEX_LOGIN_CONFLICTS) delete env[name];
  env.CODEX_HOME = request.profileHome;
  env[SYNARA_LAUNCHER_BYPASS] = SYNARA_LAUNCHER_BYPASS_VALUE;

  let cancelled = false;
  const child = spawn("codex", ["login"], { env, stdio: ["ignore", "pipe", "pipe"] });

  let reportedUrl = false;
  const inspectOutput = (chunk: Buffer) => {
    if (reportedUrl) return;
    const match = URL_PATTERN.exec(chunk.toString("utf8"));
    if (match !== null) {
      reportedUrl = true;
      request.onVerification({ verificationUrl: match[0] });
    }
  };
  child.stdout.on("data", inspectOutput);
  child.stderr.on("data", inspectOutput);

  const done = new Promise<OAuthLoginOutcome>((resolve) => {
    const timeout = setTimeout(() => {
      cancelled = true;
      child.kill("SIGTERM");
      resolve({ ok: false, error: "Codex login timed out after 10 minutes." });
    }, LOGIN_TIMEOUT_MS);
    timeout.unref();

    child.on("error", (cause) => {
      clearTimeout(timeout);
      resolve({
        ok: false,
        error: `Could not start 'codex login': ${cause.message}. Is the Codex CLI installed?`,
      });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      if (cancelled) {
        resolve({ ok: false, error: "Codex login was cancelled." });
        return;
      }
      if (code !== 0) {
        resolve({
          ok: false,
          error: `'codex login' exited with ${signal !== null ? `signal ${signal}` : `code ${code}`}.`,
        });
        return;
      }
      if (!fs.existsSync(path.join(request.profileHome, "auth.json"))) {
        resolve({
          ok: false,
          error: "Codex login finished but no credentials were written to the managed profile.",
        });
        return;
      }
      const identityHint = readCodexIdentityHint(request.profileHome);
      resolve({ ok: true, ...(identityHint !== undefined ? { identityHint } : {}) });
    });
  });

  return {
    done,
    cancel() {
      cancelled = true;
      child.kill("SIGTERM");
    },
  };
};

// Codex is the only provider with a verified managed OAuth login workflow.
// Other providers stay API-key-only until their flows are proven end to end
// (see the capability matrix in @synara/shared/providerAccounts/capabilities).
export const defaultOauthLoginRunners: Partial<Record<SupportedAccountProvider, OAuthLoginRunner>> =
  {
    codex: codexOauthLoginRunner,
  };

import { CODEX_CONFLICTING_ENV_VARS } from "@synara/shared/providerAccounts/codexAccountEnvironment";
import { spawnProcess } from "@synara/shared/processRuntime";
import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { teardownChildProcessTree } from "../platform/supervisedProcessTeardown";
import {
  buildProviderChildEnvironment,
  withoutProviderCredentialEnvironment,
} from "../providerChildEnvironment";
import * as fs from "node:fs/promises";
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
  | { readonly ok: false; readonly error: string; readonly processExitUnproven?: true };

export interface OAuthLoginRequest {
  readonly provider: SupportedAccountProvider;
  /** Isolated profile home the provider login must write credentials into. */
  readonly profileHome: string;
  readonly onVerification: (info: OAuthVerificationInfo) => void;
}

export interface OAuthLoginHandle {
  readonly done: Promise<OAuthLoginOutcome>;
  /** Resolves only after the owned login process tree has exited; rejects when exit is unproven. */
  cancel(): void | Promise<void>;
}

export type OAuthLoginRunner = (request: OAuthLoginRequest) => OAuthLoginHandle;

// Shared with startup recovery: pending login directories younger than this
// may belong to a still-running login and must not be reclaimed.
export const OAUTH_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const URL_PATTERN = /https:\/\/[^\s"'<>)\]]+/g;

// Hosts a provider's login flow is allowed to send the user to. Output from
// the provider CLI is untrusted; URLs on other hosts are never surfaced as
// verification links.
const CODEX_AUTH_HOSTS = ["auth.openai.com", "openai.com"];

function hostMatches(hostname: string, expected: string): boolean {
  return hostname === expected || hostname.endsWith(`.${expected}`);
}

/**
 * Returns the first https URL in `text` whose hostname is one of
 * `expectedAuthHosts` (or a subdomain of one), or undefined when none match.
 */
export function findVerificationUrl(
  text: string,
  expectedAuthHosts: ReadonlyArray<string>,
): string | undefined {
  for (const match of text.matchAll(URL_PATTERN)) {
    try {
      const { hostname } = new URL(match[0]);
      if (expectedAuthHosts.some((expected) => hostMatches(hostname, expected))) {
        return match[0];
      }
    } catch {
      // Not a parseable URL; keep scanning.
    }
  }
  return undefined;
}

// Environment variables that could redirect the login away from the isolated
// profile home or reuse the native identity.

async function readCodexIdentityHint(profileHome: string): Promise<string | undefined> {
  try {
    const file = path.join(profileHome, "auth.json");
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 1_048_576) return undefined;
    const raw = await fs.readFile(file, "utf8");
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
  const env = buildProviderChildEnvironment({
    provider: "codex",
    baseEnv: withoutProviderCredentialEnvironment(process.env),
  });
  for (const name of CODEX_CONFLICTING_ENV_VARS) delete env[name];
  env.CODEX_HOME = request.profileHome;
  env[SYNARA_LAUNCHER_BYPASS] = SYNARA_LAUNCHER_BYPASS_VALUE;

  let cancelled = false;
  let child: ChildProcess;
  try {
    child = spawnProcess("codex", ["login", "--config", 'cli_auth_credentials_store="file"'], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return {
      done: Promise.resolve({
        ok: false,
        error: "Could not start 'codex login'. Is the Codex CLI installed?",
      }),
      cancel() {},
    };
  }

  let reportedUrl = false;
  const inspectOutputStream = (stream: NodeJS.ReadableStream | null | undefined) => {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    const inspect = (text: string, final = false) => {
      if (reportedUrl) return;
      pending += text;
      // Only parse complete tokens: a valid hostname may still be the prefix of
      // an untrusted host or an incomplete query string in the next chunk.
      const boundary = final ? pending.length : pending.search(/[^\s]*$/);
      const complete = pending.slice(0, boundary);
      pending = pending.slice(boundary).slice(-16_384);
      const url = findVerificationUrl(complete, CODEX_AUTH_HOSTS);
      if (url !== undefined) {
        reportedUrl = true;
        request.onVerification({ verificationUrl: url });
      }
    };
    stream?.on("data", (chunk: Buffer) => inspect(decoder.write(chunk)));
    stream?.on("end", () => inspect(decoder.end(), true));
  };
  inspectOutputStream(child.stdout);
  inspectOutputStream(child.stderr);

  let resolveDone!: (outcome: OAuthLoginOutcome) => void;
  const done = new Promise<OAuthLoginOutcome>((resolve) => {
    resolveDone = resolve;
  });
  let stopPromise: Promise<void> | undefined;
  const stop = (error: string): Promise<void> => {
    if (stopPromise !== undefined) return stopPromise;
    cancelled = true;
    clearTimeout(timeout);
    stopPromise = teardownChildProcessTree(child)
      .then((result) => {
        if (result.capturedBeforeRootExit === false) {
          throw new Error("The login root exited before its descendants could be captured.");
        }
        resolveDone({ ok: false, error });
      })
      .catch((cause: unknown) => {
        resolveDone({
          ok: false,
          error: `${error} Process exit could not be verified; the staged profile was retained.`,
          processExitUnproven: true,
        });
        throw cause;
      });
    return stopPromise;
  };
  const timeout = setTimeout(() => {
    void stop("Codex login timed out after 10 minutes.").catch(() => undefined);
  }, OAUTH_LOGIN_TIMEOUT_MS);
  timeout.unref();

  child.on("error", (cause) => {
    clearTimeout(timeout);
    if (cancelled) return;
    resolveDone({
      ok: false,
      error: `Could not start 'codex login': ${cause.message}. Is the Codex CLI installed?`,
    });
  });
  child.on("exit", async (code, signal) => {
    clearTimeout(timeout);
    // The stop promise owns completion, including descendant exit proof.
    if (cancelled) return;
    if (code !== 0) {
      resolveDone({
        ok: false,
        error: `'codex login' exited with ${signal !== null ? `signal ${signal}` : `code ${code}`}.`,
      });
      return;
    }
    try {
      await fs.access(path.join(request.profileHome, "auth.json"));
    } catch {
      if (!cancelled) {
        resolveDone({
          ok: false,
          error: "Codex login finished but no credentials were written to the managed profile.",
        });
      }
      return;
    }
    const identityHint = await readCodexIdentityHint(request.profileHome);
    if (cancelled) return;
    resolveDone({ ok: true, ...(identityHint !== undefined ? { identityHint } : {}) });
  });

  return {
    done,
    cancel: () => stop("Codex login was cancelled."),
  };
};

// Codex is the only provider with a verified managed OAuth login workflow.
// Other providers stay API-key-only until their flows are proven end to end
// (see the capability matrix in @synara/shared/providerAccounts/capabilities).
export const defaultOauthLoginRunners: Partial<Record<SupportedAccountProvider, OAuthLoginRunner>> =
  {
    codex: codexOauthLoginRunner,
  };

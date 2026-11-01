// Keep Apple submission state beside the exact payload, never in shared caches.
import { spawn, spawnSync } from "node:child_process";
import { hashFile } from "./file-digest.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { startBuildStage, timeBuildStage } from "./build-timing.ts";
import type { MacDmgNotaryCredentials } from "./mac-dmg-finalize.ts";

export interface NotarySubmission {
  payloadSha256: string;
  id: string;
  stapledSha256?: string;
}
export const payloadDigest = hashFile;
export function appNotaryStateDirectory(app: string): string {
  // Bundle discovery treats a directory ending in .app as executable content.
  // Retained submission state must never masquerade as another app bundle.
  return join(dirname(app), `.app-notary-${basename(app)}-state`);
}
export function reusableSubmission(state: NotarySubmission, digest: string): boolean {
  return (
    /^[0-9a-f-]{36}$/i.test(state.id) &&
    (state.payloadSha256 === digest || state.stapledSha256 === digest)
  );
}

function credentialsArgs(credentials: MacDmgNotaryCredentials): string[] {
  const entries = [
    ["--key", credentials.appleApiKey],
    ["--key-id", credentials.appleApiKeyId],
    ["--issuer", credentials.appleApiIssuer],
  ] as const;
  return entries.flatMap(([flag, value]) => {
    if (!value?.trim()) throw new Error(`Apple notarization requires ${flag}.`);
    return [flag, value.trim()];
  });
}

export function runMacCommand(command: string, args: readonly string[], stage: string): void {
  timeBuildStage(stage, () => {
    const isStapler =
      command === "xcrun" &&
      args[0] === "stapler" &&
      (args[1] === "staple" || args[1] === "validate");
    const retryDelaysMs = [5_000, 15_000, 30_000];
    for (let attempt = 0; ; attempt += 1) {
      // Capture only credential-free ticket commands so retries require the
      // observed transport failure, not exit 68 or a validation failure alone.
      const result = spawnSync(
        command,
        [...args],
        isStapler
          ? { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["inherit", "pipe", "pipe"] }
          : { stdio: "inherit" },
      );
      if (isStapler) {
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
      }
      if (result.error) throw result.error;
      if (result.status === 0) return;
      const delayMs = retryDelaysMs[attempt];
      if (
        !isStapler ||
        result.signal ||
        result.status !== 68 ||
        !/NSURLErrorDomain\s+Code=-1005\b/.test(`${result.stdout ?? ""}\n${result.stderr ?? ""}`) ||
        delayMs === undefined
      ) {
        throw new Error(`${stage} failed with exit code ${result.status ?? "unknown"}.`);
      }
      console.warn(
        `[notarization] ${stage}: ticket connection lost; retry ${attempt + 1}/3 in ${delayMs / 1000}s.`,
      );
      // This build-only command runner is synchronous. Wait without starting a
      // second subprocess or resubmitting/rebuilding the signed payload.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  });
}

export async function notarizeMacPayload(
  payload: string,
  credentials: MacDmgNotaryCredentials,
  stateDir: string,
  label: string,
): Promise<{ statePath: string; state: NotarySubmission }> {
  const auth = credentialsArgs(credentials);
  const json = (args: string[], stage: string): Record<string, unknown> =>
    timeBuildStage(
      stage,
      () => {
        const result = spawnSync(
          "xcrun",
          ["notarytool", ...args, ...auth, "--output-format", "json"],
          { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
        );
        if (result.status !== 0)
          throw new Error(
            `${stage} failed: ${result.stderr || result.error?.message || result.status}`,
          );
        return JSON.parse(result.stdout) as Record<string, unknown>;
      },
      "external",
    );
  mkdirSync(stateDir, { recursive: true });
  const statePath = join(stateDir, `${basename(payload)}.json`);
  const digest = await payloadDigest(payload);
  let state = existsSync(statePath)
    ? (JSON.parse(readFileSync(statePath, "utf8")) as NotarySubmission)
    : undefined;
  if (state && !reusableSubmission(state, digest))
    throw new Error(
      "Notarization payload changed; remove its stale submission state before submitting a new payload.",
    );
  if (!state) {
    const submitted = json(["submit", payload], `${label}-notary-upload`);
    if (typeof submitted.id !== "string" || !/^[0-9a-f-]{36}$/i.test(submitted.id))
      throw new Error("Apple returned no valid submission ID.");
    state = { id: submitted.id, payloadSha256: digest };
    writeFileSync(statePath, JSON.stringify(state) + "\n", { mode: 0o600 });
  }
  console.log(`[notarization] ${label} submission ${state.id}`);
  const finish = startBuildStage(`${label}-notary-wait`, "external");
  let waitError: unknown;
  try {
    await new Promise<void>((resolve, reject) => {
      // Human-readable output is deliberately inherited: --output-format json
      // suppresses progress. A failed wait keeps Apple's submission ID intact.
      const child = spawn("xcrun", ["notarytool", "wait", state.id, ...auth], { stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`${label} notarization wait failed (${code}).`)),
      );
    });
    finish(true);
  } catch (error) {
    finish(false);
    waitError = error;
  }
  let info: Record<string, unknown>;
  try {
    info = json(["info", state.id], `${label}-notary-status`);
  } catch (error) {
    throw waitError ?? error;
  }
  // Save Apple's diagnostics on success and failure, without credentials.
  const logPath = join(stateDir, `${state.id}.log.json`);
  try {
    runMacCommand(
      "xcrun",
      ["notarytool", "log", state.id, ...auth, logPath],
      `${label}-notary-log`,
    );
  } catch (error) {
    throw waitError ?? error;
  }
  if (waitError) throw waitError;
  if (info.status !== "Accepted")
    throw new Error(
      `${label} notarization was not accepted: ${String(info.status)}. See ${logPath}`,
    );
  return { statePath, state };
}

export async function recordStapledPayload(
  payload: string,
  submission: { statePath: string; state: NotarySubmission },
): Promise<void> {
  writeFileSync(
    submission.statePath,
    JSON.stringify({ ...submission.state, stapledSha256: await payloadDigest(payload) }) + "\n",
    { mode: 0o600 },
  );
}

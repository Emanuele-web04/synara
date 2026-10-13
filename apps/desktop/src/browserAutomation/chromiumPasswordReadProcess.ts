import type { ChromiumInventorySourceId } from "./chromiumProfileInventory";
import type { BrowserPasswordLogin } from "./chromiumPasswordReader";
import { BoundedNodeProcessError, runBoundedNodeProcess } from "./boundedNodeProcess";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 40 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_TIMEOUT_MS = 60_000;

type ProfilePreflight = {
  count: number | null;
  status: "available" | "unavailable" | "locked";
  code?: "source_too_large";
} | null;
type PasswordRead = { logins: BrowserPasswordLogin[]; skipped: number };

function workerPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "chromiumPasswordWorker.js");
}

function error(code: string): Error & { code: string } {
  return Object.assign(new Error("Browser password data could not be read safely."), { code });
}

async function callWorker<T>(
  request: Record<string, unknown>,
  signal: AbortSignal,
  home: string,
): Promise<T> {
  signal.throwIfAborted();
  const moduleUrl = pathToFileURL(workerPath()).href;
  const script = `await import(${JSON.stringify(moduleUrl)});`;
  const payload = Buffer.from(JSON.stringify(request), "utf8");
  request.passphrase = "";
  let output: string;
  try {
    output = await runBoundedNodeProcess(script, payload, {
      home,
      signal,
      timeoutMs: MAX_TIMEOUT_MS,
      maxInputBytes: MAX_INPUT_BYTES,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      maxStderrBytes: MAX_STDERR_BYTES,
    });
  } catch (cause) {
    if (signal.aborted) throw signal.reason ?? cause;
    const code = cause instanceof BoundedNodeProcessError ? cause.code : "reader_failed";
    throw error(
      code === "input_too_large" || code === "output_too_large"
        ? "source_too_large"
        : code === "timed_out"
          ? "timed_out"
          : "reader_failed",
    );
  }
  let response: { ok?: boolean; code?: string; profile?: T; result?: T };
  try {
    response = JSON.parse(output);
  } catch {
    throw error("reader_failed");
  }
  if (response.ok !== true) throw error(response.code ?? "reader_failed");
  return (request.action === "preflight" ? response.profile : response.result) as T;
}

/** Counts one selected browser profile's passwords outside Electron's main event loop. */
export function inventoryChromiumPasswordProfileProcess(
  home: string,
  browser: ChromiumInventorySourceId,
  profile: string,
  signal: AbortSignal,
): Promise<ProfilePreflight> {
  return callWorker<ProfilePreflight>(
    { action: "preflight", home, browser, profile },
    signal,
    home,
  );
}

/** Reads and decrypts one selected profile's passwords outside Electron's main event loop. */
export function readChromiumProfilePasswordsProcess(
  home: string,
  browser: ChromiumInventorySourceId,
  profile: string,
  passphrase: string,
  signal: AbortSignal,
): Promise<PasswordRead> {
  return callWorker<PasswordRead>(
    { action: "read", home, browser, profile, passphrase },
    signal,
    home,
  );
}

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { BoundedNodeProcessError, runBoundedNodeProcess } from "./boundedNodeProcess";

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_TIMEOUT_MS = 60_000;
const MAX_KEYCHAIN_TIMEOUT_MS = 15_000;

type CookieReadError = Error & {
  cookieReaderCode?: string;
  cookieReaderStage?: string;
  cookiePermissionDenied?: boolean;
};

function readerError(code: string, stage: string, permissionDenied = false): CookieReadError {
  return Object.assign(new Error("Browser cookie source could not be read safely."), {
    cookieReaderCode: code,
    cookieReaderStage: stage,
    cookiePermissionDenied: permissionDenied,
  });
}

function sourceModulePath(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("betterwright")), "chromium-cookie-source.js");
}

/** Runs SQLite snapshotting and row parsing outside Electron's main event loop. */
export async function readChromiumCookieSnapshotProcess(
  source: { browser: string; profile?: string },
  timeoutMs: number,
  keychainPassword: (browser: string, timeoutMs: number) => Promise<string>,
  signal: AbortSignal,
  home = homedir(),
): Promise<unknown> {
  signal.throwIfAborted();
  const startedAt = Date.now();
  const totalBudgetMs = Math.max(1, Math.min(timeoutMs, MAX_TIMEOUT_MS));
  const remainingBudgetMs = () => totalBudgetMs - (Date.now() - startedAt);
  let password = await keychainPassword(
    source.browser,
    Math.max(1, Math.min(remainingBudgetMs(), MAX_KEYCHAIN_TIMEOUT_MS)),
  );
  signal.throwIfAborted();
  const readBudgetMs = remainingBudgetMs();
  if (readBudgetMs <= 0) throw readerError("timed_out", "acquisition");
  const moduleUrl = pathToFileURL(sourceModulePath()).href;
  const script = `
const chunks = [];
let inputBytes = 0;
for await (const chunk of process.stdin) {
  inputBytes += chunk.byteLength;
  if (inputBytes > ${MAX_INPUT_BYTES}) process.exit(2);
  chunks.push(chunk);
}
try {
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const source = await import(${JSON.stringify(moduleUrl)});
  const result = await source.readChromiumCookieSnapshot(input.options, {
    home: input.home,
    keychainPassword: async () => input.password,
  });
  input.password = "";
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    code: typeof error?.cookieReaderCode === "string" ? error.cookieReaderCode : "source_extraction_failed",
    stage: typeof error?.cookieReaderStage === "string" ? error.cookieReaderStage : "acquisition",
    permissionDenied: error?.cookiePermissionDenied === true,
  }));
}
`;
  const payload = Buffer.from(
    JSON.stringify({ options: { source, timeoutMs: readBudgetMs }, home, password }),
    "utf8",
  );
  password = "";
  try {
    const output = await runBoundedNodeProcess(script, payload, {
      home,
      signal,
      timeoutMs: readBudgetMs,
      maxInputBytes: MAX_INPUT_BYTES,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      maxStderrBytes: MAX_STDERR_BYTES,
    });
    let response: {
      ok?: boolean;
      result?: unknown;
      code?: string;
      stage?: string;
      permissionDenied?: boolean;
    };
    try {
      response = JSON.parse(output);
    } catch {
      throw readerError("source_extraction_failed", "acquisition");
    }
    if (response.ok === true) return response.result;
    throw readerError(
      response.code ?? "source_extraction_failed",
      response.stage ?? "acquisition",
      response.permissionDenied === true,
    );
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    if (error instanceof BoundedNodeProcessError) {
      if (error.code === "timed_out") throw readerError("timed_out", "acquisition");
      if (error.code === "input_too_large" || error.code === "output_too_large")
        throw readerError("source_too_large", "acquisition");
    }
    if (
      typeof error === "object" &&
      error !== null &&
      ("cookieReaderCode" in error || "cookiePermissionDenied" in error)
    )
      throw error;
    throw readerError("source_extraction_failed", "acquisition");
  } finally {
    password = "";
  }
}

import { spawnProcess } from "@synara/shared/processRuntime";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

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
  const password = await keychainPassword(
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
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal.reason);
  if (signal.aborted) abortFromCaller();
  else signal.addEventListener("abort", abortFromCaller, { once: true });
  if (controller.signal.aborted) {
    signal.removeEventListener("abort", abortFromCaller);
    throw signal.reason ?? new Error("Cookie import cancelled.");
  }
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, readBudgetMs);

  try {
    const payload = Buffer.from(
      JSON.stringify({ options: { source, timeoutMs: readBudgetMs }, home, password }),
      "utf8",
    );
    if (payload.byteLength > MAX_INPUT_BYTES) throw readerError("source_too_large", "acquisition");
    const child = spawnProcess(process.execPath, ["--input-type=module", "-e", script], {
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        HOME: home,
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      },
      signal: controller.signal,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    let outputBytes = 0;
    let stderrBytes = 0;
    let outputTooLarge = false;
    let stderrTooLarge = false;
    let stdinError: Error | undefined;
    let spawnError: Error | undefined;
    child.stdout.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.byteLength;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        outputTooLarge = true;
        controller.abort();
        return;
      }
      output.push(bytes);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > MAX_STDERR_BYTES) {
        stderrTooLarge = true;
        controller.abort();
      }
    });
    child.stdin.on("error", (error: Error) => {
      stdinError = error;
      controller.abort();
    });
    child.once("error", (error: Error) => {
      spawnError = error;
      controller.abort();
    });
    const closed = new Promise<number | null>((resolve) => {
      child.once("close", (code: number | null) => resolve(code));
    });
    child.stdin.end(payload, () => payload.fill(0));

    const exitCode = await closed;
    if (signal.aborted) throw signal.reason ?? new Error("Cookie import cancelled.");
    if (timedOut) throw readerError("timed_out", "acquisition");
    if (outputTooLarge) throw readerError("source_too_large", "acquisition");
    if (stderrTooLarge || stdinError || spawnError)
      throw readerError("source_extraction_failed", "acquisition");
    if (exitCode !== 0) throw readerError("source_extraction_failed", "acquisition");
    let response: {
      ok?: boolean;
      result?: unknown;
      code?: string;
      stage?: string;
      permissionDenied?: boolean;
    };
    try {
      response = JSON.parse(Buffer.concat(output).toString("utf8"));
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
    if (timedOut) throw readerError("timed_out", "acquisition");
    if (
      typeof error === "object" &&
      error !== null &&
      ("cookieReaderCode" in error || "cookiePermissionDenied" in error)
    )
      throw error;
    throw readerError("source_extraction_failed", "acquisition");
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abortFromCaller);
  }
}

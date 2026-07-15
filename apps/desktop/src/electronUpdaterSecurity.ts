// FILE: electronUpdaterSecurity.ts
// Purpose: Hardens electron-updater Windows process calls against Node deprecations.
// Layer: Desktop update runtime
// Exports: updater patching, shell-free PowerShell signature verification helpers.

import {
  execFile,
  spawnSync,
  type ExecFileException,
  type ExecFileOptions,
} from "node:child_process";
import * as Path from "node:path";

import { prepareWindowsSafeProcess, resolveWindowsSystemRoot } from "@synara/shared/windowsProcess";

type Logger = {
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
};

type UpdaterModule = {
  BaseUpdater?: unknown;
};

type UpdaterPrototype = {
  spawnSyncLog?: (cmd: string, args?: string[], env?: Record<string, string>) => string;
  __synaraSpawnSyncLogPatched?: boolean;
};

type UpdaterWithSignatureVerifier = {
  verifyUpdateCodeSignature?: (
    publisherNames: string[],
    unescapedTempUpdateFile: string,
  ) => Promise<string | null>;
};

type ExecFileLike = (
  file: string,
  args: ReadonlyArray<string>,
  options: ExecFileOptions & { encoding: "utf8" },
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => void;

interface PowerShellRunResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface PowerShellFailure extends Error {
  readonly stderr?: string;
}

interface SignatureVerifierOptions {
  readonly execFile?: ExecFileLike;
  readonly env?: NodeJS.ProcessEnv;
}

export function buildPowerShellExecutablePath(env: NodeJS.ProcessEnv = process.env): string {
  return Path.win32.join(
    resolveWindowsSystemRoot(env),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

export function buildPowerShellExecArgs(command: string): string[] {
  const utf8Preamble =
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; " +
    "$OutputEncoding = [System.Text.Encoding]::UTF8;";
  return [
    "-NoProfile",
    "-NonInteractive",
    "-InputFormat",
    "None",
    "-Command",
    `${utf8Preamble} ${command}`,
  ];
}

function buildPowerShellExecOptions(
  timeout: number,
  env: NodeJS.ProcessEnv,
): ExecFileOptions & { encoding: "utf8" } {
  return {
    env: { ...env, PSModulePath: "" },
    encoding: "utf8",
    shell: false,
    timeout,
    windowsHide: true,
  };
}

function runPowerShell(
  command: string,
  timeout: number,
  options: SignatureVerifierOptions,
): Promise<PowerShellRunResult> {
  const env = options.env ?? process.env;
  return new Promise((resolve, reject) => {
    const execFileImpl: ExecFileLike =
      options.execFile ??
      ((file, args, execOptions, callback) => {
        execFile(file, [...args], execOptions, (error, stdout, stderr) => {
          callback(error, String(stdout), String(stderr));
        });
      });
    execFileImpl(
      buildPowerShellExecutablePath(env),
      buildPowerShellExecArgs(command),
      buildPowerShellExecOptions(timeout, env),
      (error, stdout, stderr) => {
        if (error) {
          const failure = error as PowerShellFailure;
          Object.defineProperty(failure, "stderr", {
            value: stderr,
            enumerable: false,
            configurable: true,
          });
          reject(failure);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

export function parseDistinguishedName(seq: string): Map<string, string> {
  let quoted = false;
  let key: string | null = null;
  let token = "";
  let nextNonSpace = 0;
  const result = new Map<string, string>();
  const trimmed = seq.trim();

  for (let i = 0; i <= trimmed.length; i += 1) {
    if (i === trimmed.length) {
      if (key !== null) {
        result.set(key, token);
      }
      break;
    }
    const ch = trimmed[i];
    if (quoted) {
      if (ch === '"') {
        quoted = false;
        continue;
      }
    } else {
      if (ch === '"') {
        quoted = true;
        continue;
      }
      if (ch === "\\") {
        i += 1;
        const ord = Number.parseInt(trimmed.slice(i, i + 2), 16);
        if (Number.isNaN(ord)) {
          token += trimmed[i] ?? "";
        } else {
          i += 1;
          token += String.fromCharCode(ord);
        }
        continue;
      }
      if (key === null && ch === "=") {
        key = token;
        token = "";
        continue;
      }
      if (ch === "," || ch === ";" || ch === "+") {
        if (key !== null) {
          result.set(key, token);
        }
        key = null;
        token = "";
        continue;
      }
    }
    if (ch === " " && !quoted) {
      if (token.length === 0) {
        continue;
      }
      if (i > nextNonSpace) {
        let j = i;
        while (trimmed[j] === " ") {
          j += 1;
        }
        nextNonSpace = j;
      }
      if (
        nextNonSpace >= trimmed.length ||
        trimmed[nextNonSpace] === "," ||
        trimmed[nextNonSpace] === ";" ||
        (key === null && trimmed[nextNonSpace] === "=") ||
        (key !== null && trimmed[nextNonSpace] === "+")
      ) {
        i = nextNonSpace - 1;
        continue;
      }
    }
    token += ch;
  }

  return result;
}

function parseSignatureOutput(out: string): Record<string, unknown> {
  const data = JSON.parse(out) as Record<string, unknown>;
  delete data.PrivateKey;
  delete data.IsOSBinary;
  delete data.SignatureType;

  const signerCertificate =
    typeof data.SignerCertificate === "object" && data.SignerCertificate !== null
      ? (data.SignerCertificate as Record<string, unknown>)
      : null;
  if (signerCertificate) {
    delete signerCertificate.Archived;
    delete signerCertificate.Extensions;
    delete signerCertificate.Handle;
    delete signerCertificate.HasPrivateKey;
    delete signerCertificate.SubjectName;
  }

  return data;
}

function handleSignatureError(logger: Logger, error: unknown, stderr: string | null): string {
  const detail =
    error instanceof Error
      ? error.message
      : error != null
        ? String(error)
        : stderr?.trim() || "unknown PowerShell failure";
  const result = `Windows update signature verification could not be completed: ${detail}`;
  logger.warn?.(result);
  return result;
}

export async function verifyWindowsUpdateCodeSignature(
  publisherNames: string[],
  unescapedTempUpdateFile: string,
  logger: Logger = console,
  options: SignatureVerifierOptions = {},
): Promise<string | null> {
  const tempUpdateFile = unescapedTempUpdateFile.replace(/'/g, "''");
  logger.info?.(`Verifying signature ${tempUpdateFile}`);

  let stdout: string;
  try {
    const result = await runPowerShell(
      `Get-AuthenticodeSignature -LiteralPath '${tempUpdateFile}' | ConvertTo-Json -Compress`,
      20 * 1000,
      options,
    );
    if (result.stderr) {
      return handleSignatureError(logger, null, result.stderr);
    }
    stdout = result.stdout;
  } catch (error) {
    return handleSignatureError(
      logger,
      error,
      error instanceof Error ? ((error as PowerShellFailure).stderr ?? null) : null,
    );
  }

  try {
    const data = parseSignatureOutput(stdout);
    if (data.Status === 0) {
      const signerCertificate =
        typeof data.SignerCertificate === "object" && data.SignerCertificate !== null
          ? (data.SignerCertificate as Record<string, unknown>)
          : null;
      const subject =
        typeof signerCertificate?.Subject === "string"
          ? parseDistinguishedName(signerCertificate.Subject)
          : new Map<string, string>();

      const normalizedUpdateFile = Path.win32.normalize(unescapedTempUpdateFile);
      if (typeof data.Path !== "string" || data.Path.length === 0) {
        return handleSignatureError(
          logger,
          new Error("Get-AuthenticodeSignature returned no signed file path"),
          null,
        );
      }

      const normalizedSignaturePath = Path.win32.normalize(data.Path);
      if (normalizedSignaturePath !== normalizedUpdateFile) {
        return handleSignatureError(
          logger,
          new Error(
            `LiteralPath of ${normalizedSignaturePath} is different than ${normalizedUpdateFile}`,
          ),
          null,
        );
      }

      for (const name of publisherNames) {
        const dn = parseDistinguishedName(name);
        if (dn.has("CN") && dn.size >= 2) {
          const keys = Array.from(dn.keys());
          if (keys.every((key) => dn.get(key) === subject.get(key))) {
            return null;
          }
        }
      }
    }

    const result =
      `publisherNames: ${publisherNames.join(" | ")}, raw info: ` +
      JSON.stringify(data, (name, value) => (name === "RawData" ? undefined : value), 2);
    logger.warn?.(
      `Sign verification failed, installer signed with incorrect certificate: ${result}`,
    );
    return result;
  } catch (error) {
    return handleSignatureError(logger, error, null);
  }
}

export function resolveWindowsUpdatePublisherNames(
  feedPublisherNames: ReadonlyArray<string>,
  embeddedPublisherSubjects: ReadonlyArray<string> | null,
): string[] {
  return (embeddedPublisherSubjects ?? feedPublisherNames)
    .map((name) => name.trim())
    .filter((name) => {
      const dn = parseDistinguishedName(name);
      return dn.has("CN") && dn.size >= 2;
    });
}

export function hardenElectronUpdater(
  updaterModule: UpdaterModule,
  updater: unknown,
  platform: NodeJS.Platform = process.platform,
  embeddedPublisherSubjects: ReadonlyArray<string> | null = [],
): void {
  if (platform !== "win32") {
    return;
  }

  const prototype =
    typeof updaterModule.BaseUpdater === "function"
      ? ((updaterModule.BaseUpdater as { prototype?: UpdaterPrototype }).prototype ?? null)
      : null;
  if (prototype && !prototype.__synaraSpawnSyncLogPatched) {
    prototype.spawnSyncLog = function spawnSyncLog(
      this: { _logger?: Logger },
      cmd: string,
      args: string[] = [],
      env: Record<string, string> = {},
    ): string {
      this._logger?.info?.(`Executing: ${cmd} with args: ${args}`);
      const mergedEnv = { ...process.env, ...env };
      const prepared = prepareWindowsSafeProcess(cmd, args, { env: mergedEnv });
      const response = spawnSync(prepared.command, prepared.args, {
        env: mergedEnv,
        encoding: "utf8",
        shell: prepared.shell,
        windowsHide: prepared.windowsHide,
        windowsVerbatimArguments: prepared.windowsVerbatimArguments,
      });
      const { error, status, stdout, stderr } = response;
      if (error) {
        this._logger?.error?.(stderr ?? "");
        throw error;
      }
      if (status != null && status !== 0) {
        this._logger?.error?.(stderr ?? "");
        throw new Error(`Command ${cmd} exited with code ${status}`);
      }
      return (stdout ?? "").trim();
    };
    prototype.__synaraSpawnSyncLogPatched = true;
  }

  const nsisUpdater = updater as UpdaterWithSignatureVerifier | null;
  if (nsisUpdater && "verifyUpdateCodeSignature" in nsisUpdater) {
    nsisUpdater.verifyUpdateCodeSignature = (publisherNames, unescapedTempUpdateFile) => {
      const allowedPublisherNames = resolveWindowsUpdatePublisherNames(
        publisherNames,
        embeddedPublisherSubjects,
      );
      if (allowedPublisherNames.length === 0) {
        return Promise.resolve(
          "Windows update signature verification blocked: no valid embedded publisher subject DN.",
        );
      }
      return verifyWindowsUpdateCodeSignature(
        allowedPublisherNames,
        unescapedTempUpdateFile,
        console,
      );
    };
  }
}

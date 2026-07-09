// FILE: macUpdateDiagnostics.ts
// Purpose: Collects bounded, best-effort Squirrel.Mac and launchd diagnostics after update failures.
// Layer: Desktop update utility

import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

const COMMAND_TIMEOUT_MS = 2_000;
const MAX_DIAGNOSTIC_BYTES = 8 * 1024;
const MAX_COMMAND_BUFFER_BYTES = 64 * 1024;

type CommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly error: string | null;
};

function runCommand(file: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    ChildProcess.execFile(
      file,
      [...args],
      { encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_COMMAND_BUFFER_BYTES },
      (error, stdout, stderr) => {
        resolve({
          stdout: typeof stdout === "string" ? stdout : String(stdout),
          stderr: typeof stderr === "string" ? stderr : String(stderr),
          error: error ? error.message : null,
        });
      },
    );
  });
}

function formatStat(label: string, stat: FS.Stats): string {
  return `${label}: size=${stat.size} mtime=${stat.mtime.toISOString()}`;
}

async function statLine(filePath: string, label: string): Promise<string> {
  try {
    return formatStat(label, await FS.promises.stat(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return `${label}: missing`;
    }
    return `${label}: stat failed (${error instanceof Error ? error.message : String(error)})`;
  }
}

async function collectShipItCacheDiagnostics(bundleId: string): Promise<string[]> {
  const cacheDir = Path.join(OS.homedir(), "Library", "Caches", `${bundleId}.ShipIt`);
  const statePath = Path.join(cacheDir, "ShipItState.plist");
  const lines = [`ShipIt cache: ${cacheDir}`, await statLine(statePath, "ShipItState.plist")];

  if (FS.existsSync(statePath)) {
    const plist = await runCommand("/usr/bin/plutil", ["-convert", "json", "-o", "-", statePath]);
    if (plist.stdout.trim()) {
      lines.push(`ShipItState.plist content: ${plist.stdout.trim()}`);
    }
    if (plist.error || plist.stderr.trim()) {
      lines.push(`ShipItState.plist parse issue: ${plist.error ?? plist.stderr.trim()}`);
    }
  }

  lines.push(
    await statLine(Path.join(cacheDir, "ShipIt_stdout.log"), "ShipIt_stdout.log"),
    await statLine(Path.join(cacheDir, "ShipIt_stderr.log"), "ShipIt_stderr.log"),
  );

  try {
    const entries = await FS.promises.readdir(cacheDir, { withFileTypes: true });
    const stagedDirectories = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("update."))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (stagedDirectories.length === 0) {
      lines.push("Staged update directories: none");
    } else {
      lines.push("Staged update directories:");
      for (const entry of stagedDirectories) {
        lines.push(`  ${await statLine(Path.join(cacheDir, entry.name), entry.name)}`);
      }
    }
  } catch (error) {
    lines.push(
      `ShipIt cache listing failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return lines;
}

async function collectLaunchctlDiagnostics(bundleId: string): Promise<string[]> {
  const uid = process.getuid?.();
  if (uid === undefined) {
    return ["launchctl: uid unavailable"];
  }
  const service = `gui/${uid}/${bundleId}.ShipIt`;
  const result = await runCommand("/bin/launchctl", ["print", service]);
  const informativeLines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      /^(state|pid|runs|run count|last exit|last terminating|reason)\b/i.test(line),
    );
  const lines = [`launchctl ${service}:`];
  if (informativeLines.length > 0) {
    lines.push(...informativeLines.map((line) => `  ${line}`));
  } else {
    lines.push("  no informative service state returned");
  }
  if (result.error || result.stderr.trim()) {
    lines.push(`  command issue: ${result.error ?? result.stderr.trim()}`);
  }
  return lines;
}

function capDiagnosticOutput(output: string): string {
  const encoded = Buffer.from(output, "utf8");
  if (encoded.byteLength <= MAX_DIAGNOSTIC_BYTES) {
    return output;
  }
  const suffix = "\n[diagnostics truncated]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  return `${encoded.subarray(0, MAX_DIAGNOSTIC_BYTES - suffixBytes).toString("utf8")}${suffix}`;
}

export async function collectMacUpdateDiagnostics(bundleId: string): Promise<string> {
  if (process.platform !== "darwin") {
    return "";
  }
  try {
    const [cacheLines, launchctlLines] = await Promise.all([
      collectShipItCacheDiagnostics(bundleId),
      collectLaunchctlDiagnostics(bundleId),
    ]);
    return capDiagnosticOutput([...cacheLines, ...launchctlLines].join("\n"));
  } catch (error) {
    return capDiagnosticOutput(
      `Diagnostic collection failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

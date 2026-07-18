// FILE: tailscaleDiagnostics.ts
// Purpose: Reads Tailscale and Serve state without mutating the user's Tailnet configuration.
// Layer: Desktop main-process integration

import * as ChildProcess from "node:child_process";
import * as OS from "node:os";
import * as Path from "node:path";

const TAILSCALE_COMMAND_TIMEOUT_MS = 5_000;
const TAILSCALE_MAX_OUTPUT_BYTES = 1024 * 1024;

export type TailscaleConnectionState =
  | "connected"
  | "signed-out"
  | "stopped"
  | "unavailable"
  | "error";

export type TailscaleServeState =
  | "matching"
  | "not-configured"
  | "different-target"
  | "unavailable"
  | "error";

export interface TailscaleStatusSnapshot {
  readonly backendState: string | null;
  readonly connectionState: TailscaleConnectionState;
  readonly dnsName: string | null;
  readonly tailnetName: string | null;
}

export interface TailscaleServeSnapshot {
  readonly state: TailscaleServeState;
  readonly funnelEnabled: boolean;
  readonly proxyTargets: ReadonlyArray<string>;
}

export interface TailscaleDiagnostics {
  readonly checkedAt: string;
  readonly cliAvailable: boolean;
  readonly executable: string | null;
  readonly connectionState: TailscaleConnectionState;
  readonly backendState: string | null;
  readonly dnsName: string | null;
  readonly tailnetName: string | null;
  readonly serveState: TailscaleServeState;
  readonly funnelEnabled: boolean;
  readonly expectedProxyTarget: string;
  readonly expectedServeCommand: string;
  readonly proxyTargets: ReadonlyArray<string>;
  readonly discoveredOrigin: string | null;
  readonly mobileUrl: string | null;
  readonly issue: string | null;
}

export interface TailscaleCommandResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly unavailable: boolean;
}

export type TailscaleCommandRunner = (
  executable: string,
  args: ReadonlyArray<string>,
) => Promise<TailscaleCommandResult>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanDnsName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/\.+$/, "");
  return normalized.length > 0 && !normalized.includes("*") ? normalized : null;
}

export function parseTailscaleStatusJson(value: unknown): TailscaleStatusSnapshot {
  if (!isPlainRecord(value)) {
    return {
      backendState: null,
      connectionState: "error",
      dnsName: null,
      tailnetName: null,
    };
  }

  const backendState = typeof value.BackendState === "string" ? value.BackendState : null;
  const normalizedState = backendState?.trim().toLowerCase() ?? "";
  const connectionState: TailscaleConnectionState =
    normalizedState === "running"
      ? "connected"
      : normalizedState === "needslogin" || normalizedState === "needs-machine-auth"
        ? "signed-out"
        : normalizedState === "stopped" || normalizedState === "starting"
          ? "stopped"
          : "error";

  const self = isPlainRecord(value.Self) ? value.Self : null;
  const currentTailnet = isPlainRecord(value.CurrentTailnet) ? value.CurrentTailnet : null;
  const tailnetName =
    currentTailnet && typeof currentTailnet.Name === "string"
      ? currentTailnet.Name.trim() || null
      : null;

  return {
    backendState,
    connectionState,
    dnsName: cleanDnsName(self?.DNSName),
    tailnetName,
  };
}

function collectStrings(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, output);
    return;
  }
  if (!isPlainRecord(value)) return;
  for (const entry of Object.values(value)) collectStrings(entry, output);
}

function hasEnabledValue(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized.length > 0 && normalized !== "false" && normalized !== "off";
  }
  if (Array.isArray(value)) return value.some(hasEnabledValue);
  if (isPlainRecord(value)) return Object.values(value).some(hasEnabledValue);
  return false;
}

function containsEnabledFunnel(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsEnabledFunnel);
  if (!isPlainRecord(value)) return false;
  for (const [key, entry] of Object.entries(value)) {
    if (key.toLowerCase().includes("funnel") && hasEnabledValue(entry)) return true;
    if (containsEnabledFunnel(entry)) return true;
  }
  return false;
}

function normalizeProxyTarget(value: string): string | null {
  const candidate = value.trim();
  if (!candidate.startsWith("http://") && !candidate.startsWith("https://")) return null;
  try {
    const url = new URL(candidate);
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function normalizeServeHost(value: string): string | null {
  try {
    return cleanDnsName(new URL(`https://${value}`).hostname);
  } catch {
    return null;
  }
}

function hasMatchingRootProxy(
  value: Record<string, unknown>,
  expectedProxyTarget: string,
  expectedDnsName?: string | null,
): boolean {
  const web = isPlainRecord(value.Web) ? value.Web : null;
  if (!web) return false;
  const normalizedExpected = normalizeProxyTarget(expectedProxyTarget);
  if (!normalizedExpected) return false;
  const normalizedDnsName = cleanDnsName(expectedDnsName);

  for (const [host, hostConfiguration] of Object.entries(web)) {
    if (normalizedDnsName && normalizeServeHost(host) !== normalizedDnsName) continue;
    if (!isPlainRecord(hostConfiguration)) continue;
    const handlers = isPlainRecord(hostConfiguration.Handlers)
      ? hostConfiguration.Handlers
      : null;
    const rootHandler = handlers && isPlainRecord(handlers["/"]) ? handlers["/"] : null;
    const proxy = rootHandler && typeof rootHandler.Proxy === "string" ? rootHandler.Proxy : null;
    if (proxy && normalizeProxyTarget(proxy) === normalizedExpected) return true;
  }
  return false;
}

export function parseTailscaleServeJson(
  value: unknown,
  expectedProxyTarget: string,
  expectedDnsName?: string | null,
): TailscaleServeSnapshot {
  if (!isPlainRecord(value)) {
    return { state: "error", funnelEnabled: false, proxyTargets: [] };
  }

  const strings: string[] = [];
  collectStrings(value, strings);
  const proxyTargets = Array.from(
    new Set(strings.map(normalizeProxyTarget).filter((entry): entry is string => entry !== null)),
  );
  const hasConfiguration = Object.keys(value).length > 0;
  const state: TailscaleServeState =
    hasMatchingRootProxy(value, expectedProxyTarget, expectedDnsName)
      ? "matching"
      : hasConfiguration
        ? "different-target"
        : "not-configured";

  return {
    state,
    funnelEnabled: containsEnabledFunnel(value),
    proxyTargets,
  };
}

function candidateExecutables(platform: NodeJS.Platform): ReadonlyArray<string> {
  if (platform === "win32") {
    const programFiles = process.env.ProgramFiles?.trim() || "C:\\Program Files";
    return [Path.join(programFiles, "Tailscale", "tailscale.exe"), "tailscale.exe", "tailscale"];
  }
  if (platform === "darwin") {
    return ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "tailscale"];
  }
  return ["tailscale"];
}

export const runTailscaleCommand: TailscaleCommandRunner = (executable, args) =>
  new Promise((resolve) => {
    ChildProcess.execFile(
      executable,
      [...args],
      {
        windowsHide: true,
        // Do not let an executable planted in Synara's working directory win Windows lookup.
        cwd: OS.tmpdir(),
        timeout: TAILSCALE_COMMAND_TIMEOUT_MS,
        maxBuffer: TAILSCALE_MAX_OUTPUT_BYTES,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        resolve({
          ok: error === null,
          stdout: typeof stdout === "string" ? stdout : String(stdout ?? ""),
          stderr: typeof stderr === "string" ? stderr : String(stderr ?? ""),
          unavailable: code === "ENOENT",
        });
      },
    );
  });

async function findTailscaleExecutable(
  platform: NodeJS.Platform,
  runner: TailscaleCommandRunner,
): Promise<{ executable: string; result: TailscaleCommandResult } | null> {
  for (const executable of candidateExecutables(platform)) {
    const result = await runner(executable, ["status", "--json"]);
    if (!result.unavailable) return { executable, result };
  }
  return null;
}

function parseJsonOutput(output: string): unknown | null {
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

function resolveIssue(input: {
  status: TailscaleStatusSnapshot;
  serve: TailscaleServeSnapshot;
}): string | null {
  if (input.status.connectionState === "signed-out") {
    return "Tailscale is installed but this computer is not signed in.";
  }
  if (input.status.connectionState === "stopped") {
    return "Tailscale is not running on this computer.";
  }
  if (input.status.connectionState !== "connected") {
    return "Tailscale status could not be read.";
  }
  if (!input.status.dnsName) {
    return "Tailscale did not report a MagicDNS name for this computer.";
  }
  if (input.serve.funnelEnabled) {
    return "Tailscale Funnel appears to be enabled. Synara Companion must stay private to the Tailnet.";
  }
  if (input.serve.state === "not-configured") {
    return "Tailscale Serve is not configured for the Synara backend.";
  }
  if (input.serve.state === "different-target") {
    return "Tailscale Serve is configured, but it does not proxy the configured Synara port.";
  }
  if (input.serve.state !== "matching") {
    return "Tailscale Serve status could not be read.";
  }
  return null;
}

export async function collectTailscaleDiagnostics(input: {
  readonly port: number;
  readonly platform?: NodeJS.Platform;
  readonly runner?: TailscaleCommandRunner;
  readonly now?: () => Date;
}): Promise<TailscaleDiagnostics> {
  const platform = input.platform ?? process.platform;
  const runner = input.runner ?? runTailscaleCommand;
  const checkedAt = (input.now ?? (() => new Date()))().toISOString();
  const expectedProxyTarget = `http://127.0.0.1:${input.port}`;
  const expectedServeCommand = `tailscale serve --bg ${expectedProxyTarget}`;
  const found = await findTailscaleExecutable(platform, runner);

  if (!found) {
    return {
      checkedAt,
      cliAvailable: false,
      executable: null,
      connectionState: "unavailable",
      backendState: null,
      dnsName: null,
      tailnetName: null,
      serveState: "unavailable",
      funnelEnabled: false,
      expectedProxyTarget,
      expectedServeCommand,
      proxyTargets: [],
      discoveredOrigin: null,
      mobileUrl: null,
      issue: "The Tailscale CLI was not found. Install Tailscale and sign in first.",
    };
  }

  const statusValue = parseJsonOutput(found.result.stdout);
  const status = statusValue
    ? parseTailscaleStatusJson(statusValue)
    : {
        backendState: null,
        connectionState: found.result.ok ? ("error" as const) : ("signed-out" as const),
        dnsName: null,
        tailnetName: null,
      };

  let serve: TailscaleServeSnapshot = {
    state: status.connectionState === "connected" ? "error" : "unavailable",
    funnelEnabled: false,
    proxyTargets: [],
  };
  if (status.connectionState === "connected") {
    const serveResult = await runner(found.executable, ["serve", "status", "--json"]);
    if (serveResult.ok) {
      const serveValue = parseJsonOutput(serveResult.stdout);
      serve = serveValue
        ? parseTailscaleServeJson(serveValue, expectedProxyTarget, status.dnsName)
        : { state: "error", funnelEnabled: false, proxyTargets: [] };
    } else if (/no serve config/i.test(serveResult.stderr)) {
      serve = { state: "not-configured", funnelEnabled: false, proxyTargets: [] };
    }
  }

  const discoveredOrigin = status.dnsName ? `https://${status.dnsName}` : null;
  return {
    checkedAt,
    cliAvailable: true,
    executable: found.executable,
    connectionState: status.connectionState,
    backendState: status.backendState,
    dnsName: status.dnsName,
    tailnetName: status.tailnetName,
    serveState: serve.state,
    funnelEnabled: serve.funnelEnabled,
    expectedProxyTarget,
    expectedServeCommand,
    proxyTargets: serve.proxyTargets,
    discoveredOrigin,
    mobileUrl: discoveredOrigin ? `${discoveredOrigin}/mobile/` : null,
    issue: resolveIssue({ status, serve }),
  };
}

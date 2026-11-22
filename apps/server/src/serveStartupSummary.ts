import { formatHostForUrl, isWildcardHost } from "./startupAccess";

export interface ServeStartupSummaryInput {
  readonly host: string | undefined;
  readonly port: number;
  readonly baseDir: string;
  readonly staticDir: string | undefined;
  readonly devUrl: URL | undefined;
  readonly publicUrl: URL | undefined;
  readonly allowInsecureRemote: boolean;
  readonly startupPairingUrl: string | undefined;
}

/**
 * Formats a concise, secret-free startup banner for `synara serve`.
 *
 * Intentionally omits auth tokens and other authority secrets; the one-time
 * startup pairing URL is printed only when remote/public access requires it.
 */
export function formatServeStartupSummary(input: ServeStartupSummaryInput): string {
  const localUrl = `http://localhost:${input.port}`;
  const wildcard = isWildcardHost(input.host);
  const listenUrl = input.host ? `http://${formatHostForUrl(input.host)}:${input.port}` : localUrl;

  const lines: string[] = ["Synara web server listening"];

  if (wildcard) {
    lines.push(`  Listen: ${listenUrl}`);
    lines.push(`  Local: ${localUrl}`);
  } else {
    lines.push(`  URL: ${listenUrl}`);
  }

  if (input.publicUrl) {
    lines.push(`  Public URL: ${input.publicUrl.origin}`);
  }

  if (input.devUrl) {
    lines.push(`  Dev URL: ${input.devUrl.toString()}`);
  }

  if (input.startupPairingUrl) {
    lines.push(`  Pairing URL: ${input.startupPairingUrl}`);
    if (wildcard && !input.publicUrl) {
      lines.push(
        "  Hint: Replace localhost in the pairing URL with this machine's reachable IP or hostname.",
      );
    }
  }

  if (input.allowInsecureRemote && !input.publicUrl) {
    lines.push(
      "  Warning: Unencrypted remote access enabled (--allow-insecure-remote). Use only on a trusted LAN.",
    );
  }

  if (!input.devUrl && !input.staticDir) {
    lines.push("  Web UI: unavailable (run `bun run --cwd apps/web build` or pass --dev-url)");
  }

  lines.push(`  Data: ${input.baseDir}`);

  return lines.join("\n");
}

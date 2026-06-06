import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildCodexMcpConfigCommand,
  buildSandboxMcpConfigToml,
  isMcpSyncEnabled,
  parseMcpAllowlist,
  resolveOperatorCodexMcpPlugins,
  type SandboxCodexMcpServer,
} from "./codexMcpBootstrap.ts";

let home: string;

const writeConfig = (toml: string) => writeFileSync(path.join(home, "config.toml"), toml, "utf8");
const envWith = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  CODEX_HOME: home,
  ...extra,
});

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "codex-mcp-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("isMcpSyncEnabled", () => {
  it("only an explicit true (any case) enables sync", () => {
    expect(isMcpSyncEnabled("true")).toBe(true);
    expect(isMcpSyncEnabled("  TRUE ")).toBe(true);
    expect(isMcpSyncEnabled("false")).toBe(false);
    expect(isMcpSyncEnabled("")).toBe(false);
    expect(isMcpSyncEnabled(undefined)).toBe(false);
  });
});

describe("parseMcpAllowlist", () => {
  it("splits, trims, and drops empties", () => {
    expect(parseMcpAllowlist("exa, novu ,, cloudflare")).toEqual(["exa", "novu", "cloudflare"]);
    expect(parseMcpAllowlist("")).toEqual([]);
    expect(parseMcpAllowlist(undefined)).toEqual([]);
  });
});

describe("resolveOperatorCodexMcpPlugins", () => {
  it("returns empty when no config.toml exists", () => {
    expect(resolveOperatorCodexMcpPlugins(envWith())).toEqual({ servers: [], skipped: [] });
  });

  it("returns empty (not throwing) on unparseable toml", () => {
    writeConfig("this is = = not valid toml [[[");
    expect(resolveOperatorCodexMcpPlugins(envWith())).toEqual({ servers: [], skipped: [] });
  });

  it("syncs a url-only HTTP server with no headers", () => {
    writeConfig('[mcp_servers.exa]\nurl = "https://mcp.exa.ai/mcp?key=abc"\n');
    const { servers, skipped } = resolveOperatorCodexMcpPlugins(envWith());
    expect(skipped).toEqual([]);
    expect(servers).toEqual([
      { name: "exa", url: "https://mcp.exa.ai/mcp?key=abc", httpHeaders: {} },
    ]);
  });

  it("drops stdio/command servers as host-only", () => {
    writeConfig('[mcp_servers.repo]\ncommand = "/Applications/Codex.app/repo"\n');
    const { servers, skipped } = resolveOperatorCodexMcpPlugins(envWith());
    expect(servers).toEqual([]);
    expect(skipped).toEqual([{ name: "repo", reason: "stdio transport (host-only binary)" }]);
  });

  it("drops a server disabled in host config", () => {
    writeConfig('[mcp_servers.off]\nurl = "https://x.test/mcp"\nenabled = false\n');
    const { servers, skipped } = resolveOperatorCodexMcpPlugins(envWith());
    expect(servers).toEqual([]);
    expect(skipped).toEqual([{ name: "off", reason: "disabled in host config" }]);
  });

  it("materializes bearer_token_env_var into an Authorization header", () => {
    writeConfig(
      '[mcp_servers.novu]\nurl = "https://novu.test/mcp"\nbearer_token_env_var = "NOVU_TOKEN"\n',
    );
    const { servers } = resolveOperatorCodexMcpPlugins(envWith({ NOVU_TOKEN: "secret-xyz" }));
    expect(servers).toEqual([
      {
        name: "novu",
        url: "https://novu.test/mcp",
        httpHeaders: { Authorization: "Bearer secret-xyz" },
      },
    ]);
  });

  it("skips a server whose referenced bearer env var is unset", () => {
    writeConfig(
      '[mcp_servers.novu]\nurl = "https://novu.test/mcp"\nbearer_token_env_var = "NOVU_TOKEN"\n',
    );
    const { servers, skipped } = resolveOperatorCodexMcpPlugins(envWith());
    expect(servers).toEqual([]);
    expect(skipped).toEqual([{ name: "novu", reason: "host env var NOVU_TOKEN is unset" }]);
  });

  it("copies static http_headers and resolves env_http_headers", () => {
    writeConfig(
      '[mcp_servers.svc]\nurl = "https://svc.test/mcp"\n' +
        'http_headers = { "X-Static" = "lit" }\n' +
        'env_http_headers = { "X-Token" = "SVC_TOKEN" }\n',
    );
    const { servers } = resolveOperatorCodexMcpPlugins(envWith({ SVC_TOKEN: "tkn" }));
    expect(servers[0]?.httpHeaders).toEqual({ "X-Static": "lit", "X-Token": "tkn" });
  });

  it("skips when an env_http_headers reference is unset", () => {
    writeConfig(
      '[mcp_servers.svc]\nurl = "https://svc.test/mcp"\nenv_http_headers = { "X-Token" = "SVC_TOKEN" }\n',
    );
    const { servers, skipped } = resolveOperatorCodexMcpPlugins(envWith());
    expect(servers).toEqual([]);
    expect(skipped).toEqual([{ name: "svc", reason: "host env var SVC_TOKEN is unset" }]);
  });

  it("skips an oauth-login server with no other auth", () => {
    writeConfig(
      '[mcp_servers.cf]\nurl = "https://cf.test/mcp"\noauth_resource = "https://api.cf"\n',
    );
    const { servers, skipped } = resolveOperatorCodexMcpPlugins(envWith());
    expect(servers).toEqual([]);
    expect(skipped).toEqual([{ name: "cf", reason: "requires interactive oauth login" }]);
  });

  it("applies the allowlist, dropping unlisted servers", () => {
    writeConfig(
      '[mcp_servers.exa]\nurl = "https://exa.test/mcp"\n' +
        '[mcp_servers.other]\nurl = "https://other.test/mcp"\n',
    );
    const { servers, skipped } = resolveOperatorCodexMcpPlugins(envWith(), { allowlist: ["exa"] });
    expect(servers.map((s) => s.name)).toEqual(["exa"]);
    expect(skipped).toEqual([{ name: "other", reason: "not in allowlist" }]);
  });
});

describe("buildSandboxMcpConfigToml", () => {
  const servers: ReadonlyArray<SandboxCodexMcpServer> = [
    { name: "exa", url: "https://exa.test/mcp", httpHeaders: {} },
    {
      name: "novu",
      url: "https://novu.test/mcp",
      httpHeaders: { Authorization: "Bearer t0ken" },
    },
  ];

  it("wraps a parseable block in the managed markers", () => {
    const toml = buildSandboxMcpConfigToml(servers);
    expect(toml.startsWith("# >>> synara-managed mcp")).toBe(true);
    expect(toml.trimEnd().endsWith("# <<< synara-managed mcp <<<")).toBe(true);

    const parsed = parseToml(toml) as { mcp_servers: Record<string, Record<string, unknown>> };
    expect(parsed.mcp_servers.exa?.url).toBe("https://exa.test/mcp");
    expect(parsed.mcp_servers.novu?.http_headers).toEqual({ Authorization: "Bearer t0ken" });
  });
});

describe("buildCodexMcpConfigCommand", () => {
  const servers: ReadonlyArray<SandboxCodexMcpServer> = [
    {
      name: "novu",
      url: "https://novu.test/mcp",
      httpHeaders: { Authorization: "Bearer s3cret" },
    },
  ];

  it("carries the secret only in the base64 arg, never in the visible script", () => {
    const command = buildCodexMcpConfigCommand(servers);
    expect(command.command).toBe("bash");
    const [, script, b64] = command.args;
    // The resolved token must not appear in the inline shell script.
    expect(script).not.toContain("s3cret");
    expect(script).toContain("codex-mcp-injected");
    // It rides as the base64 positional arg, which decodes to the managed block.
    const decoded = Buffer.from(b64 ?? "", "base64").toString("utf8");
    expect(decoded).toContain("Bearer s3cret");
    expect(decoded).toContain("# >>> synara-managed mcp");
  });

  it("strips a prior managed block so a resume does not duplicate tables", () => {
    const [, script] = buildCodexMcpConfigCommand(servers).args;
    expect(script).toContain('sed -i "/^# >>> synara-managed mcp/,/^# <<< synara-managed mcp/d"');
  });

  it("normalizes a missing trailing newline before appending the block", () => {
    const [, script] = buildCodexMcpConfigCommand(servers).args;
    // The begin marker must land at line start so the strip finds it next resume;
    // an image config with no trailing newline would otherwise glue it mid-line.
    expect(script).toContain('[ -n "$(tail -c1 "$cfg")" ]');
  });

  // Behavioral guard for the trailing-newline glue bug: against a pre-existing
  // config.toml with NO trailing newline (an image-shipped config — the file the
  // minimal-config write leaves untouched), two injections must leave exactly one
  // managed block and one mcp_servers table, not duplicates that a strict TOML
  // parser (codex's) rejects. Runs the real GNU-sed script, so it is Linux-only
  // (the sandbox target); macOS BSD `sed -i` has incompatible flag semantics.
  it.skipIf(process.platform !== "linux")(
    "stays idempotent across two injections onto a newline-less config",
    () => {
      const fakeHome = mkdtempSync(path.join(tmpdir(), "codex-mcp-sh-"));
      try {
        mkdirSync(path.join(fakeHome, ".codex"));
        const configPath = path.join(fakeHome, ".codex", "config.toml");
        // No trailing newline — the at-risk shape.
        writeFileSync(configPath, 'approval_policy = "never"', "utf8");

        const [, script, b64] = buildCodexMcpConfigCommand(servers).args;
        const run = () =>
          execFileSync("bash", ["-c", script ?? "", b64 ?? ""], {
            env: { HOME: fakeHome, PATH: process.env.PATH ?? "" },
          });
        run();
        run();

        const result = readFileSync(configPath, "utf8");
        const count = (sub: string) => result.split(sub).length - 1;
        expect(count("# >>> synara-managed mcp")).toBe(1);
        expect(count("[mcp_servers.novu]")).toBe(1);
        // The file must still parse (no duplicate-table error) and keep both the
        // original key and the injected server.
        const parsed = parseToml(result) as {
          approval_policy: string;
          mcp_servers: Record<string, unknown>;
        };
        expect(parsed.approval_policy).toBe("never");
        expect(Object.keys(parsed.mcp_servers)).toEqual(["novu"]);
      } finally {
        rmSync(fakeHome, { recursive: true, force: true });
      }
    },
  );
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountStartOptions } from "./accountStartOptions";
import { buildCodexProcessLaunchContext } from "../codexProcessEnv";
import { withoutProviderCredentialEnvironment } from "../providerChildEnvironment";

describe("managed account preparation", () => {
  let root: string | undefined;
  afterEach(() => {
    vi.unstubAllEnvs();
    if (root) rmSync(root, { recursive: true, force: true });
  });
  it("prepares Codex auth and MCP in the selected home without copying ambient credentials", async () => {
    root = mkdtempSync(join(tmpdir(), "synara-managed-codex-"));
    const native = join(root, "native");
    const managed = join(root, "managed");
    mkdirSync(native);
    mkdirSync(managed);
    writeFileSync(
      join(native, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "ambient-fixture-key" }),
    );
    vi.stubEnv("HOME", root);
    vi.stubEnv("CODEX_HOME", native);
    vi.stubEnv("OPENAI_API_KEY", "ambient-fixture-key");
    vi.stubEnv("SYNARA_HOME", join(root, "runtime"));
    const options = accountStartOptions(
      "codex",
      { codex: { binaryPath: "custom-codex", shadowHomePath: join(root, "obsolete-shadow") } },
      {
        ordinal: 2,
        generation: 3,
        profilePath: managed,
        environment: {
          CODEX_HOME: managed,
          CODEX_API_KEY: "",
          OPENAI_API_KEY: "managed-fixture-key",
          OPENAI_BASE_URL: "",
        },
      },
    )!.codex!;
    expect(options.binaryPath).toBe("custom-codex");
    expect(options.shadowHomePath).toBeUndefined();
    const launched = await buildCodexProcessLaunchContext({
      env: { ...withoutProviderCredentialEnvironment(process.env), ...options.environment },
      homePath: options.homePath!,
      accountId: options.accountId!,
      isolateProviderCredentials: true,
      explicitProviderEnvironment: options.environment!,
      appendConfigToml: '[mcp_servers.synara_test]\nurl = "http://127.0.0.1:12345/mcp"\n',
    });
    expect(launched.env.CODEX_SQLITE_HOME).toBe(managed);
    expect(launched.env.OPENAI_API_KEY).toBe("managed-fixture-key");
    const preparedHome = launched.env.CODEX_HOME!;
    expect(preparedHome).not.toBe(native);
    expect(readFileSync(join(preparedHome, "config.toml"), "utf8")).toContain(
      "mcp_servers.synara_test",
    );
    if (existsSync(join(preparedHome, "auth.json"))) {
      expect(readFileSync(join(preparedHome, "auth.json"), "utf8")).not.toContain(
        "ambient-fixture-key",
      );
    }
  });
});

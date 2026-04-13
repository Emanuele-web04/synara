import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import OS from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  parseCodexConfigActiveProviderEnvKey,
  parseCodexConfigModelProvider,
  parseCodexConfigProviderEnvKey,
  readActiveCodexProviderEnvKey,
} from "./codexConfig";

const tempDirs: string[] = [];

function makeTempCodexHome(configContent?: string): string {
  const tempDir = mkdtempSync(join(OS.tmpdir(), "t3-codex-config-"));
  tempDirs.push(tempDir);

  if (configContent !== undefined) {
    writeFileSync(join(tempDir, "config.toml"), configContent, "utf8");
  }

  return tempDir;
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("parseCodexConfigModelProvider", () => {
  it("reads the top-level model provider", () => {
    expect(
      parseCodexConfigModelProvider('model = "gpt-5.3-codex"\nmodel_provider = "azure"\n'),
    ).toBe("azure");
  });

  it("ignores model_provider declarations inside nested sections", () => {
    expect(
      parseCodexConfigModelProvider(
        ["[model_providers.portkey]", 'model_provider = "should-be-ignored"'].join("\n"),
      ),
    ).toBeUndefined();
  });
});

describe("parseCodexConfigProviderEnvKey", () => {
  it("reads env_key from the matching model provider section", () => {
    expect(
      parseCodexConfigProviderEnvKey(
        [
          'model_provider = "portkey"',
          "",
          "[model_providers.portkey]",
          'env_key = "PORTKEY_API_KEY"',
        ].join("\n"),
        "portkey",
      ),
    ).toBe("PORTKEY_API_KEY");
  });

  it("supports quoted provider section names", () => {
    expect(
      parseCodexConfigProviderEnvKey(
        [
          'model_provider = "my-company-proxy"',
          "",
          '[model_providers."my-company-proxy"]',
          'env_key = "MY_COMPANY_PROXY_KEY"',
        ].join("\n"),
        "my-company-proxy",
      ),
    ).toBe("MY_COMPANY_PROXY_KEY");
  });
});

describe("parseCodexConfigActiveProviderEnvKey", () => {
  it("returns the active custom provider env_key", () => {
    expect(
      parseCodexConfigActiveProviderEnvKey(
        [
          'model_provider = "azure"',
          "",
          "[model_providers.azure]",
          'env_key = "AZURE_OPENAI_API_KEY"',
        ].join("\n"),
      ),
    ).toBe("AZURE_OPENAI_API_KEY");
  });

  it("returns undefined for the default openai provider", () => {
    expect(parseCodexConfigActiveProviderEnvKey('model_provider = "openai"\n')).toBeUndefined();
  });
});

describe("readActiveCodexProviderEnvKey", () => {
  it("reads the active env_key from CODEX_HOME/config.toml", () => {
    const codexHome = makeTempCodexHome(
      [
        'model_provider = "my-company-proxy"',
        "",
        '[model_providers."my-company-proxy"]',
        'env_key = "MY_COMPANY_PROXY_KEY"',
      ].join("\n"),
    );

    expect(readActiveCodexProviderEnvKey({ CODEX_HOME: codexHome })).toBe("MY_COMPANY_PROXY_KEY");
  });

  it("returns undefined when config.toml is missing", () => {
    const codexHome = makeTempCodexHome();
    expect(readActiveCodexProviderEnvKey({ CODEX_HOME: codexHome })).toBeUndefined();
  });
});

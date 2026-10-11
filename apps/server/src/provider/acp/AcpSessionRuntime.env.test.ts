import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildAcpSpawnProcessEnv } from "./AcpSessionRuntime.ts";

const testHomes: string[] = [];

afterEach(() => {
  for (const home of testHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function isolatedPaths() {
  const root = mkdtempSync(path.join(os.tmpdir(), "synara-acp-env-test-"));
  testHomes.push(root);
  return { homeDir: path.join(root, "home"), isolationRootDir: path.join(root, "isolation") };
}

describe("buildAcpSpawnProcessEnv", () => {
  it("scrubs ambient provider credentials before applying ACP flags and selected credentials", () => {
    const env = buildAcpSpawnProcessEnv(
      {
        command: "grok",
        args: ["agent", "stdio"],
        env: { NO_BROWSER: "true" },
        providerEnvironment: {
          driver: "grok",
          instanceId: "grok_work",
          ...isolatedPaths(),
          environment: { GROK_CODE_XAI_API_KEY: "selected-account-b" },
        },
      },
      {
        PATH: "/usr/bin",
        HTTPS_PROXY: "http://proxy.example",
        XAI_API_KEY: "ambient-account-a",
      },
    );

    expect(env.XAI_API_KEY).toBeUndefined();
    expect(env.GROK_CODE_XAI_API_KEY).toBe("selected-account-b");
    expect(env.NO_BROWSER).toBe("true");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HTTPS_PROXY).toBe("http://proxy.example");
  });

  it("grants declared Cursor credentials from selected provider environment", () => {
    const env = buildAcpSpawnProcessEnv(
      {
        command: "cursor-agent",
        args: [],
        env: { NO_BROWSER: "true" },
        providerEnvironment: {
          driver: "cursor",
          instanceId: "cursor_work",
          environment: {
            HOME: "C:\\acp-test-home",
            USERPROFILE: "C:\\acp-test-home",
            cursor_api_key: "selected-cursor",
          },
        },
      },
      { PATH: "/usr/bin", CURSOR_API_KEY: "ambient-cursor", ANTHROPIC_API_KEY: "unrelated" },
      "win32",
    );
    expect(env.CURSOR_API_KEY).toBe("selected-cursor");
    expect(env.cursor_api_key).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("scrubs generic ACP credential variants while retaining explicit selected variants", () => {
    const env = buildAcpSpawnProcessEnv(
      {
        command: "custom-acp",
        args: [],
        env: { ANTHROPIC_CLIENT_SECRET: "selected-secret" },
      },
      {
        PATH: "/usr/bin",
        ANTHROPIC_CLIENT_SECRET: "ambient-secret",
        COHERE_API_TOKEN: "ambient-token",
        AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://metadata",
      },
    );
    expect(env.PATH).toBe("/usr/bin");
    expect(env.ANTHROPIC_CLIENT_SECRET).toBe("selected-secret");
    expect(env.COHERE_API_TOKEN).toBeUndefined();
    expect(env.AWS_CONTAINER_CREDENTIALS_FULL_URI).toBeUndefined();
  });

  it("does not restore credentials for a generic ACP process without provider authority", () => {
    const env = buildAcpSpawnProcessEnv(
      { command: "custom-acp", args: [] },
      { PATH: "/usr/bin", OPENAI_API_KEY: "ambient-openai" },
    );
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("preserves legacy generic ACP environment overlay behavior", () => {
    const env = buildAcpSpawnProcessEnv(
      { command: "custom-acp", args: [], env: { CUSTOM_VALUE: "selected" } },
      { PATH: "/usr/bin", CUSTOM_VALUE: "ambient" },
    );

    expect(env).toEqual({ PATH: "/usr/bin", CUSTOM_VALUE: "selected" });
  });
});

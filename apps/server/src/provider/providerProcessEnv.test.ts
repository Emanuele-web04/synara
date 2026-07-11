import { describe, expect, it } from "vitest";

import { buildProviderProcessEnv } from "./providerProcessEnv.ts";

describe("buildProviderProcessEnv", () => {
  it("scrubs ambient Grok aliases before applying a selected instance environment", () => {
    const env = buildProviderProcessEnv({
      driver: "grok",
      instanceId: "grok_work",
      env: {
        PATH: "/usr/bin",
        HTTPS_PROXY: "http://proxy.example",
        NODE_EXTRA_CA_CERTS: "/certs/company.pem",
        XAI_API_KEY: "ambient-account-a",
        XAI_ACCOUNT_ID: "ambient-account-a-id",
        GROK_CODE_XAI_API_KEY: "ambient-legacy-account-a",
      },
      environment: { GROK_CODE_XAI_API_KEY: "selected-account-b" },
    });

    expect(env.XAI_API_KEY).toBeUndefined();
    expect(env.XAI_ACCOUNT_ID).toBeUndefined();
    expect(env.GROK_CODE_XAI_API_KEY).toBe("selected-account-b");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HTTPS_PROXY).toBe("http://proxy.example");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/certs/company.pem");
  });

  it("treats a non-default instance as an account boundary without explicit environment", () => {
    const env = buildProviderProcessEnv({
      driver: "cursor",
      instanceId: "cursor_work",
      env: {
        PATH: "/usr/bin",
        CURSOR_API_KEY: "ambient-account-a",
        CURSOR_CONFIG_DIR: "/accounts/a/cursor",
      },
    });

    expect(env.CURSOR_API_KEY).toBeUndefined();
    expect(env.CURSOR_CONFIG_DIR).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("preserves the ambient environment for the default instance without an explicit overlay", () => {
    const ambient = { PATH: "/usr/bin", XAI_API_KEY: "ambient-default-account" };
    const env = buildProviderProcessEnv({ driver: "grok", instanceId: "grok", env: ambient });

    expect(env).toBe(ambient);
    expect(env.XAI_API_KEY).toBe("ambient-default-account");
  });

  it("treats an explicit empty environment on the default instance as a scrub boundary", () => {
    const env = buildProviderProcessEnv({
      driver: "grok",
      instanceId: "grok",
      env: { PATH: "/usr/bin", XAI_API_KEY: "ambient-default-account" },
      environment: {},
    });

    expect(env.XAI_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("keeps ambient default credentials when applying non-account runtime flags", () => {
    const env = buildProviderProcessEnv({
      driver: "cursor",
      instanceId: "cursor",
      env: { CURSOR_API_KEY: "ambient-default-account" },
      overlay: { NO_BROWSER: "true" },
    });

    expect(env.CURSOR_API_KEY).toBe("ambient-default-account");
    expect(env.NO_BROWSER).toBe("true");
  });

  it("scrubs Gemini auth and routing inputs while retaining unrelated network environment", () => {
    const env = buildProviderProcessEnv({
      driver: "gemini",
      env: {
        GEMINI_API_KEY: "ambient-account-a",
        GOOGLE_APPLICATION_CREDENTIALS: "/accounts/a.json",
        GOOGLE_CLOUD_PROJECT: "account-a-project",
        ALL_PROXY: "socks5://proxy.example",
      },
      environment: { GOOGLE_API_KEY: "selected-account-b" },
    });

    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(env.GOOGLE_CLOUD_PROJECT).toBeUndefined();
    expect(env.GOOGLE_API_KEY).toBe("selected-account-b");
    expect(env.ALL_PROXY).toBe("socks5://proxy.example");
  });

  it("scrubs upstream model credentials for OpenCode-compatible and Pi instances", () => {
    const ambient = {
      OPENAI_API_KEY: "ambient-openai-account",
      AWS_PROFILE: "ambient-bedrock-account",
      OPENCODE_CONFIG_CONTENT: '{"provider":{"openai":{}}}',
      PATH: "/usr/bin",
    };

    const opencodeEnv = buildProviderProcessEnv({
      driver: "opencode",
      instanceId: "opencode_work",
      env: ambient,
      environment: { ANTHROPIC_API_KEY: "selected-anthropic-account" },
    });
    const piEnv = buildProviderProcessEnv({
      driver: "pi",
      instanceId: "pi_work",
      env: ambient,
    });

    expect(opencodeEnv.OPENAI_API_KEY).toBeUndefined();
    expect(opencodeEnv.AWS_PROFILE).toBeUndefined();
    expect(opencodeEnv.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(opencodeEnv.ANTHROPIC_API_KEY).toBe("selected-anthropic-account");
    expect(piEnv.OPENAI_API_KEY).toBeUndefined();
    expect(piEnv.AWS_PROFILE).toBeUndefined();
    expect(piEnv.PATH).toBe("/usr/bin");
  });

  it("collapses Windows aliases before scrub and selected overlay", () => {
    const env = buildProviderProcessEnv({
      driver: "grok",
      instanceId: "grok_work",
      platform: "win32",
      env: {
        Path: "C:\\Windows\\System32",
        xai_api_key: "ambient-account-a",
        xai_account_id: "ambient-account-a-id",
        XAI_API_KEY: "ambient-alias-account-a",
      },
      environment: { grok_code_xai_api_key: "selected-account-b" },
    });

    expect(env.XAI_API_KEY).toBeUndefined();
    expect(env.XAI_ACCOUNT_ID).toBeUndefined();
    expect(env.GROK_CODE_XAI_API_KEY).toBe("selected-account-b");
    expect(env.PATH).toBe("C:\\Windows\\System32");
    expect(Object.keys(env)).not.toContain("grok_code_xai_api_key");
  });

  it("removes mixed-case Windows Cursor config aliases", () => {
    const env = buildProviderProcessEnv({
      driver: "cursor",
      instanceId: "cursor_work",
      platform: "win32",
      env: {
        Path: "C:\\Windows\\System32",
        cursor_api_key: "ambient-account-a",
        Cursor_Config_Dir: "C:\\Accounts\\A\\Cursor",
      },
      environment: { CURSOR_API_KEY: "selected-account-b" },
      overlay: { NO_BROWSER: "true" },
    });

    expect(env.CURSOR_API_KEY).toBe("selected-account-b");
    expect(env.CURSOR_CONFIG_DIR).toBeUndefined();
    expect(env.PATH).toBe("C:\\Windows\\System32");
    expect(env.NO_BROWSER).toBe("true");
    expect(Object.keys(env)).not.toContain("Cursor_Config_Dir");
  });
});

import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildProviderProcessEnv, providerIsolatedHomePath } from "./providerProcessEnv.ts";

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
    expect(env.CURSOR_CONFIG_DIR).toContain("provider-homes/cursor/");
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

  it.each(["opencode", "kilo"] as const)(
    "scrubs extended %s provider credentials and routing metadata",
    (driver) => {
      const env = buildProviderProcessEnv({
        driver,
        instanceId: `${driver}_work`,
        env: {
          PERPLEXITY_API_KEY: "ambient-perplexity",
          COHERE_API_KEY: "ambient-cohere",
          TOGETHER_AI_API_KEY: "ambient-together",
          CLOUDFLARE_API_TOKEN: "ambient-cloudflare-token",
          CLOUDFLARE_ACCOUNT_ID: "ambient-cloudflare-account",
          CLOUDFLARE_GATEWAY_ID: "ambient-cloudflare-gateway",
          PATH: "/usr/bin",
        },
      });

      expect(env.PERPLEXITY_API_KEY).toBeUndefined();
      expect(env.COHERE_API_KEY).toBeUndefined();
      expect(env.TOGETHER_AI_API_KEY).toBeUndefined();
      expect(env.CLOUDFLARE_API_TOKEN).toBeUndefined();
      expect(env.CLOUDFLARE_ACCOUNT_ID).toBeUndefined();
      expect(env.CLOUDFLARE_GATEWAY_ID).toBeUndefined();
      expect(env.PATH).toBe("/usr/bin");
    },
  );

  it.each(["cursor", "gemini", "grok", "kilo", "opencode"] as const)(
    "moves explicit-empty %s instances off ambient HOME and XDG account stores",
    (driver) => {
      const isolationRootDir = mkdtempSync(join(tmpdir(), "synara-provider-home-"));
      const instanceId = driver;
      const env = buildProviderProcessEnv({
        driver,
        instanceId,
        isolationRootDir,
        env: {
          HOME: "/accounts/ambient-a",
          XDG_DATA_HOME: "/accounts/ambient-a/data",
          XDG_CONFIG_HOME: "/accounts/ambient-a/config",
          XDG_STATE_HOME: "/accounts/ambient-a/state",
          XDG_CACHE_HOME: "/accounts/ambient-a/cache",
          PATH: "/usr/bin",
        },
        environment: {},
      });
      const isolatedHome = providerIsolatedHomePath({
        driver,
        instanceId,
        isolationRootDir,
      });

      expect(env.HOME).toBe(isolatedHome);
      expect(env.XDG_DATA_HOME).toBe(`${isolatedHome}/.local/share`);
      expect(env.XDG_CONFIG_HOME).toBe(`${isolatedHome}/.config`);
      expect(env.XDG_STATE_HOME).toBe(`${isolatedHome}/.local/state`);
      expect(env.XDG_CACHE_HOME).toBe(`${isolatedHome}/.cache`);
      expect(env.PATH).toBe("/usr/bin");
    },
  );

  it("lets an explicit instance HOME override the synthetic root without retaining ambient XDG", () => {
    const env = buildProviderProcessEnv({
      driver: "opencode",
      instanceId: "opencode_work",
      isolationRootDir: "/synara/state",
      env: {
        HOME: "/accounts/ambient-a",
        XDG_DATA_HOME: "/accounts/ambient-a/data",
      },
      environment: { HOME: "/accounts/selected-b" },
    });

    expect(env.HOME).toBe("/accounts/selected-b");
    expect(env.XDG_DATA_HOME).toBe("/accounts/selected-b/.local/share");
  });

  it.each(["", "   ", "relative/home"])(
    "rejects invalid selected HOME %j and retains absolute synthetic roots",
    (selectedHome) => {
      const root = mkdtempSync(join(tmpdir(), "synara-invalid-provider-home-"));
      const env = buildProviderProcessEnv({
        driver: "cursor",
        instanceId: "cursor_work",
        isolationRootDir: root,
        environment: {
          HOME: selectedHome,
          XDG_CONFIG_HOME: "relative/config",
          CURSOR_CONFIG_DIR: "relative/cursor",
        },
      });
      expect(env.HOME).toContain(`${root}/provider-homes/cursor/`);
      expect(env.XDG_CONFIG_HOME).toContain(`${root}/provider-homes/cursor/`);
      expect(env.CURSOR_CONFIG_DIR).toContain(`${root}/provider-homes/cursor/`);
    },
  );

  it("rejects invalid selected Grok storage roots", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-invalid-grok-home-"));
    const env = buildProviderProcessEnv({
      driver: "grok",
      instanceId: "grok_work",
      isolationRootDir: root,
      environment: { GROK_HOME: "relative/grok", GROK_AUTH_PATH: " " },
    });
    expect(env.GROK_HOME).toContain(`${root}/provider-homes/grok/`);
    expect(env.GROK_AUTH_PATH).toContain(`${root}/provider-homes/grok/`);
  });

  it("removes invalid selected Pi agent and session roots", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-invalid-pi-home-"));
    const env = buildProviderProcessEnv({
      driver: "pi",
      instanceId: "pi_work",
      isolationRootDir: root,
      environment: {
        PI_CODING_AGENT_DIR: "relative/agent",
        PI_CODING_AGENT_SESSION_DIR: " ",
      },
    });
    expect(env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(env.PI_CODING_AGENT_SESSION_DIR).toBeUndefined();
    expect(env.HOME).toContain(`${root}/provider-homes/pi/`);
  });

  it("inherits only safe system variables at an account boundary", () => {
    const env = buildProviderProcessEnv({
      driver: "opencode",
      instanceId: "opencode_work",
      isolationRootDir: mkdtempSync(join(tmpdir(), "synara-provider-safe-env-")),
      env: { PATH: "/usr/bin", LANG: "en_US.UTF-8", CUSTOM_SECRET: "ambient-secret" },
      environment: {},
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.CUSTOM_SECRET).toBeUndefined();
  });

  it("pins provider-owned file credential switches and preserves explicit Grok roots", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-provider-switches-"));
    const cursor = buildProviderProcessEnv({
      driver: "cursor",
      instanceId: "cursor_work",
      isolationRootDir: root,
      environment: { AGENT_CLI_CREDENTIAL_STORE: "keychain" },
    });
    const gemini = buildProviderProcessEnv({
      driver: "gemini",
      instanceId: "gemini_work",
      isolationRootDir: root,
      environment: { GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: "true" },
    });
    const grok = buildProviderProcessEnv({
      driver: "grok",
      instanceId: "grok_work",
      isolationRootDir: root,
      environment: { GROK_HOME: "/selected/grok", GROK_AUTH_PATH: "/selected/auth.json" },
    });
    expect(cursor.AGENT_CLI_CREDENTIAL_STORE).toBe("file");
    expect(gemini.GEMINI_FORCE_FILE_STORAGE).toBe("true");
    expect(gemini.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE).toBeUndefined();
    expect(grok.GROK_HOME).toBe("/selected/grok");
    expect(grok.GROK_AUTH_PATH).toBe("/selected/auth.json");
  });

  it("tightens an existing synthetic credential home to owner-only permissions", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-provider-permissions-"));
    const home = providerIsolatedHomePath({
      driver: "cursor",
      instanceId: "cursor_work",
      isolationRootDir: root,
    });
    buildProviderProcessEnv({
      driver: "cursor",
      instanceId: "cursor_work",
      isolationRootDir: root,
      environment: {},
    });
    chmodSync(home, 0o755);
    buildProviderProcessEnv({
      driver: "cursor",
      instanceId: "cursor_work",
      isolationRootDir: root,
      environment: {},
    });
    expect(statSync(home).mode & 0o777).toBe(0o700);
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
    expect(env.CURSOR_CONFIG_DIR).toContain("provider-homes\\cursor\\");
    expect(env.PATH).toBe("C:\\Windows\\System32");
    expect(env.NO_BROWSER).toBe("true");
    expect(Object.keys(env)).not.toContain("Cursor_Config_Dir");
  });
});

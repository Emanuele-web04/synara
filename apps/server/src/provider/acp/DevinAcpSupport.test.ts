/**
 * Tests for Devin ACP support helpers — env filtering, spawn input construction,
 * auth method resolution, and API key env detection.
 *
 * @module DevinAcpSupportTest
 */
import { describe, it, assert } from "@effect/vitest";
import { Effect } from "effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  buildDevinAcpSpawnInput,
  hasDevinApiKeyEnv,
  resolveDevinAcpAuthMethodId,
  DEVIN_WINDSURF_API_KEY_AUTH_METHOD_ID,
  DEVIN_API_KEY_ENV_KEYS,
} from "./DevinAcpSupport.ts";

describe("buildDevinAcpSpawnInput", () => {
  it("uses 'devin' as the default command when binaryPath is absent", () => {
    const result = buildDevinAcpSpawnInput(undefined, "/tmp/project");
    assert.strictEqual(result.command, "devin");
    assert.deepStrictEqual(result.args, ["acp"]);
    assert.strictEqual(result.cwd, "/tmp/project");
  });

  it("uses 'devin' when binaryPath is null", () => {
    const result = buildDevinAcpSpawnInput(null, "/tmp/project");
    assert.strictEqual(result.command, "devin");
  });

  it("uses 'devin' when binaryPath is empty string", () => {
    const result = buildDevinAcpSpawnInput({ binaryPath: "" }, "/tmp/project");
    assert.strictEqual(result.command, "devin");
  });

  it("uses 'devin' when binaryPath is whitespace-only", () => {
    const result = buildDevinAcpSpawnInput({ binaryPath: "   " }, "/tmp/project");
    assert.strictEqual(result.command, "devin");
  });

  it("uses the configured binaryPath when set", () => {
    const result = buildDevinAcpSpawnInput({ binaryPath: "/usr/local/bin/devin" }, "/tmp/project");
    assert.strictEqual(result.command, "/usr/local/bin/devin");
  });

  it("trims whitespace from binaryPath", () => {
    const result = buildDevinAcpSpawnInput(
      { binaryPath: "  /usr/local/bin/devin  " },
      "/tmp/project",
    );
    assert.strictEqual(result.command, "/usr/local/bin/devin");
  });

  it("always passes ['acp'] as args", () => {
    const result = buildDevinAcpSpawnInput(undefined, "/tmp/project");
    assert.deepStrictEqual(result.args, ["acp"]);
  });

  it("passes cwd through unchanged", () => {
    const result = buildDevinAcpSpawnInput(undefined, "/complex/path/with spaces");
    assert.strictEqual(result.cwd, "/complex/path/with spaces");
  });

  it("produces an env object (not undefined)", () => {
    const result = buildDevinAcpSpawnInput(undefined, "/tmp/project");
    assert.isObject(result.env);
    assert.ok(result.env !== null);
  });
});

describe("buildDevinAcpSpawnInput — env allowlist filtering", () => {
  // Save and restore process.env around each test to avoid leaking mutations.
  function withEnv(env: Record<string, string | undefined>, fn: () => void) {
    const saved: Record<string, string | undefined> = {};
    for (const key of Object.keys(env)) {
      saved[key] = process.env[key];
      if (env[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = env[key];
      }
    }
    try {
      fn();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  }

  it("includes PATH from the allowlist", () => {
    withEnv({ PATH: "/usr/bin:/bin", UNRELATED_VAR: "drop" }, () => {
      const result = buildDevinAcpSpawnInput(undefined, "/tmp");
      assert.strictEqual(result.env.PATH, "/usr/bin:/bin");
      assert.strictEqual(result.env.UNRELATED_VAR, undefined);
    });
  });

  it("includes HOME from the allowlist", () => {
    withEnv({ HOME: "/home/user" }, () => {
      const result = buildDevinAcpSpawnInput(undefined, "/tmp");
      assert.strictEqual(result.env.HOME, "/home/user");
    });
  });

  it("includes vars with DEVIN_ prefix", () => {
    withEnv({ DEVIN_API_KEY: "secret", DEVIN_BASE_URL: "https://devin.ai" }, () => {
      const result = buildDevinAcpSpawnInput(undefined, "/tmp");
      assert.strictEqual(result.env.DEVIN_API_KEY, "secret");
      assert.strictEqual(result.env.DEVIN_BASE_URL, "https://devin.ai");
    });
  });

  it("includes vars with WINDSURF_ prefix", () => {
    withEnv({ WINDSURF_API_KEY: "wk-123", WINDSURF_ORG: "org-1" }, () => {
      const result = buildDevinAcpSpawnInput(undefined, "/tmp");
      assert.strictEqual(result.env.WINDSURF_API_KEY, "wk-123");
      assert.strictEqual(result.env.WINDSURF_ORG, "org-1");
    });
  });

  it("excludes vars that don't match prefix or allowlist", () => {
    withEnv(
      {
        SECRET_TOKEN: "leak-me",
        AWS_CREDENTIALS: "leak-me-too",
        RANDOM_VAR: "nope",
      },
      () => {
        const result = buildDevinAcpSpawnInput(undefined, "/tmp");
        assert.strictEqual(result.env.SECRET_TOKEN, undefined);
        assert.strictEqual(result.env.AWS_CREDENTIALS, undefined);
        assert.strictEqual(result.env.RANDOM_VAR, undefined);
      },
    );
  });

  it("includes Windows-specific allowlist vars", () => {
    withEnv(
      {
        USERPROFILE: "C:\\Users\\dev",
        APPDATA: "C:\\Users\\dev\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
        TEMP: "C:\\Users\\dev\\AppData\\Local\\Temp",
        TMP: "C:\\Users\\dev\\AppData\\Local\\Temp",
        SystemRoot: "C:\\Windows",
        PATHEXT: ".EXE;.BAT;.CMD",
        COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      },
      () => {
        const result = buildDevinAcpSpawnInput(undefined, "/tmp");
        assert.strictEqual(result.env.USERPROFILE, "C:\\Users\\dev");
        assert.strictEqual(result.env.APPDATA, "C:\\Users\\dev\\AppData\\Roaming");
        assert.strictEqual(result.env.LOCALAPPDATA, "C:\\Users\\dev\\AppData\\Local");
        assert.strictEqual(result.env.TEMP, "C:\\Users\\dev\\AppData\\Local\\Temp");
        assert.strictEqual(result.env.TMP, "C:\\Users\\dev\\AppData\\Local\\Temp");
        assert.strictEqual(result.env.SystemRoot, "C:\\Windows");
        assert.strictEqual(result.env.PATHEXT, ".EXE;.BAT;.CMD");
        assert.strictEqual(result.env.COMSPEC, "C:\\Windows\\System32\\cmd.exe");
      },
    );
  });

  it("includes proxy and TLS vars from the allowlist", () => {
    withEnv(
      {
        HTTPS_PROXY: "https://proxy.corp:3128",
        HTTP_PROXY: "http://proxy.corp:3128",
        NO_PROXY: "localhost,127.0.0.1",
        NODE_EXTRA_CA_CERTS: "/etc/ssl/corp-ca.pem",
        SSL_CERT_FILE: "/etc/ssl/corp-ca.pem",
      },
      () => {
        const result = buildDevinAcpSpawnInput(undefined, "/tmp");
        assert.strictEqual(result.env.HTTPS_PROXY, "https://proxy.corp:3128");
        assert.strictEqual(result.env.HTTP_PROXY, "http://proxy.corp:3128");
        assert.strictEqual(result.env.NO_PROXY, "localhost,127.0.0.1");
        assert.strictEqual(result.env.NODE_EXTRA_CA_CERTS, "/etc/ssl/corp-ca.pem");
        assert.strictEqual(result.env.SSL_CERT_FILE, "/etc/ssl/corp-ca.pem");
      },
    );
  });

  it("includes XDG and locale vars from the allowlist", () => {
    withEnv(
      {
        XDG_RUNTIME_DIR: "/run/user/1000",
        XDG_CONFIG_HOME: "/home/user/.config",
        XDG_DATA_HOME: "/home/user/.local/share",
        LANG: "en_US.UTF-8",
        TERM: "xterm-256color",
        SHELL: "/bin/zsh",
        USER: "dev",
        TMPDIR: "/tmp",
      },
      () => {
        const result = buildDevinAcpSpawnInput(undefined, "/tmp");
        assert.strictEqual(result.env.XDG_RUNTIME_DIR, "/run/user/1000");
        assert.strictEqual(result.env.XDG_CONFIG_HOME, "/home/user/.config");
        assert.strictEqual(result.env.XDG_DATA_HOME, "/home/user/.local/share");
        assert.strictEqual(result.env.LANG, "en_US.UTF-8");
        assert.strictEqual(result.env.TERM, "xterm-256color");
        assert.strictEqual(result.env.SHELL, "/bin/zsh");
        assert.strictEqual(result.env.USER, "dev");
        assert.strictEqual(result.env.TMPDIR, "/tmp");
      },
    );
  });
});

describe("hasDevinApiKeyEnv", () => {
  it("returns false when WINDSURF_API_KEY is not set", () => {
    const saved = process.env.WINDSURF_API_KEY;
    delete process.env.WINDSURF_API_KEY;
    try {
      assert.strictEqual(hasDevinApiKeyEnv(), false);
    } finally {
      if (saved !== undefined) process.env.WINDSURF_API_KEY = saved;
    }
  });

  it("returns true when WINDSURF_API_KEY is set to a non-empty value", () => {
    const saved = process.env.WINDSURF_API_KEY;
    process.env.WINDSURF_API_KEY = "wk-test-key";
    try {
      assert.strictEqual(hasDevinApiKeyEnv(), true);
    } finally {
      if (saved === undefined) delete process.env.WINDSURF_API_KEY;
      else process.env.WINDSURF_API_KEY = saved;
    }
  });

  it("returns false when WINDSURF_API_KEY is empty string", () => {
    const saved = process.env.WINDSURF_API_KEY;
    process.env.WINDSURF_API_KEY = "";
    try {
      assert.strictEqual(hasDevinApiKeyEnv(), false);
    } finally {
      if (saved === undefined) delete process.env.WINDSURF_API_KEY;
      else process.env.WINDSURF_API_KEY = saved;
    }
  });

  it("returns false when WINDSURF_API_KEY is whitespace-only", () => {
    const saved = process.env.WINDSURF_API_KEY;
    process.env.WINDSURF_API_KEY = "   ";
    try {
      assert.strictEqual(hasDevinApiKeyEnv(), false);
    } finally {
      if (saved === undefined) delete process.env.WINDSURF_API_KEY;
      else process.env.WINDSURF_API_KEY = saved;
    }
  });

  it("accepts a custom env object", () => {
    assert.strictEqual(hasDevinApiKeyEnv({ WINDSURF_API_KEY: "key" }), true);
    assert.strictEqual(hasDevinApiKeyEnv({}), false);
    assert.strictEqual(hasDevinApiKeyEnv({ WINDSURF_API_KEY: "" }), false);
    assert.strictEqual(hasDevinApiKeyEnv({ WINDSURF_API_KEY: "  " }), false);
  });

  it("DEVIN_API_KEY_ENV_KEYS contains only WINDSURF_API_KEY", () => {
    assert.deepStrictEqual([...DEVIN_API_KEY_ENV_KEYS], ["WINDSURF_API_KEY"]);
  });
});

describe("resolveDevinAcpAuthMethodId", () => {
  it("returns windsurf-api-key when that method is advertised", () =>
    Effect.gen(function* () {
      const method = yield* resolveDevinAcpAuthMethodId({
        protocolVersion: 1,
        authMethods: [{ id: "windsurf-api-key", name: "Windsurf API Key" }],
      });
      assert.strictEqual(method, DEVIN_WINDSURF_API_KEY_AUTH_METHOD_ID);
    }));

  it("returns windsurf-api-key when multiple methods are advertised", () =>
    Effect.gen(function* () {
      const method = yield* resolveDevinAcpAuthMethodId({
        protocolVersion: 1,
        authMethods: [
          { id: "browser_login", name: "Browser login" },
          { id: "windsurf-api-key", name: "Windsurf API Key" },
          { id: "oauth", name: "OAuth" },
        ],
      });
      assert.strictEqual(method, "windsurf-api-key");
    }));

  it("fails with AcpRequestError when authMethods is undefined", () =>
    Effect.gen(function* () {
      // When authMethods is undefined, the set is empty, so this should fail.
      const error = yield* resolveDevinAcpAuthMethodId({
        protocolVersion: 1,
      }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "AcpRequestError");
    }));

  it("fails with AcpRequestError when authMethods is empty array", () =>
    Effect.gen(function* () {
      const error = yield* resolveDevinAcpAuthMethodId({
        protocolVersion: 1,
        authMethods: [],
      }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "AcpRequestError");
    }));

  it("trims whitespace in auth method IDs when matching", () =>
    Effect.gen(function* () {
      const method = yield* resolveDevinAcpAuthMethodId({
        protocolVersion: 1,
        authMethods: [{ id: "  windsurf-api-key  ", name: "Windsurf API Key" }],
      });
      assert.strictEqual(method, "windsurf-api-key");
    }));

  it("fails with AcpRequestError when no supported method is advertised", () =>
    Effect.gen(function* () {
      const error = yield* resolveDevinAcpAuthMethodId({
        protocolVersion: 1,
        authMethods: [{ id: "browser_login", name: "Browser login" }],
      }).pipe(Effect.flip);

      assert.strictEqual(error._tag, "AcpRequestError");
      assert.strictEqual(error.code, -32602);
    }));

  it("includes the advertised auth method IDs in the error data", () =>
    Effect.gen(function* () {
      const error = yield* resolveDevinAcpAuthMethodId({
        protocolVersion: 1,
        authMethods: [
          { id: "browser_login", name: "Browser login" },
          { id: "oauth", name: "OAuth" },
        ],
      }).pipe(Effect.flip);

      const data = error.data as { authMethods: string[]; detail: string };
      assert.deepStrictEqual(data.authMethods, ["browser_login", "oauth"]);
    }));

  it("error detail mentions 'devin auth login' when WINDSURF_API_KEY is not set", () =>
    Effect.gen(function* () {
      const saved = process.env.WINDSURF_API_KEY;
      delete process.env.WINDSURF_API_KEY;
      try {
        const error = yield* resolveDevinAcpAuthMethodId({
          protocolVersion: 1,
          authMethods: [{ id: "browser_login", name: "Browser login" }],
        }).pipe(Effect.flip);

        const data = error.data as { detail: string };
        assert.match(data.detail, /devin auth login/);
        assert.match(data.detail, /WINDSURF_API_KEY/);
      } finally {
        if (saved !== undefined) process.env.WINDSURF_API_KEY = saved;
      }
    }));

  it("error detail mentions 'did not advertise Windsurf API key' when WINDSURF_API_KEY is set", () =>
    Effect.gen(function* () {
      const saved = process.env.WINDSURF_API_KEY;
      process.env.WINDSURF_API_KEY = "test-key";
      try {
        const error = yield* resolveDevinAcpAuthMethodId({
          protocolVersion: 1,
          authMethods: [{ id: "browser_login", name: "Browser login" }],
        }).pipe(Effect.flip);

        const data = error.data as { detail: string };
        assert.match(data.detail, /did not advertise Windsurf API key/);
      } finally {
        if (saved === undefined) delete process.env.WINDSURF_API_KEY;
        else process.env.WINDSURF_API_KEY = saved;
      }
    }));
});

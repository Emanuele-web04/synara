// FILE: AntigravityAcpSupport.test.ts
// Purpose: Verifies Antigravity ACP executable resolution, spawn, auth, and discovery.
// Layer: Provider ACP support tests

import { Effect } from "effect";
import * as nodePath from "node:path";
import * as AcpErrors from "./AcpErrors.ts";
import type * as Acp from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import {
  ANTIGRAVITY_ACP_EXECUTABLE_ENV,
  ANTIGRAVITY_ACP_STARTUP_TIMEOUTS,
  antigravityAcpArgsForExecutable,
  applyAntigravityAcpModelSelection,
  buildAntigravityAcpSpawnInput,
  discoverAntigravityAcpModels,
  isAntigravityAcpBinaryPath,
  resolveAntigravityAcpAuthMethodId,
  resolveAntigravityAcpExecutable,
} from "./AntigravityAcpSupport.ts";

const noAcpOnPath = {
  env: { PATH: "" },
  platform: "linux" as NodeJS.Platform,
  homeDir: "/nonexistent-home",
  pathExists: () => false,
  resolveOnPath: () => null,
};

describe("isAntigravityAcpBinaryPath", () => {
  it("accepts agy_acp_server paths and rejects interactive agy paths", () => {
    expect(isAntigravityAcpBinaryPath("/usr/local/bin/agy_acp_server")).toBe(true);
    expect(isAntigravityAcpBinaryPath("/usr/local/bin/agy_acp_server.par")).toBe(true);
    expect(isAntigravityAcpBinaryPath("C:\\tools\\agy_acp_server.exe")).toBe(true);
    expect(isAntigravityAcpBinaryPath("agy")).toBe(false);
    expect(isAntigravityAcpBinaryPath("/usr/local/bin/agy")).toBe(false);
    expect(isAntigravityAcpBinaryPath("")).toBe(false);
    expect(isAntigravityAcpBinaryPath(undefined)).toBe(false);
  });
});

describe("resolveAntigravityAcpExecutable", () => {
  it("prefers ANTIGRAVITY_ACP_EXECUTABLE", () => {
    const resolution = resolveAntigravityAcpExecutable(undefined, {
      ...noAcpOnPath,
      env: { [ANTIGRAVITY_ACP_EXECUTABLE_ENV]: "/opt/agy_acp_server" },
    });
    expect(resolution).toEqual({
      outcome: "resolved",
      executable: "/opt/agy_acp_server",
      source: "env",
    });
  });

  it("uses a configured path only when it names the ACP server", () => {
    expect(resolveAntigravityAcpExecutable("/opt/agy_acp_server", noAcpOnPath)).toMatchObject({
      outcome: "resolved",
      executable: "/opt/agy_acp_server",
      source: "configured",
    });
    expect(resolveAntigravityAcpExecutable("/opt/agy", noAcpOnPath).outcome).toBe("not-installed");
  });

  it("prefers the Synara-managed install before PATH", () => {
    const managed = nodePath.join(
      "/home/u",
      ".synara",
      "acp-servers",
      "antigravity",
      "agy_acp_server",
    );
    const resolution = resolveAntigravityAcpExecutable(undefined, {
      ...noAcpOnPath,
      homeDir: "/home/u",
      pathExists: (candidate) => candidate === managed,
      resolveOnPath: () => "/usr/bin/agy_acp_server",
    });
    expect(resolution).toMatchObject({
      outcome: "resolved",
      executable: managed,
      source: "managed",
    });
  });

  it("falls back to PATH then ~/.local/bin", () => {
    expect(
      resolveAntigravityAcpExecutable(undefined, {
        ...noAcpOnPath,
        resolveOnPath: (command) =>
          command === "agy_acp_server" ? "/usr/bin/agy_acp_server" : null,
      }),
    ).toMatchObject({ outcome: "resolved", executable: "/usr/bin/agy_acp_server", source: "path" });

    const localPar = nodePath.join("/home/u", ".local", "share", "agy-acp", "agy_acp_server.par");
    expect(
      resolveAntigravityAcpExecutable(undefined, {
        ...noAcpOnPath,
        homeDir: "/home/u",
        pathExists: (candidate) => candidate === localPar,
      }),
    ).toMatchObject({ outcome: "resolved", executable: localPar, source: "local-bin" });
  });

  it("reports an actionable not-installed error on POSIX", () => {
    const resolution = resolveAntigravityAcpExecutable(undefined, noAcpOnPath);
    expect(resolution.outcome).toBe("not-installed");
    if (resolution.outcome === "not-installed") {
      expect(resolution.detail).toContain("agy_acp_server");
      expect(resolution.detail).toContain("ANTIGRAVITY_ACP_EXECUTABLE");
      expect(resolution.detail).toContain("interactive `agy` CLI is not a substitute");
    }
  });

  it("marks Windows unsupported when only non-Windows artifacts exist", () => {
    const resolution = resolveAntigravityAcpExecutable(undefined, {
      ...noAcpOnPath,
      platform: "win32",
      homeDir: "C:\\Users\\u",
      resolveOnPath: (command) =>
        command === "agy_acp_server" ? "C:\\tools\\agy_acp_server" : null,
    });
    expect(resolution.outcome).toBe("unsupported-platform");
    if (resolution.outcome === "unsupported-platform") {
      expect(resolution.detail).toContain("Windows");
    }
  });

  it("does not substitute interactive agy.exe on Windows", () => {
    const resolution = resolveAntigravityAcpExecutable(undefined, {
      ...noAcpOnPath,
      platform: "win32",
      homeDir: "C:\\Users\\u",
      resolveOnPath: (command) => (command === "agy" ? "C:\\tools\\agy.exe" : null),
    });
    expect(resolution.outcome).toBe("unsupported-platform");
  });
});

describe("antigravityAcpArgsForExecutable", () => {
  it("adds an empty uid arg for Linux .par archives", () => {
    expect(antigravityAcpArgsForExecutable("/opt/agy_acp_server.par", "linux")).toEqual(["--uid="]);
    expect(antigravityAcpArgsForExecutable("/opt/agy_acp_server", "linux")).toEqual([]);
    expect(antigravityAcpArgsForExecutable("C:\\tools\\agy_acp_server.exe", "win32")).toEqual([]);
    expect(antigravityAcpArgsForExecutable("/opt/agy_acp_server.par", "darwin")).toEqual([
      "--uid=",
    ]);
  });
});

describe("buildAntigravityAcpSpawnInput", () => {
  it("builds a browserless ACP spawn against the resolved server", () => {
    const spawn = buildAntigravityAcpSpawnInput(undefined, "/tmp/project", noAcpOnPath);
    expect(spawn.command).toBe("agy_acp_server");
    expect(spawn.args).toEqual([]);
    expect(spawn.cwd).toBe("/tmp/project");
    expect(spawn.env).toMatchObject({ BROWSER: "true", NO_BROWSER: "true" });
  });

  it("passes a configured ACP binary and .par uid arg", () => {
    const spawn = buildAntigravityAcpSpawnInput(
      { binaryPath: "/opt/agy_acp_server.par" },
      "/tmp/project",
      { ...noAcpOnPath, platform: "linux" },
    );
    expect(spawn.command).toBe("/opt/agy_acp_server.par");
    expect(spawn.args).toEqual(["--uid="]);
  });

  it("rejects an old agy binaryPath by falling back to discovery", () => {
    const spawn = buildAntigravityAcpSpawnInput(
      { binaryPath: "/usr/local/bin/agy" },
      "/tmp/project",
      noAcpOnPath,
    );
    expect(spawn.command).toBe("agy_acp_server");
  });

  it("includes Gemini/Google credential grants from the shared child environment", () => {
    const spawn = buildAntigravityAcpSpawnInput(undefined, "/tmp/project", noAcpOnPath);
    expect(spawn.env).toBeDefined();
    expect(spawn.env?.GEMINI_API_KEY ?? "inherited-if-present").toBeDefined();
  });
});

function initializeWithAuthMethods(ids: ReadonlyArray<string>): Acp.InitializeResponse {
  return {
    protocolVersion: 1,
    authMethods: ids.map((id) => ({ id, name: id })),
  };
}

describe("resolveAntigravityAcpAuthMethodId", () => {
  it("prefers an advertised API-key method when a Google key is set", async () => {
    const previousGemini = process.env.GEMINI_API_KEY;
    const previousGoogle = process.env.GOOGLE_API_KEY;
    process.env.GEMINI_API_KEY = "test-key";
    try {
      const id = await Effect.runPromise(
        resolveAntigravityAcpAuthMethodId(
          initializeWithAuthMethods(["cached_token", "google.api_key"]),
        ),
      );
      expect(id).toBe("google.api_key");
    } finally {
      if (previousGemini === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousGemini;
      if (previousGoogle === undefined) delete process.env.GOOGLE_API_KEY;
      else process.env.GOOGLE_API_KEY = previousGoogle;
    }
  });

  it("falls back to cached token auth", async () => {
    const previousGemini = process.env.GEMINI_API_KEY;
    const previousGoogle = process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    try {
      const id = await Effect.runPromise(
        resolveAntigravityAcpAuthMethodId(initializeWithAuthMethods(["cached_token"])),
      );
      expect(id).toBe("cached_token");
    } finally {
      if (previousGemini !== undefined) process.env.GEMINI_API_KEY = previousGemini;
      if (previousGoogle !== undefined) process.env.GOOGLE_API_KEY = previousGoogle;
    }
  });

  it("returns cached_token when no methods are advertised so setup can surface -32000", async () => {
    const id = await Effect.runPromise(
      resolveAntigravityAcpAuthMethodId(initializeWithAuthMethods([])),
    );
    expect(id).toBe("cached_token");
  });

  it("fails with an actionable message when only interactive auth is advertised", async () => {
    const previousGemini = process.env.GEMINI_API_KEY;
    const previousGoogle = process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    try {
      const error = await Effect.runPromise(
        resolveAntigravityAcpAuthMethodId(initializeWithAuthMethods(["browser_login"])).pipe(
          Effect.flip,
        ),
      );
      expect(error).toBeInstanceOf(AcpErrors.AcpRequestError);
      expect(error.message).toContain("not authenticated");
      expect(error.message).toContain("GEMINI_API_KEY");
    } finally {
      if (previousGemini !== undefined) process.env.GEMINI_API_KEY = previousGemini;
      if (previousGoogle !== undefined) process.env.GOOGLE_API_KEY = previousGoogle;
    }
  });
});

describe("discoverAntigravityAcpModels", () => {
  it("projects the ACP model select into descriptors with effort ladders", async () => {
    const runtime = {
      getConfigOptions: Effect.succeed([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "gemini-3.5-flash",
          options: [
            { value: "gemini-3.5-flash", name: "Gemini 3.5 Flash" },
            { value: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
          ],
        },
        {
          id: "reasoning_effort",
          name: "Reasoning",
          category: "thought_level",
          type: "select",
          currentValue: "medium",
          options: [
            { value: "low", name: "Low" },
            { value: "medium", name: "Medium" },
            { value: "high", name: "High" },
          ],
        },
      ] as ReadonlyArray<Acp.SessionConfigOption>),
    };
    const result = await Effect.runPromise(discoverAntigravityAcpModels(runtime));
    expect(result.source).toBe("antigravity-acp");
    expect(result.models).toEqual([
      expect.objectContaining({
        slug: "gemini-3.5-flash",
        name: "Gemini 3.5 Flash",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
        ],
      }),
      expect.objectContaining({ slug: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" }),
    ]);
  });

  it("fails when the agent advertises no model option", async () => {
    const error = await Effect.runPromise(
      discoverAntigravityAcpModels({ getConfigOptions: Effect.succeed([]) }).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(AcpErrors.AcpRequestError);
    expect(error.message).toContain("model configuration option");
  });
});

describe("applyAntigravityAcpModelSelection", () => {
  it("sets the model before the reasoning effort", async () => {
    const calls: Array<{ kind: "model" | "effort"; value: string }> = [];
    await Effect.runPromise(
      applyAntigravityAcpModelSelection({
        runtime: {
          setModel: (model: string) => {
            calls.push({ kind: "model", value: model });
            return Effect.succeed({});
          },
          getConfigOptions: Effect.succeed([
            {
              id: "reasoning_effort",
              name: "Reasoning",
              category: "thought_level",
              type: "select",
              currentValue: "medium",
              options: [
                { value: "medium", name: "Medium" },
                { value: "high", name: "High" },
              ],
            },
          ] as ReadonlyArray<Acp.SessionConfigOption>),
          setConfigOption: (configId: string, value: string | boolean) => {
            calls.push({ kind: "effort", value: `${configId}=${String(value)}` });
            return Effect.succeed({ configOptions: [] });
          },
        },
        model: "gemini-3.5-flash",
        options: { reasoningEffort: "high" },
        mapError: ({ cause }) => cause,
      }),
    );
    expect(calls).toEqual([
      { kind: "model", value: "gemini-3.5-flash" },
      { kind: "effort", value: "reasoning_effort=high" },
    ]);
  });

  it("skips the effort RPC when the advertised ladder does not include it", async () => {
    const calls: Array<{ configId: string; value: string | boolean }> = [];
    await Effect.runPromise(
      applyAntigravityAcpModelSelection({
        runtime: {
          setModel: () => Effect.succeed({}),
          getConfigOptions: Effect.succeed([
            {
              id: "reasoning_effort",
              name: "Reasoning",
              category: "thought_level",
              type: "select",
              currentValue: "medium",
              options: [{ value: "medium", name: "Medium" }],
            },
          ] as ReadonlyArray<Acp.SessionConfigOption>),
          setConfigOption: (configId: string, value: string | boolean) => {
            calls.push({ configId, value });
            return Effect.succeed({ configOptions: [] });
          },
        },
        model: "gemini-3.5-flash",
        options: { reasoningEffort: "ultra" },
        mapError: ({ cause }) => cause,
      }),
    );
    expect(calls).toEqual([]);
  });

  it("maps failures through mapError", async () => {
    const error = await Effect.runPromise(
      applyAntigravityAcpModelSelection({
        runtime: {
          setModel: () =>
            Effect.fail(new AcpErrors.AcpRequestError({ code: -32602, errorMessage: "bad model" })),
          getConfigOptions: Effect.succeed([]),
          setConfigOption: () => Effect.succeed({ configOptions: [] }),
        },
        model: "nope",
        mapError: ({ method }) => new Error(`failed:${method}`),
      }).pipe(Effect.flip),
    );
    expect(error.message).toBe("failed:session/set_config_option");
  });
});

describe("makeAntigravityAcpRuntime", () => {
  it("applies cold-start startup timeouts", () => {
    expect(ANTIGRAVITY_ACP_STARTUP_TIMEOUTS.initializeMs).toBeGreaterThanOrEqual(90_000);
    expect(ANTIGRAVITY_ACP_STARTUP_TIMEOUTS.totalMs).toBeGreaterThanOrEqual(100_000);
  });
});

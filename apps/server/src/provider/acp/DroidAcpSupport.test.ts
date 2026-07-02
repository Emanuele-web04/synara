import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildDroidAcpSpawnInput,
  resolveDroidAcpAuthMethodId,
  resolveDroidCliBinaryPath,
} from "./DroidAcpSupport.ts";

function initializeWithAuthMethods(ids: ReadonlyArray<string>): EffectAcpSchema.InitializeResponse {
  return {
    protocolVersion: 1,
    authMethods: ids.map((id) => ({ id, name: id })),
  };
}

describe("resolveDroidCliBinaryPath", () => {
  it("prefers ~/.local/bin/droid when it exists", () => {
    const localBin = join(homedir(), ".local", "bin", "droid");
    const resolved = resolveDroidCliBinaryPath("");
    expect(resolved).toBe(existsSync(localBin) ? localBin : "droid");
  });
});

describe("buildDroidAcpSpawnInput", () => {
  it("builds the default Droid ACP command", () => {
    const spawn = buildDroidAcpSpawnInput(undefined, "/tmp/project");
    expect(spawn.args).toEqual(["exec", "--output-format", "acp"]);
    expect(spawn.cwd).toBe("/tmp/project");
    expect(spawn.command.length).toBeGreaterThan(0);
    expect(buildDroidAcpSpawnInput(undefined, "/tmp/project")).toEqual({
      command: spawn.command,
      args: ["exec", "--output-format", "acp"],
      cwd: "/tmp/project",
    });
  });

  it("passes model, reasoning effort, and full-access flag", () => {
    expect(
      buildDroidAcpSpawnInput(
        {
          binaryPath: "/usr/local/bin/droid",
          model: "claude-opus-4-8",
          reasoningEffort: "high",
          skipPermissionsUnsafe: true,
        },
        "/tmp/project",
      ),
    ).toEqual({
      command: "/usr/local/bin/droid",
      args: [
        "exec",
        "--output-format",
        "acp",
        "--skip-permissions-unsafe",
        "-m",
        "claude-opus-4-8",
        "-r",
        "high",
      ],
      cwd: "/tmp/project",
    });
  });
});

describe("resolveDroidAcpAuthMethodId", () => {
  const previousFactoryApiKey = process.env.FACTORY_API_KEY;

  afterEach(() => {
    if (previousFactoryApiKey === undefined) {
      delete process.env.FACTORY_API_KEY;
    } else {
      process.env.FACTORY_API_KEY = previousFactoryApiKey;
    }
  });

  it("prefers factory-api-key when FACTORY_API_KEY is set", async () => {
    process.env.FACTORY_API_KEY = "fk-test";
    const id = await Effect.runPromise(
      resolveDroidAcpAuthMethodId(initializeWithAuthMethods(["factory-api-key", "device-pairing"])),
    );
    expect(id).toBe("factory-api-key");
  });

  it("falls back to device-pairing", async () => {
    delete process.env.FACTORY_API_KEY;
    const id = await Effect.runPromise(
      resolveDroidAcpAuthMethodId(initializeWithAuthMethods(["device-pairing"])),
    );
    expect(id).toBe("device-pairing");
  });

  it("fails when no auth method is available", async () => {
    delete process.env.FACTORY_API_KEY;
    const error = await Effect.runPromise(
      resolveDroidAcpAuthMethodId(initializeWithAuthMethods([])).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(EffectAcpErrors.AcpRequestError);
  });
});

import { describe, expect, it } from "vitest";

import type { BridgeEnv } from "./cloudflareRuntime.ts";
import type { CloudflareSandboxSdk, CloudflareSdkSandbox } from "./cloudflareSandboxSdk.ts";
import { makeRealSandboxRuntimeFactory } from "./workerEntry.ts";

const stubSandbox = (): CloudflareSdkSandbox => ({
  exec: () => Promise.resolve({ stdout: "ok\n", stderr: "", exitCode: 0 }),
  startProcess: () => Promise.resolve({ id: "proc-1", kill: () => Promise.resolve() }),
  readFile: () => Promise.resolve({ content: "x" }),
  writeFile: () => Promise.resolve(undefined),
  exposePort: () => Promise.resolve({ url: "https://port.example" }),
  destroy: () => Promise.resolve(undefined),
});

const stubSdk = (): { readonly sdk: CloudflareSandboxSdk; readonly ids: string[] } => {
  const ids: string[] = [];
  const sdk: CloudflareSandboxSdk = {
    getSandbox: (_binding, id) => {
      ids.push(id);
      return stubSandbox();
    },
  };
  return { sdk, ids };
};

const envWithSandbox = (): BridgeEnv => ({
  BRIDGE_AUTH_TOKEN: "secret",
  RUNTIME_INSTANCES: {
    idFromName: (name) => ({ toString: () => name }),
    get: () => {
      throw new Error("unused");
    },
  },
  SANDBOX: { marker: "sandbox-binding" },
});

const workspaceInput = {
  instanceId: "inst-1",
  flavor: "workspace" as const,
  env: {},
  resources: {},
};

describe("makeRealSandboxRuntimeFactory", () => {
  it("constructs a real workspace runtime from the SANDBOX binding via the loaded SDK", async () => {
    const { sdk, ids } = stubSdk();
    const factory = makeRealSandboxRuntimeFactory(envWithSandbox(), () => Promise.resolve(sdk));

    const runtime = await factory(workspaceInput);
    expect(ids).toEqual(["inst-1"]);

    const handle = await runtime.exec({ command: "echo", args: ["ok"], cwd: undefined, env: {} });
    expect(await handle.exitCode).toBe(0);
  });

  it("throws clearly when the SANDBOX binding is absent (misconfigured deploy)", async () => {
    const { sdk } = stubSdk();
    const env = { ...envWithSandbox(), SANDBOX: undefined };
    const factory = makeRealSandboxRuntimeFactory(env, () => Promise.resolve(sdk));

    await expect(factory(workspaceInput)).rejects.toThrow(/SANDBOX` binding is not configured/);
  });

  it("rejects the container flavor (raw Containers are not wired here)", async () => {
    const { sdk } = stubSdk();
    const factory = makeRealSandboxRuntimeFactory(envWithSandbox(), () => Promise.resolve(sdk));

    await expect(factory({ ...workspaceInput, flavor: "container" })).rejects.toThrow(
      /container` flavor/,
    );
  });
});

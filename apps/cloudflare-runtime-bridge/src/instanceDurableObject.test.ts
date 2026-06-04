import type {
  BridgeExecResult,
  BridgeFileReadResult,
  BridgeInstance,
  BridgeLogLine,
  BridgeRenewActivityResult,
  BridgeRoute,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { BridgeEnv } from "./cloudflareRuntime.ts";
import {
  makeFakeDurableObjectState,
  makeFakeSandboxRuntime,
  makeFakeWebSocketPair,
  type FakeSandboxRuntime,
  type FakeWebSocketEnd,
} from "./fakeSandboxRuntime.ts";
import {
  RuntimeInstanceDurableObject,
  type DurableObjectPlatform,
  type SandboxRuntimeFactory,
} from "./instanceDurableObject.ts";

const env: BridgeEnv = {
  BRIDGE_AUTH_TOKEN: "secret",
  RUNTIME_INSTANCES: {
    idFromName: (name) => ({ toString: () => name }),
    get: () => {
      throw new Error("unused in DO-level tests");
    },
  },
};

let idCounter = 0;
const makePlatform = (): DurableObjectPlatform => ({
  makeWebSocketPair: makeFakeWebSocketPair,
  now: () => "2026-06-03T00:00:00.000Z",
  randomId: () => `id-${(idCounter += 1)}`,
});

const makeDo = (
  instanceId: string,
  options?: { readonly runtime?: FakeSandboxRuntime },
): { readonly object: RuntimeInstanceDurableObject; readonly runtime: FakeSandboxRuntime } => {
  const runtime = options?.runtime ?? makeFakeSandboxRuntime();
  const factory: SandboxRuntimeFactory = () => Promise.resolve(runtime);
  const object = new RuntimeInstanceDurableObject(
    makeFakeDurableObjectState(instanceId),
    env,
    factory,
    makePlatform(),
  );
  return { object, runtime };
};

const jsonOf = async <T>(response: Response): Promise<T> => (await response.json()) as T;

/** Read at least `count` newline-delimited JSON records from a streaming body. */
const readNdjson = async <T>(response: Response, count: number): Promise<ReadonlyArray<T>> => {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new Error("response has no body");
  }
  const decoder = new TextDecoder();
  const records: T[] = [];
  let buffer = "";
  while (records.length < count) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length > 0) {
        records.push(JSON.parse(line) as T);
      }
    }
  }
  await reader.cancel();
  return records;
};

const createRequest = (instanceId: string, body: unknown): Request =>
  new Request(`https://bridge.example/instances/${instanceId}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

describe("RuntimeInstanceDurableObject", () => {
  it("creates a workspace instance and is idempotent on re-create", async () => {
    const { object } = makeDo("inst-1");
    const created = await object.fetch(createRequest("inst-1", { flavor: "workspace" }));
    expect(created.status).toBe(201);
    const record = await jsonOf<BridgeInstance>(created);
    expect(record.id).toBe("inst-1");
    expect(record.flavor).toBe("workspace");
    expect(record.status).toBe("running");

    const again = await object.fetch(createRequest("inst-1", { flavor: "workspace" }));
    expect(again.status).toBe(200);
  });

  it("declares container ports at create and rejects the interactive terminal", async () => {
    const { object } = makeDo("inst-2");
    const created = await object.fetch(
      createRequest("inst-2", { flavor: "container", ports: [8080, 9090] }),
    );
    const record = await jsonOf<BridgeInstance>(created);
    expect(record.flavor).toBe("container");
    expect(record.routes?.map((route) => route.port)).toEqual([8080, 9090]);

    const terminal = await object.fetch(
      new Request("https://bridge.example/instances/inst-2/terminal", {
        headers: { upgrade: "websocket" },
      }),
    );
    // Raw Containers stay service-oriented: no default interactive terminal.
    expect(terminal.status).toBe(409);
  });

  it("runs a fire-and-collect command and returns collected output", async () => {
    const runtime = makeFakeSandboxRuntime({
      execScripts: { echo: { stdout: "hello\n", exitCode: 0 } },
    });
    const { object } = makeDo("inst-3", { runtime });
    await object.fetch(createRequest("inst-3", { flavor: "workspace" }));

    const exec = await object.fetch(
      new Request("https://bridge.example/instances/inst-3/exec", {
        method: "POST",
        body: JSON.stringify({ command: "echo", args: ["hello"] }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(exec.status).toBe(200);
    const result = await jsonOf<BridgeExecResult>(exec);
    expect(result.stdout).toBe("hello\n");
    expect(result.exitCode).toBe(0);
  });

  it("replays exec output on the logs stream", async () => {
    const runtime = makeFakeSandboxRuntime({
      execScripts: { build: { stdout: "step one\nstep two\n", stderr: "warn\n", exitCode: 0 } },
    });
    const { object } = makeDo("inst-logs-1", { runtime });
    await object.fetch(createRequest("inst-logs-1", { flavor: "workspace" }));

    await object.fetch(
      new Request("https://bridge.example/instances/inst-logs-1/exec", {
        method: "POST",
        body: JSON.stringify({ command: "build" }),
        headers: { "content-type": "application/json" },
      }),
    );

    // A subscriber that connects after the command ran still sees its output,
    // proving exec is a producer into the retained ring.
    const logs = await object.fetch(
      new Request("https://bridge.example/instances/inst-logs-1/logs"),
    );
    expect(logs.status).toBe(200);
    const lines = await readNdjson<BridgeLogLine>(logs, 3);
    expect(lines.map((line) => line.line)).toEqual(["step one", "step two", "warn"]);
    expect(lines.map((line) => line.stream)).toEqual(["stdout", "stdout", "stderr"]);
  });

  it("streams terminal output to live log subscribers", async () => {
    const runtime = makeFakeSandboxRuntime();
    const { object } = makeDo("inst-logs-2", { runtime });
    await object.fetch(createRequest("inst-logs-2", { flavor: "workspace" }));

    const logs = await object.fetch(
      new Request("https://bridge.example/instances/inst-logs-2/logs"),
    );
    const reader = logs.body?.getReader();
    expect(reader).toBeDefined();

    await object.fetch(
      new Request("https://bridge.example/instances/inst-logs-2/terminal", {
        headers: { upgrade: "websocket" },
      }),
    );
    runtime.lastTerminal()?.emit("compiling\n");

    const decoder = new TextDecoder();
    const chunk = await reader!.read();
    const line = JSON.parse(decoder.decode(chunk.value).trim()) as BridgeLogLine;
    expect(line.line).toBe("compiling");
    expect(line.stream).toBe("stdout");
    await reader!.cancel();
  });

  it("writes and reads a file round-trip (base64)", async () => {
    const { object } = makeDo("inst-4");
    await object.fetch(createRequest("inst-4", { flavor: "workspace" }));

    const content = "console.log(1)\n";
    const contentBase64 = btoa(content);
    const write = await object.fetch(
      new Request("https://bridge.example/instances/inst-4/files", {
        method: "PUT",
        body: JSON.stringify({ path: "/workspace/app.js", contentBase64 }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(write.status).toBe(200);

    const read = await object.fetch(
      new Request("https://bridge.example/instances/inst-4/files?path=/workspace/app.js"),
    );
    expect(read.status).toBe(200);
    const file = await jsonOf<BridgeFileReadResult>(read);
    expect(atob(file.contentBase64)).toBe(content);
  });

  it("streams a file-watch event when a file is written", async () => {
    const { object } = makeDo("inst-5");
    await object.fetch(createRequest("inst-5", { flavor: "workspace" }));

    const watch = await object.fetch(
      new Request("https://bridge.example/instances/inst-5/files/watch"),
    );
    expect(watch.status).toBe(200);
    const reader = watch.body?.getReader();
    expect(reader).toBeDefined();

    await object.fetch(
      new Request("https://bridge.example/instances/inst-5/files", {
        method: "PUT",
        body: JSON.stringify({ path: "/workspace/x.txt", contentBase64: btoa("x") }),
        headers: { "content-type": "application/json" },
      }),
    );

    const chunk = await reader!.read();
    const line = new TextDecoder().decode(chunk.value);
    const event = JSON.parse(line.trim()) as { readonly path: string; readonly kind: string };
    expect(event.path).toBe("/workspace/x.txt");
    expect(event.kind).toBe("modified");
    await reader!.cancel();
  });

  it("exposes a port on demand for a workspace", async () => {
    const { object } = makeDo("inst-6");
    await object.fetch(createRequest("inst-6", { flavor: "workspace" }));

    const exposed = await object.fetch(
      new Request("https://bridge.example/instances/inst-6/ports", {
        method: "POST",
        body: JSON.stringify({ port: 3000, label: "dev" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(exposed.status).toBe(201);
    const route = await jsonOf<BridgeRoute>(exposed);
    expect(route.port).toBe(3000);
    expect(route.url).toContain("port-3000");
  });

  it("accepts a network policy and renews activity", async () => {
    const { object } = makeDo("inst-7");
    await object.fetch(createRequest("inst-7", { flavor: "workspace" }));

    const policy = await object.fetch(
      new Request("https://bridge.example/instances/inst-7/network-policy", {
        method: "PUT",
        body: JSON.stringify({
          defaultEgress: "deny",
          rules: [{ action: "allow", host: "github.com" }],
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(policy.status).toBe(200);

    const renew = await object.fetch(
      new Request("https://bridge.example/instances/inst-7/renew-activity", {
        method: "POST",
        body: JSON.stringify({ reason: "turn", extendSeconds: 120 }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(renew.status).toBe(200);
    const result = await jsonOf<BridgeRenewActivityResult>(renew);
    expect(result.remainingSeconds).toBe(120);
    expect(result.expiresAt).not.toBeNull();
  });

  it("streams terminal output over the WebSocket and forwards client input", async () => {
    const runtime = makeFakeSandboxRuntime();
    const { object } = makeDo("inst-8", { runtime });
    await object.fetch(createRequest("inst-8", { flavor: "workspace" }));

    const upgrade = await object.fetch(
      new Request("https://bridge.example/instances/inst-8/terminal?cols=100&rows=40", {
        headers: { upgrade: "websocket" },
      }),
    );
    // The Worker runtime yields a 101 upgrade; the Node test fallback yields 200
    // but still attaches the client socket as a property.
    expect([101, 200]).toContain(upgrade.status);

    const terminal = runtime.lastTerminal();
    expect(terminal).toBeDefined();
    // The client end of the pair is attached to the upgrade response.
    const client = (upgrade as Response & { webSocket?: FakeWebSocketEnd }).webSocket;
    expect(client).toBeDefined();

    // Runtime output is framed as a `data` terminal frame and delivered to the client.
    terminal!.emit("ls\n");
    const frames = (client!.received as ReadonlyArray<string>).map(
      (raw) => JSON.parse(raw) as { readonly _tag: string; readonly data?: string },
    );
    expect(frames.some((frame) => frame._tag === "data" && frame.data === "ls\n")).toBe(true);

    // A client stdin frame travels to the server end and is forwarded to the
    // runtime terminal.
    client!.send(JSON.stringify({ _tag: "stdin", data: "echo hi\n" }));
    expect(terminal!.writes).toContain("echo hi\n");
  });

  it("destroys an instance idempotently", async () => {
    const runtime = makeFakeSandboxRuntime();
    const { object } = makeDo("inst-9", { runtime });
    await object.fetch(createRequest("inst-9", { flavor: "workspace" }));
    // Touch the runtime so it is constructed before destroy.
    await object.fetch(
      new Request("https://bridge.example/instances/inst-9/exec", {
        method: "POST",
        body: JSON.stringify({ command: "true" }),
        headers: { "content-type": "application/json" },
      }),
    );

    const first = await object.fetch(
      new Request("https://bridge.example/instances/inst-9", { method: "DELETE" }),
    );
    expect(first.status).toBe(200);
    expect(runtime.destroyed()).toBe(true);

    const second = await object.fetch(
      new Request("https://bridge.example/instances/inst-9", { method: "DELETE" }),
    );
    expect(second.status).toBe(200);

    // After delete the instance is gone.
    const get = await object.fetch(new Request("https://bridge.example/instances/inst-9"));
    expect(get.status).toBe(404);
  });
});

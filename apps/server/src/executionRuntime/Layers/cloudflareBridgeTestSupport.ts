/**
 * In-process fake of the Cloudflare bridge for contract tests.
 *
 * Implements `CloudflareBridgeConnection` against an in-memory instance store and
 * an in-process WebSocket, so the bridge client + Cloudflare adapter run their
 * full route/transport logic with no network and no credentials. This is what
 * lets the Phase-17 baseline contract test pass when real bridge credentials are
 * absent; the same suite runs against the real bridge when they are present.
 *
 * The fake mirrors the real Worker's behavior closely enough to be a faithful
 * contract double: create/get/delete instances, fire-and-collect exec, file
 * read/write, port exposure, network policy, activity renewal, and an
 * interactive terminal whose scripted output is delivered as `data` frames.
 *
 * @module cloudflareBridgeTestSupport
 */
import { Effect, Layer } from "effect";

import { CloudflareBridgeError } from "../Errors.ts";
import {
  CloudflareBridgeConnection,
  type CloudflareBridgeConnectionShape,
  type CloudflareBridgeHttpResponse,
} from "../Services/CloudflareBridgeConnection.ts";
import type { BridgeWebSocket } from "./cloudflareTerminalTransport.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64 = (text: string): string => {
  let binary = "";
  for (const byte of encoder.encode(text)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

const fromBase64ToText = (value: string): string => {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return decoder.decode(out);
};

interface FakeInstance {
  readonly id: string;
  readonly flavor: string;
  status: string;
  readonly rootPath: string;
  routes: Array<{ id: string; port: number; url: string | null; label: string | null }>;
  readonly files: Map<string, string>;
  networkPolicy: { defaultEgress: string; rules: ReadonlyArray<unknown> };
  expiresAt: string | null;
  readonly createdAt: string;
}

/** A scripted terminal handle the test drives to emit output / observe input. */
export interface FakeBridgeTerminal {
  readonly emit: (chunk: string) => void;
  readonly emitExit: (exitCode: number | null) => void;
  readonly inputs: ReadonlyArray<string>;
  /** Take and clear the stdin frames written since the last drain. */
  readonly drainInputs: () => ReadonlyArray<string>;
  readonly closed: () => boolean;
}

export interface FakeBridgeController {
  /** The terminal opened by the most recent `connectWebSocket`. */
  readonly lastTerminal: () => FakeBridgeTerminal | undefined;
  /** Script the stdout/exit a future `exec` returns for a command. */
  readonly scriptExec: (
    command: string,
    result: {
      readonly stdout?: string;
      readonly stderr?: string;
      readonly exitCode?: number | null;
    },
  ) => void;
}

const now = (): string => new Date().toISOString();

const ok = (json: unknown, status = 200): CloudflareBridgeHttpResponse => ({ status, json });

const notFound = (): CloudflareBridgeHttpResponse => ({
  status: 404,
  json: { error: "instance_not_found", detail: null },
});

const instanceIdFromPath = (path: string): string | null => {
  const match = /^\/instances\/([^/]+)/.exec(path);
  return match?.[1] !== undefined ? decodeURIComponent(match[1]) : null;
};

/**
 * Build a fake bridge connection layer plus a controller the test scripts. Each
 * fake instance lives only in memory; the layer satisfies the same service the
 * production HTTP/WS connection does.
 */
export const makeFakeCloudflareBridge = (): {
  readonly layer: Layer.Layer<CloudflareBridgeConnection>;
  readonly controller: FakeBridgeController;
} => {
  const instances = new Map<string, FakeInstance>();
  const execScripts = new Map<
    string,
    { stdout?: string; stderr?: string; exitCode?: number | null }
  >();
  let counter = 0;
  let lastTerminal: FakeBridgeTerminal | undefined;

  const handle = (
    input: Parameters<CloudflareBridgeConnectionShape["request"]>[0],
  ): CloudflareBridgeHttpResponse => {
    if (input.path === "/instances" && input.method === "POST") {
      counter += 1;
      const id = `cf-fake-${counter}`;
      const body = (input.body ?? {}) as {
        readonly flavor?: string;
        readonly ports?: ReadonlyArray<number>;
      };
      const flavor = body.flavor ?? "workspace";
      const routes =
        flavor === "container"
          ? (body.ports ?? []).map((port) => ({
              id: `route-${(counter += 1)}`,
              port,
              url: null,
              label: null,
            }))
          : [];
      const instance: FakeInstance = {
        id,
        flavor,
        status: "running",
        rootPath: "/workspace",
        routes,
        files: new Map(),
        networkPolicy: { defaultEgress: "allow", rules: [] },
        expiresAt: null,
        createdAt: now(),
      };
      instances.set(id, instance);
      return ok(serialize(instance), 201);
    }

    const id = instanceIdFromPath(input.path);
    if (id === null) {
      return { status: 404, json: { error: "not_found", detail: null } };
    }
    const instance = instances.get(id);

    if (input.path === `/instances/${id}` && input.method === "DELETE") {
      instances.delete(id);
      return ok({ ok: true });
    }
    if (instance === undefined) {
      return notFound();
    }
    if (input.path === `/instances/${id}` && input.method === "GET") {
      return ok(serialize(instance));
    }
    if (input.path.endsWith("/exec") && input.method === "POST") {
      const body = input.body as { readonly command: string };
      const script = execScripts.get(body.command) ?? {};
      return ok({
        processId: `proc-${(counter += 1)}`,
        stdout: script.stdout ?? "",
        stderr: script.stderr ?? "",
        exitCode: script.exitCode === undefined ? 0 : script.exitCode,
      });
    }
    if (input.path.endsWith("/files") && input.method === "PUT") {
      const body = input.body as { readonly path: string; readonly contentBase64: string };
      instance.files.set(body.path, fromBase64ToText(body.contentBase64));
      return ok({ ok: true });
    }
    if (input.path.endsWith("/files") && input.method === "GET") {
      const path = input.query?.path;
      const content = path === undefined ? undefined : instance.files.get(path);
      if (content === undefined) {
        return { status: 404, json: { error: "file_not_found", detail: null } };
      }
      return ok({ path, contentBase64: toBase64(content), truncated: false });
    }
    if (input.path.endsWith("/ports") && input.method === "POST") {
      const body = input.body as { readonly port: number; readonly label?: string | null };
      const route = {
        id: `route-${(counter += 1)}`,
        port: body.port,
        url: `https://port-${body.port}.example.workers.dev`,
        label: body.label ?? null,
      };
      instance.routes.push(route);
      return ok(route, 201);
    }
    if (input.path.endsWith("/network-policy") && input.method === "PUT") {
      const body = input.body as {
        readonly defaultEgress: string;
        readonly rules?: ReadonlyArray<unknown>;
      };
      instance.networkPolicy = { defaultEgress: body.defaultEgress, rules: body.rules ?? [] };
      return ok({ ok: true });
    }
    if (input.path.endsWith("/renew-activity") && input.method === "POST") {
      const body = input.body as { readonly extendSeconds?: number };
      const extend = body.extendSeconds ?? 300;
      instance.expiresAt = new Date(Date.now() + extend * 1000).toISOString();
      return ok({ expiresAt: instance.expiresAt, remainingSeconds: extend });
    }
    return { status: 404, json: { error: "unknown_route", detail: null } };
  };

  const serialize = (instance: FakeInstance): unknown => ({
    id: instance.id,
    flavor: instance.flavor,
    status: instance.status,
    rootPath: instance.rootPath,
    routes: instance.routes,
    failureReason: null,
    createdAt: instance.createdAt,
    updatedAt: now(),
  });

  const request: CloudflareBridgeConnectionShape["request"] = (input) =>
    Effect.sync(() => handle(input));

  const connectWebSocket: CloudflareBridgeConnectionShape["connectWebSocket"] = (input) =>
    Effect.gen(function* () {
      const id = instanceIdFromPath(input.path);
      if (id === null || !instances.has(id)) {
        return yield* Effect.fail(
          new CloudflareBridgeError({
            operation: `WS ${input.path}`,
            status: 404,
            detail: "instance_not_found",
          }),
        );
      }
      const messageHandlers: Array<(data: string) => void> = [];
      const closeHandlers: Array<() => void> = [];
      const inputs: string[] = [];
      let closed = false;
      const socket: BridgeWebSocket = {
        send: (data) => {
          inputs.push(data);
        },
        close: () => {
          closed = true;
          for (const handler of closeHandlers) {
            handler();
          }
        },
        onMessage: (handler) => {
          messageHandlers.push(handler);
        },
        onClose: (handler) => {
          closeHandlers.push(handler);
        },
      };
      lastTerminal = {
        emit: (chunk) => {
          for (const handler of messageHandlers) {
            handler(JSON.stringify({ _tag: "data", data: chunk }));
          }
        },
        emitExit: (exitCode) => {
          for (const handler of messageHandlers) {
            handler(JSON.stringify({ _tag: "exit", exitCode }));
          }
        },
        inputs,
        drainInputs: () => inputs.splice(0, inputs.length),
        closed: () => closed,
      };
      return socket;
    });

  const layer = Layer.succeed(CloudflareBridgeConnection, { request, connectWebSocket });

  const controller: FakeBridgeController = {
    lastTerminal: () => lastTerminal,
    scriptExec: (command, result) => {
      execScripts.set(command, result);
    },
  };

  return { layer, controller };
};

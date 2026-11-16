import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { writeExternalMcpClientCredential } from "./bridge.ts";
import {
  computeExternalMcpRuntimeProof,
  EXTERNAL_MCP_RUNTIME_CHALLENGE_HEADER,
} from "./runtimeProof.ts";
import { compactToolArguments, runExternalMcpToolCommand } from "./taskCli.ts";

const RUNTIME_SECRET = "task-cli-test-runtime-secret-0000001";
const temporaryDirectories: string[] = [];

function makePairedBaseDir(credential: string) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-task-cli-test-"));
  temporaryDirectories.push(baseDir);
  const directory = path.join(baseDir, "userdata");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  const runtimePath = path.join(directory, "server-runtime.json");
  fs.writeFileSync(
    runtimePath,
    JSON.stringify({
      version: 1,
      pid: process.pid,
      host: "127.0.0.1",
      port: 3773,
      origin: "http://127.0.0.1:3773",
      startedAt: new Date().toISOString(),
      externalMcpRuntimeSecret: RUNTIME_SECRET,
    }),
    { mode: 0o600 },
  );
  if (process.platform !== "win32") fs.chmodSync(runtimePath, 0o600);
  writeExternalMcpClientCredential(baseDir, {
    integrationId: "integration-cli",
    name: "CLI",
    credential,
    expiresAt: "2099-01-01T00:00:00.000Z" as never,
  });
  return baseDir;
}

function runtimeChallenge(url: string | URL | Request, init?: RequestInit): Response | null {
  if (!String(url).endsWith("/api/mcp/external/runtime-challenge")) return null;
  const nonce = new Headers(init?.headers).get(EXTERNAL_MCP_RUNTIME_CHALLENGE_HEADER)!;
  return Response.json({ proof: computeExternalMcpRuntimeProof(RUNTIME_SECRET, nonce) });
}

function capture() {
  const chunks: string[] = [];
  return {
    chunks,
    stream: new Writable({
      write: (chunk, _encoding, done) => (chunks.push(String(chunk)), done()),
    }),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("synara task CLI", () => {
  it("sends one tools/call and prints the structured result as JSON", async () => {
    const baseDir = makePairedBaseDir("syn_mcp_v1_cli");
    const stdout = capture();
    const stderr = capture();
    let sentBody: unknown;
    const { exitCode } = await runExternalMcpToolCommand({
      baseDir,
      tool: "synara_read_task",
      arguments: { threadId: "thread-1" },
      stdout: stdout.stream,
      stderr: stderr.stream,
      fetchImpl: async (url, init) => {
        const challenge = runtimeChallenge(url, init);
        if (challenge) return challenge;
        expect(String(url)).toBe("http://127.0.0.1:3773/mcp/external");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer syn_mcp_v1_cli");
        sentBody = JSON.parse(String(init?.body));
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: "ok" }],
            structuredContent: { threadId: "thread-1", state: "idle" },
          },
        });
      },
    });
    expect(exitCode).toBe(0);
    expect(sentBody).toMatchObject({
      method: "tools/call",
      params: { name: "synara_read_task", arguments: { threadId: "thread-1" } },
    });
    expect(JSON.parse(stdout.chunks.join(""))).toEqual({ threadId: "thread-1", state: "idle" });
    expect(stderr.chunks).toEqual([]);
  });

  it("exits non-zero and reports the tool error on stderr", async () => {
    const baseDir = makePairedBaseDir("syn_mcp_v1_cli");
    const stdout = capture();
    const stderr = capture();
    const { exitCode } = await runExternalMcpToolCommand({
      baseDir,
      tool: "synara_create_task",
      arguments: {},
      stdout: stdout.stream,
      stderr: stderr.stream,
      fetchImpl: async (url, init) =>
        runtimeChallenge(url, init) ??
        Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: { isError: true, content: [{ type: "text", text: "project not allowed" }] },
        }),
    });
    expect(exitCode).toBe(1);
    expect(stdout.chunks).toEqual([]);
    expect(stderr.chunks.join("")).toContain("project not allowed");
  });

  it("rejects a revoked credential without leaking it", async () => {
    const baseDir = makePairedBaseDir("syn_mcp_v1_do-not-leak");
    const failure = await runExternalMcpToolCommand({
      baseDir,
      tool: "synara_overview",
      arguments: {},
      stdout: capture().stream,
      stderr: capture().stream,
      fetchImpl: async (url, init) =>
        runtimeChallenge(url, init) ?? new Response("unauthorized", { status: 401 }),
    }).catch((cause: unknown) => cause as Error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("revoked, expired, or replaced");
    expect((failure as Error).message).not.toContain("do-not-leak");
  });

  it("drops unset optional arguments", () => {
    expect(compactToolArguments({ threadId: "t", cursor: undefined, messageLimit: 5 })).toEqual({
      threadId: "t",
      messageLimit: 5,
    });
  });
});

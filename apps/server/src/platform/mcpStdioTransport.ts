import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { spawnProcess } from "@synara/shared/processRuntime";
import {
  stripSynaraControlPlaneEnvironment,
  withoutProviderCredentialEnvironment,
} from "../providerChildEnvironment.ts";
import { createProtocolProcessTeardown } from "./protocolProcessTeardown.ts";

/** MCP SDK transport using Synara's executable resolution and owned-tree teardown. */
export class McpStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child?: ChildProcessWithoutNullStreams;
  private stop?: () => Promise<void>;

  constructor(
    private readonly config: {
      readonly command: string;
      readonly args: readonly string[];
      readonly cwd?: string | undefined;
      readonly env?: Readonly<Record<string, string>> | undefined;
    },
  ) {}

  async start(): Promise<void> {
    if (this.child) throw new Error("MCP transport is already started.");
    const child = spawnProcess(this.config.command, this.config.args, {
      stdio: "pipe",
      ownProcessGroup: true,
      ...(this.config.cwd ? { cwd: this.config.cwd } : {}),
      env: {
        ...withoutProviderCredentialEnvironment(stripSynaraControlPlaneEnvironment(process.env)),
        ...this.config.env,
      },
    });
    this.child = child;
    this.stop = createProtocolProcessTeardown(child, async () => {
      child.stdin.end();
    });
    // Never put stderr, arguments, or environment values in logs or protocol errors.
    child.stderr.resume();
    child.stdin.on("error", () => this.onerror?.(new Error("MCP input closed.")));
    child.on("error", () => this.onerror?.(new Error("MCP process could not start.")));
    child.once("exit", () => this.onclose?.());
    const decoder = new StringDecoder("utf8");
    let buffered = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += decoder.write(chunk);
      if (Buffer.byteLength(buffered) > 16 * 1024 * 1024) {
        buffered = "";
        this.onerror?.(new Error("MCP response exceeded the size limit."));
        void this.close().catch(() => this.onerror?.(new Error("MCP process cleanup failed.")));
        return;
      }
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          this.onmessage?.(JSON.parse(line) as JSONRPCMessage);
        } catch {
          this.onerror?.(new Error("MCP server returned an invalid message."));
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () => reject(new Error("MCP process could not start.")));
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null)
      throw new Error("MCP server is not running.");
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(JSON.stringify(message) + "\n", (error) =>
        error ? reject(new Error("MCP input closed.")) : resolve(),
      );
    });
  }

  async close(): Promise<void> {
    await this.stop?.();
  }
}

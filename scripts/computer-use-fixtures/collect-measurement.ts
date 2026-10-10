/** Run only against an isolated benchmark instance using an existing
 * diagnostics-capable gateway session. Credentials stay in the environment.
 * Example: bun scripts/computer-use-fixtures/collect-measurement.ts
 * --thread-id ID --turn-id ID --started-at ISO --out /private/tmp/run.json
 */
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { collectComputerRun, type DiagnosticToolCaller } from "./measurement.ts";

const { values } = parseArgs({
  options: {
    "thread-id": { type: "string" },
    "turn-id": { type: "string" },
    "started-at": { type: "string" },
    out: { type: "string" },
  },
  strict: true,
});

async function main(): Promise<void> {
  const url = new URL(process.env.SYNARA_AGENT_GATEWAY_URL ?? "http://127.0.0.1:3773/mcp");
  const token = process.env.SYNARA_AGENT_GATEWAY_TOKEN;
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/mcp"
  ) {
    throw new Error("Use the isolated Synara loopback /mcp endpoint");
  }
  if (!token)
    throw new Error("An existing SYNARA_AGENT_GATEWAY_TOKEN with diagnostics:read is required");
  if (!values["thread-id"] || !values["turn-id"] || !values["started-at"] || !values.out) {
    throw new Error(
      "Required: --thread-id, --turn-id, --started-at (before thread creation), --out",
    );
  }
  let requestId = 0;
  // The gateway's existing transport is stateless JSON-RPC over HTTP, also
  // used by agent-gateway-mcp-proxy.mjs. No SDK, bootstrap or credential scan.
  const call: DiagnosticToolCaller = async (name, args) => {
    const id = ++requestId;
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    if (!response.ok || !response.body)
      throw new Error(`Diagnostic request failed: HTTP ${response.status}`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 4 * 1024 * 1024) throw new Error("Diagnostic page exceeds 4 MiB");
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (message.id !== id || message.error || message.result?.isError) {
      throw new Error("Diagnostic tool refused or returned an invalid response");
    }
    const content = message.result?.content;
    if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== "text") {
      throw new Error("Diagnostic tool returned no JSON result");
    }
    return JSON.parse(content[0].text);
  };
  const report = await collectComputerRun(call, {
    threadId: values["thread-id"],
    turnId: values["turn-id"],
    runStartedAt: values["started-at"],
  });
  await writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  console.info(`${report.valid ? "Valid measurements" : "Invalid measurements"}: ${values.out}`);
  if (!report.valid) process.exitCode = 2;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Measurement failed");
  process.exitCode = 1;
});

import type { ChildProcess } from "node:child_process";
import * as readline from "node:readline";

import { asNumber, asRecord, trimToUndefined } from "../geminiValue.ts";

export const MAX_ACP_CAPTURED_LOG_LINES = 5;
export const MAX_ACP_CAPTURED_LOG_LENGTH = 240;

export function truncateAcpLogLine(line: string): string {
  return line.length > MAX_ACP_CAPTURED_LOG_LENGTH
    ? `${line.slice(0, MAX_ACP_CAPTURED_LOG_LENGTH - 3)}...`
    : line;
}

export function pushAcpLogLine(target: string[], line: string): void {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("{")) {
    return;
  }

  target.push(truncateAcpLogLine(trimmed));
  if (target.length > MAX_ACP_CAPTURED_LOG_LINES) {
    target.shift();
  }
}

export function detailFromAcpProbeLogs(
  stdoutLines: ReadonlyArray<string>,
  stderrLines: ReadonlyArray<string>,
): string | undefined {
  return stderrLines[stderrLines.length - 1] ?? stdoutLines[stdoutLines.length - 1];
}

export type AcpJsonRpcRequest = {
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
};

export function writeAcpJsonRpcRequest(
  stdin: NodeJS.WritableStream,
  request: AcpJsonRpcRequest,
): boolean {
  if (!stdin.writable) {
    return false;
  }
  stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      method: request.method,
      params: request.params,
    })}\n`,
  );
  return true;
}

export function parseAcpJsonRpcLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

export function readAcpResponseId(parsed: Record<string, unknown>): number | undefined {
  return asNumber(parsed.id);
}

export function readAcpResponseError(
  parsed: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return asRecord(parsed.error);
}

export function readAcpResponseResult(parsed: Record<string, unknown>): unknown {
  return parsed.result;
}

export function readAcpSessionId(result: unknown): string | undefined {
  return trimToUndefined(asRecord(result)?.sessionId);
}

export function terminateAcpChild(child: ChildProcess, closePayload?: string): void {
  if (closePayload && child.stdin?.writable) {
    child.stdin.write(closePayload);
    child.stdin.end();
    const delayedKill = setTimeout(() => {
      if (!child.killed) {
        child.kill();
      }
    }, 150);
    delayedKill.unref?.();
    return;
  }

  if (child.stdin?.writable) {
    child.stdin.end();
  }
  if (!child.killed) {
    child.kill();
  }
}

export function createAcpLineReaders(child: ChildProcess): {
  readonly stdoutLines: string[];
  readonly stderrLines: string[];
  readonly cleanup: () => void;
} {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const stdoutReader = child.stdout ? readline.createInterface({ input: child.stdout }) : undefined;
  const stderrReader = child.stderr ? readline.createInterface({ input: child.stderr }) : undefined;

  stdoutReader?.on("line", (line) => pushAcpLogLine(stdoutLines, line));
  stderrReader?.on("line", (line) => pushAcpLogLine(stderrLines, line));

  return {
    stdoutLines,
    stderrLines,
    cleanup: () => {
      stdoutReader?.removeAllListeners();
      stderrReader?.removeAllListeners();
      child.removeAllListeners();
      stdoutReader?.close();
      stderrReader?.close();
    },
  };
}

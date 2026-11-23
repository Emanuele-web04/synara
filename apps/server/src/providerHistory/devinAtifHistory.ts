// FILE: providerHistory/devinAtifHistory.ts
// Purpose: Read an ATIF (Agent Trajectory Interchange Format) export produced
// by `devin --export` into raw messages for the normalizer. Validation-first:
// an unrecognized payload must fail with unsupported-version, never return an
// empty successful history. Layer: Provider history import.
// Exports: parseDevinAtifExport, readDevinAtifFile, DevinAtifRawMessage,
// DevinAtifExport.

import * as fs from "node:fs/promises";

import { ProviderHistoryError } from "@synara/contracts";

const OPERATION = "DevinAtifHistory";
const MAX_EXPORT_BYTES = 16 * 1024 * 1024;

export interface DevinAtifRawMessage {
  readonly stepId: string | null;
  readonly source: "user" | "agent" | "system" | "tool";
  readonly text: string;
  readonly timestamp: string | null;
}

export interface DevinAtifExport {
  readonly schemaVersion: string | null;
  readonly agentName: string | null;
  readonly agentVersion: string | null;
  readonly messages: ReadonlyArray<DevinAtifRawMessage>;
}

function fail(
  code: ProviderHistoryError["code"],
  detail: string,
  retryable: boolean,
  cause?: unknown,
): never {
  throw new ProviderHistoryError({ operation: OPERATION, code, detail, retryable, cause });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

const STEP_SOURCES = new Set(["user", "agent", "system", "tool"]);

function parseStep(raw: unknown): DevinAtifRawMessage | null {
  const step = asRecord(raw);
  if (step === null) return null;
  const source = asText(step.source) ?? asText(step.role);
  if (source === null || !STEP_SOURCES.has(source)) return null;
  const message = asText(step.message) ?? asText(step.content) ?? "";
  return {
    stepId: asText(step.step_id) ?? asText(step.id),
    source: source as DevinAtifRawMessage["source"],
    text: message,
    timestamp: asText(step.timestamp) ?? asText(step.created_at),
  };
}

/**
 * Parse an ATIF export. Accepts the documented object form
 * `{ schema_version, agent: {name, version}, steps: [...] }` and tolerates
 * missing optional fields; anything else is an unsupported-version error so a
 * different JSON file is never silently imported as an empty transcript.
 */
export function parseDevinAtifExport(text: string): DevinAtifExport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail("read-failed", "ATIF export is not valid JSON.", false, error);
  }
  const root = asRecord(parsed);
  if (root === null) {
    fail("unsupported-version", "ATIF export is not a JSON object.", false);
  }
  const steps = root.steps;
  if (!Array.isArray(steps)) {
    fail("unsupported-version", "ATIF export has no steps array.", false);
  }
  const agent = asRecord(root.agent);
  return {
    schemaVersion: asText(root.schema_version),
    agentName: asText(agent?.name),
    agentVersion: asText(agent?.version),
    messages: steps.flatMap((raw) => {
      const step = parseStep(raw);
      return step === null ? [] : [step];
    }),
  };
}

export async function readDevinAtifFile(filePath: string): Promise<DevinAtifExport> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    fail("not-found", `ATIF export not found: ${filePath}`, false, error);
  }
  if (stat.size > MAX_EXPORT_BYTES) {
    fail("payload-too-large", `ATIF export exceeds ${MAX_EXPORT_BYTES} bytes.`, false);
  }
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    fail("read-failed", `Failed to read ATIF export: ${filePath}`, false, error);
  }
  return parseDevinAtifExport(text);
}

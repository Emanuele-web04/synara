import type { AcpToolCallState } from "./acp/AcpRuntimeModel.ts";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const commandText = (value: unknown): string | undefined => {
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value) && value.every((part) => typeof part === "string"))
    return value.join(" ").trim() || undefined;
  return undefined;
};

/** A provider-supplied display title is not evidence of an executed command. */
export function externalToolCallEvidence(toolCall: AcpToolCallState): AcpToolCallState {
  const input = record(toolCall.data.rawInput);
  const executable = commandText(input?.executable);
  const args = commandText(input?.args);
  const command =
    commandText(input?.command) ??
    (executable ? [executable, args].filter(Boolean).join(" ") : undefined);
  const { command: oldCommand, detail, ...rest } = toolCall;
  const { command: _inferred, ...data } = toolCall.data;
  return {
    ...rest,
    ...(detail !== undefined && detail !== oldCommand ? { detail } : {}),
    ...(command ? { command } : {}),
    data: { ...data, ...(command ? { command } : {}) },
  };
}

/** Unknown permission kinds must not inherit full-access approval. */
export function isKnownExternalPermissionKind(kind: unknown): boolean {
  return (
    typeof kind === "string" &&
    [
      "read",
      "edit",
      "delete",
      "move",
      "search",
      "execute",
      "think",
      "fetch",
      "switch_mode",
    ].includes(kind)
  );
}

/** Do not relabel an unrecognized provider plan state as pending. */
export function hasKnownExternalPlanStatuses(payload: unknown): boolean {
  const update = record(record(payload)?.update);
  return (
    Array.isArray(update?.entries) &&
    update.entries.every((entry) => {
      const status = record(entry)?.status;
      return status === "pending" || status === "in_progress" || status === "completed";
    })
  );
}

/** Preserve OS launch basics, never ambient API keys or application grants. */
export function externalAgentEnvironment(
  explicit: Readonly<Record<string, string>>,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowed = new Set([
    "PATH",
    "HOME",
    "USERPROFILE",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
  ]);
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined && allowed.has(key.toUpperCase())) result[key] = value;
  }
  for (const [key, value] of Object.entries(explicit)) {
    // Environment names are case-insensitive on Windows; avoid shadow aliases.
    for (const existing of Object.keys(result))
      if (existing.toUpperCase() === key.toUpperCase()) delete result[existing];
    result[key] = value;
  }
  return result;
}

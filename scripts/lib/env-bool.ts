// FILE: env-bool.ts
// Purpose: Parses release-script boolean environment values consistently.
// Layer: Release/build helper
// Exports: parseBooleanEnvValue and parseOptionalBooleanEnvValue.

const TRUE_VALUES = new Set(["1", "true", "yes", "y", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "n", "off", ""]);

export function parseBooleanEnvValue(name: string, rawValue: string): boolean {
  const normalized = rawValue.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_VALUES.has(normalized)) {
    return false;
  }
  throw new Error(
    `${name} must be a boolean value: true/false, 1/0, yes/no, or on/off. Received '${rawValue}'.`,
  );
}

export function parseOptionalBooleanEnvValue(
  name: string,
  rawValue: string | undefined,
  defaultValue: boolean,
): boolean {
  return rawValue === undefined ? defaultValue : parseBooleanEnvValue(name, rawValue);
}

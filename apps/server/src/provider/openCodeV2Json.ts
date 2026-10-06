// Validate untrusted v2 responses before adapting them to the legacy SDK shapes.
export function v2Object(value: unknown, name = "response"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid OpenCode v2 ${name}: expected an object`);
  }
  return value as Record<string, unknown>;
}

export function v2Data(value: unknown): unknown {
  const object = v2Object(value);
  return object.data ?? object;
}

export function v2Array(value: unknown, name = "response"): unknown[] {
  const data = Array.isArray(value) ? value : v2Data(value);
  if (!Array.isArray(data)) throw new Error(`Invalid OpenCode v2 ${name}: expected an array`);
  return data;
}

export function v2String(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`Invalid OpenCode v2 ${name}: expected a string`);
  return value;
}

export function v2Number(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid OpenCode v2 ${name}: expected a finite number`);
  }
  return value;
}

export function v2Boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean")
    throw new Error(`Invalid OpenCode v2 ${name}: expected a boolean`);
  return value;
}

export function v2Strings(value: unknown, name: string): string[] {
  return v2Array(value, name).map((entry) => v2String(entry, name));
}

export function v2OptionalString(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : v2String(value, "string field");
}

export function v2OptionalNumber(value: unknown): number | undefined {
  return value === undefined || value === null ? undefined : v2Number(value, "number field");
}

export function v2OptionalObject(value: unknown): Record<string, unknown> {
  return value === undefined || value === null ? {} : v2Object(value);
}

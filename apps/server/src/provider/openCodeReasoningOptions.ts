export interface OpenCodeReasoningDescriptor {
  readonly value: string;
  readonly label?: string;
  readonly description?: string;
}

function trimNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// only effort-shaped entries — toggle/budget entries can't dispatch through OpenCode's `variant`; null is OpenCode's spelling for `none`
export function parseOpenCodeReasoningOptions(
  value: unknown,
): ReadonlyArray<OpenCodeReasoningDescriptor> {
  if (!Array.isArray(value)) {
    return [];
  }

  const descriptors = new Map<string, OpenCodeReasoningDescriptor>();
  for (const entry of value) {
    const option = asRecord(entry);
    if (option?.type !== "effort" || !Array.isArray(option.values)) {
      continue;
    }

    for (const rawValue of option.values) {
      const effort = rawValue === null ? "none" : trimNonEmptyString(rawValue);
      if (!effort || descriptors.has(effort)) {
        continue;
      }

      const label = trimNonEmptyString(option.label);
      const description = trimNonEmptyString(option.description);
      descriptors.set(effort, {
        value: effort,
        ...(label ? { label } : {}),
        ...(description ? { description } : {}),
      });
    }
  }

  return [...descriptors.values()];
}

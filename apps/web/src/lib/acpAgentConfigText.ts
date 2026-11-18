// FILE: acpAgentConfigText.ts
// Purpose: Text editing for ACP agent instance fields stored as structured values
//          (argv lists, model slugs) in a provider instance's config.
// Layer: UI support
// Exports: acpArgsFromText, acpArgsToText, acpModelSlugsFromText, acpModelSlugsToText

/**
 * Splits an argv line into words honoring single and double quotes. Quotes only
 * group words; escape sequences are left to the spawned process's own rules.
 */
export function acpArgsFromText(text: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let hasWord = false;
  for (const char of text.trim()) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      hasWord = true;
      continue;
    }
    if (/\s/u.test(char)) {
      if (hasWord || current.length > 0) args.push(current);
      current = "";
      hasWord = false;
      continue;
    }
    current += char;
    hasWord = true;
  }
  if (hasWord || current.length > 0) args.push(current);
  return args;
}

/** Inverse of `acpArgsFromText` for showing an instance's argv as one line. */
export function acpArgsToText(args: ReadonlyArray<unknown>): string {
  return args
    .filter((arg): arg is string => typeof arg === "string" && arg.length > 0)
    .map((arg) => (/[\s"']/u.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg))
    .join(" ");
}

/** Comma-separated picker slugs → the `models` entries an ACP instance config carries. */
export function acpModelSlugsFromText(text: string): Array<{ slug: string }> {
  const seen = new Set<string>();
  const models: Array<{ slug: string }> = [];
  for (const part of text.split(/[\s,]+/u)) {
    const slug = part.trim();
    if (slug.length === 0 || seen.has(slug)) continue;
    seen.add(slug);
    models.push({ slug });
  }
  return models;
}

/** `models` entries → comma-separated slugs for editing. */
export function acpModelSlugsToText(models: ReadonlyArray<unknown>): string {
  return models
    .map((entry) =>
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as Record<string, unknown>).slug
        : undefined,
    )
    .filter((slug): slug is string => typeof slug === "string" && slug.length > 0)
    .join(", ");
}

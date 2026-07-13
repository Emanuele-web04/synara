// FILE: composerImageSource.ts
// Purpose: Describes provenance shown on composer image attachments.
// Layer: Web composer domain

export interface ComposerAppSnapSource {
  kind: "appsnap";
  captureId: string;
  capturedAt: string;
  appName: string | null;
  bundleIdentifier?: string | null;
  appIconDataUrl?: string | null;
  windowTitle: string | null;
}

export type ComposerImageSource = ComposerAppSnapSource;

export type PersistedComposerAppSnapSource = Omit<ComposerAppSnapSource, "appIconDataUrl">;

function normalizeAppIconDataUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 256_000) return null;
  return /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : null;
}

export function normalizeComposerImageSource(value: unknown): ComposerImageSource | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.kind !== "appsnap" && candidate.kind !== "appshot") ||
    typeof candidate.captureId !== "string" ||
    candidate.captureId.length === 0 ||
    typeof candidate.capturedAt !== "string"
  ) {
    return undefined;
  }
  return {
    kind: "appsnap",
    captureId: candidate.captureId,
    capturedAt: candidate.capturedAt,
    appName: typeof candidate.appName === "string" ? candidate.appName : null,
    bundleIdentifier:
      typeof candidate.bundleIdentifier === "string" ? candidate.bundleIdentifier : null,
    appIconDataUrl: normalizeAppIconDataUrl(candidate.appIconDataUrl),
    windowTitle: typeof candidate.windowTitle === "string" ? candidate.windowTitle : null,
  };
}

// App icons are cached in IndexedDB by bundle identifier. Keeping the inline
// PNG out of the persisted composer state prevents repeated captures of the
// same app from consuming the much smaller localStorage quota.
export function toPersistedComposerImageSource(
  value: unknown,
): PersistedComposerAppSnapSource | undefined {
  const source = normalizeComposerImageSource(value);
  if (!source) return undefined;
  const { appIconDataUrl: _appIconDataUrl, ...persistedSource } = source;
  return persistedSource;
}

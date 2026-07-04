// FILE: codexGeneratedImages.ts
// Purpose: Normalizes Codex generated-image events into durable local-file references.
// Layer: Server provider utilities
// Exports: Codex image path, payload sanitization, and markdown helpers
// Depends on: node path/os, image MIME allowlist, provider runtime artifact contract

import path from "node:path";

import {
  CODEX_GENERATED_IMAGE_ARTIFACT_KIND,
  type CodexGeneratedImageArtifact,
  type ProviderRuntimeEvent,
  type ServerSettings,
  type ThreadId,
} from "@synara/contracts";
import { isSupportedLocalImagePath as isSupportedLocalImagePathShared } from "@synara/shared/localPreviewFiles";
import {
  deriveProviderInstances,
  providerStartOptionsFromInstance,
} from "@synara/shared/providerInstances";

import {
  resolveActiveCodexHomeWritePath,
  resolveCodexHomeAllowlistCandidates,
} from "./codexHomePaths.ts";

export { CODEX_GENERATED_IMAGE_ARTIFACT_KIND };

const CODEX_GENERATED_IMAGE_ITEM_TYPES = new Set([
  "imagegeneration",
  "imagegenerationcall",
  "imagegenerationend",
]);

const IMAGE_PATH_KEYS = ["saved_path", "savedPath", "path", "file_path"] as const;
const IMAGE_CALL_ID_KEYS = ["call_id", "callId", "itemId", "item_id", "id"] as const;

export interface CodexGeneratedImageReference {
  readonly path: string;
  readonly callId?: string;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function normalizeNonEmptyString(value: unknown): string | undefined {
  const trimmed = asString(value)?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeCodexGeneratedImageItemType(raw: unknown): string {
  const type = normalizeNonEmptyString(raw);
  if (!type) return "";
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1$2")
    .replace(/[._\s/-]+/g, "")
    .trim()
    .toLowerCase();
}

export function isCodexGeneratedImageItemType(raw: unknown): boolean {
  return CODEX_GENERATED_IMAGE_ITEM_TYPES.has(normalizeCodexGeneratedImageItemType(raw));
}

export const isSupportedLocalImagePath = isSupportedLocalImagePathShared;

/**
 * Instance launch context that decides which Codex home a session writes
 * under: account-scoped and shadow-home instances write beneath their own
 * account overlay, not the default one.
 */
export interface CodexGeneratedImageHomeContext {
  readonly homePath?: string | undefined;
  readonly shadowHomePath?: string | undefined;
  readonly accountId?: string | undefined;
  /**
   * Per-instance launch environment. Its `SYNARA_HOME` selects the managed
   * overlay for that child independently of the server process environment.
   */
  readonly environment?: Readonly<Record<string, string>> | undefined;
}

/**
 * Resolves the home directory the codex app-server child process actually
 * writes images under for the current process env. Synara uses its isolated
 * Codex overlay, not the user's source `~/.codex` directory.
 */
export function resolveCodexHomePath(codexHome?: string | CodexGeneratedImageHomeContext): string {
  const context: CodexGeneratedImageHomeContext =
    typeof codexHome === "string" ? { homePath: codexHome } : (codexHome ?? {});
  return resolveActiveCodexHomeWritePath({
    ...(context.homePath?.trim() ? { homePath: context.homePath } : {}),
    ...(context.shadowHomePath?.trim() ? { shadowHomePath: context.shadowHomePath } : {}),
    ...(context.accountId?.trim() ? { accountId: context.accountId } : {}),
    // The child runs with the instance environment layered over the server's,
    // so overlay prediction must see the same merged view.
    ...(context.environment ? { env: { ...process.env, ...context.environment } } : {}),
  });
}

/** The single generated-images directory we predict against (overlay-aware). */
export function resolveCodexGeneratedImagesRoot(
  codexHome?: string | CodexGeneratedImageHomeContext,
): string {
  return path.join(resolveCodexHomePath(codexHome), "generated_images");
}

/**
 * Every Codex home configured in settings (default override plus per-instance
 * dedicated homes). Dedicated homes anchor their own overlay roots, so the
 * local-image route must enumerate them to allowlist those accounts' images.
 */
export function codexConfiguredHomePathsFromSettings(settings: ServerSettings): readonly string[] {
  const homePaths = new Set<string>();
  const defaultHomePath = settings.providers.codex.homePath?.trim();
  if (defaultHomePath) {
    homePaths.add(defaultHomePath);
  }
  for (const instance of deriveProviderInstances(settings)) {
    if (instance.driver !== "codex") {
      continue;
    }
    const instanceHomePath = instance.config.homePath;
    if (typeof instanceHomePath === "string" && instanceHomePath.trim()) {
      homePaths.add(instanceHomePath.trim());
    }
    // With the browser-plugin overlay disabled, shadow-home accounts run with
    // the shadow directory as CODEX_HOME and write images beneath it.
    const instanceShadowHomePath = instance.config.shadowHomePath;
    if (typeof instanceShadowHomePath === "string" && instanceShadowHomePath.trim()) {
      homePaths.add(instanceShadowHomePath.trim());
    }
    // Instances write under the home their launch options and per-instance
    // environment resolve to (env vars can relocate CODEX_HOME or the overlay
    // root). Add that write home so predicted image paths stay allowlisted —
    // this mirrors the resolution generated-image events use.
    const codexOptions = providerStartOptionsFromInstance(instance)?.codex;
    if (codexOptions) {
      homePaths.add(resolveCodexHomePath(codexOptions));
    }
  }
  return [...homePaths];
}

/**
 * All generated-images directories the local-image route should treat as
 * legitimate. Includes both the source `~/.codex/generated_images` and the
 * overlay `<SYNARA_HOME>/codex-home-overlay/generated_images` so we serve
 * images regardless of which home Codex wrote them under.
 */
export function resolveCodexGeneratedImagesRoots(homePath?: string): readonly string[] {
  return resolveCodexHomeAllowlistCandidates(homePath?.trim() ? { homePath } : {}).map((home) =>
    path.join(home, "generated_images"),
  );
}

export function firstStringValue(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = normalizeNonEmptyString(record[key]);
    if (value) return value;
  }
  return undefined;
}

export function extractCodexGeneratedImagePath(
  record: Record<string, unknown> | undefined,
): string | undefined {
  return firstStringValue(record, IMAGE_PATH_KEYS);
}

export function extractCodexGeneratedImageCallId(
  record: Record<string, unknown> | undefined,
): string | undefined {
  return firstStringValue(record, IMAGE_CALL_ID_KEYS);
}

export function predictedCodexGeneratedImagePath(input: {
  readonly item: Record<string, unknown>;
  readonly threadId: ThreadId | string | undefined;
  readonly codexHome?: string | CodexGeneratedImageHomeContext;
}): string | undefined {
  const threadId = normalizeNonEmptyString(input.threadId);
  const callId = extractCodexGeneratedImageCallId(input.item);
  if (!threadId || !callId) {
    return undefined;
  }
  return path.join(resolveCodexGeneratedImagesRoot(input.codexHome), threadId, `${callId}.png`);
}

// Mirrors Remodex relay behavior: keep metadata, drop bulky inline image data.
export function annotateCodexGeneratedImagePayload(input: {
  readonly value: unknown;
  readonly threadId: ThreadId | string | undefined;
  readonly codexHome?: string | CodexGeneratedImageHomeContext;
}): unknown {
  const item = asObject(input.value);
  if (!item || !isCodexGeneratedImageItemType(item.type ?? item.kind)) {
    return input.value;
  }

  let nextItem = item;
  let didChange = false;
  const existingPath = extractCodexGeneratedImagePath(item);
  const generatedPath =
    existingPath ??
    predictedCodexGeneratedImagePath({
      item,
      threadId: input.threadId,
      ...(input.codexHome ? { codexHome: input.codexHome } : {}),
    });

  if (generatedPath && !existingPath) {
    nextItem = { ...nextItem, saved_path: generatedPath };
    didChange = true;
  }

  if (typeof nextItem.result === "string" && nextItem.result.length > 0) {
    const { result: _result, ...withoutResult } = nextItem;
    nextItem = { ...withoutResult, result_elided_for_relay: true };
    didChange = true;
  }

  return didChange ? nextItem : input.value;
}

export function sanitizeNestedCodexGeneratedImagePayloads(input: {
  readonly value: unknown;
  readonly threadId: ThreadId | string | undefined;
  readonly codexHome?: string | CodexGeneratedImageHomeContext;
}): unknown {
  const annotated = annotateCodexGeneratedImagePayload(input);
  const record = asObject(annotated);
  if (!record) {
    return annotated;
  }

  // Collect any nested replacements first, then build the result with a single
  // Object.assign to avoid the O(n^2) spread-in-loop pattern oxlint flags.
  const overrides: Record<string, unknown> = {};
  let hasOverrides = false;
  for (const key of NESTED_PAYLOAD_KEYS) {
    const nested = record[key];
    if (!asObject(nested)) {
      continue;
    }
    const sanitized = sanitizeNestedCodexGeneratedImagePayloads({
      value: nested,
      threadId: input.threadId,
      ...(input.codexHome ? { codexHome: input.codexHome } : {}),
    });
    if (sanitized !== nested) {
      overrides[key] = sanitized;
      hasOverrides = true;
    }
  }

  if (hasOverrides) {
    return Object.assign({}, record, overrides);
  }
  return annotated !== input.value ? record : input.value;
}

const NESTED_PAYLOAD_KEYS = ["item", "payload", "data", "event"] as const;

export function extractCodexGeneratedImageReference(input: {
  readonly value: unknown;
  readonly threadId: ThreadId | string | undefined;
  readonly codexHome?: string | CodexGeneratedImageHomeContext;
}): CodexGeneratedImageReference | undefined {
  const item = asObject(input.value);
  if (!item || !isCodexGeneratedImageItemType(item.type ?? item.kind)) {
    return undefined;
  }
  const imagePath =
    extractCodexGeneratedImagePath(item) ??
    predictedCodexGeneratedImagePath({
      item,
      threadId: input.threadId,
      ...(input.codexHome ? { codexHome: input.codexHome } : {}),
    });
  if (!imagePath || !isSupportedLocalImagePath(imagePath)) {
    return undefined;
  }
  const callId = extractCodexGeneratedImageCallId(item);
  return {
    path: imagePath,
    ...(callId ? { callId } : {}),
  };
}

export function codexGeneratedImageArtifact(
  reference: CodexGeneratedImageReference,
): CodexGeneratedImageArtifact {
  return {
    kind: CODEX_GENERATED_IMAGE_ARTIFACT_KIND,
    path: reference.path,
    ...(reference.callId ? { callId: reference.callId } : {}),
  };
}

export function isCodexGeneratedImageArtifact(
  value: unknown,
): value is CodexGeneratedImageArtifact {
  const record = asObject(value);
  return (
    record?.kind === CODEX_GENERATED_IMAGE_ARTIFACT_KIND &&
    typeof record.path === "string" &&
    record.path.trim().length > 0
  );
}

export function markdownImagePath(filePath: string): string {
  const trimmed = filePath.trim();
  if (trimmed.includes(")") || trimmed.includes(" ") || trimmed.includes("%")) {
    const escaped = trimmed.replaceAll("%", "%25").replaceAll(">", "%3E").replaceAll(")", "%29");
    return `<${escaped}>`;
  }
  return trimmed;
}

export function generatedImageMarkdown(filePath: string): string {
  return `![Generated image](${markdownImagePath(filePath)})`;
}

/**
 * Returns the local file path of a Codex-generated image carried by an
 * `item.completed` runtime event, or `undefined` for any other event shape.
 */
export function generatedImagePathFromRuntimeEvent(
  event: ProviderRuntimeEvent,
): string | undefined {
  if (event.type !== "item.completed" || event.payload.itemType !== "image_generation") {
    return undefined;
  }
  const artifact = isCodexGeneratedImageArtifact(event.payload.data)
    ? event.payload.data
    : undefined;
  return artifact?.path;
}

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
  type ProviderInstanceId,
  type ServerSettings,
  type ThreadId,
} from "@synara/contracts";
import { isSupportedLocalImagePath as isSupportedLocalImagePathShared } from "@synara/shared/localPreviewFiles";
import {
  deriveProviderInstances,
  providerStartOptionsFromInstance,
} from "@synara/shared/providerInstances";

import {
  type CodexHomePathsInput,
  resolveActiveCodexHomeWritePath,
  resolveBaseCodexHomePath,
  resolveCodexHomeAllowlistCandidates,
} from "./codexHomePaths.ts";
import { codexPathsReferenceSameLocation } from "./codexPathIdentity.ts";

export { CODEX_GENERATED_IMAGE_ARTIFACT_KIND };

const CODEX_GENERATED_IMAGE_ITEM_TYPES = new Set([
  "imagegeneration",
  "imagegenerationcall",
  "imagegenerationend",
  "imageview",
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
  /** Per-instance launch environment, including any relocated Synara home. */
  readonly environment?: Readonly<Record<string, string>> | undefined;
}

export type CodexGeneratedImageHomeCandidate = string | CodexGeneratedImageHomeContext;

const CODEX_HOME_CONTEXT_ENV_KEYS = ["CODEX_HOME", "SYNARA_HOME"] as const;

function codexHomePathsInputFromContext(
  codexHome?: CodexGeneratedImageHomeCandidate,
): CodexHomePathsInput {
  const context: CodexGeneratedImageHomeContext =
    typeof codexHome === "string" ? { homePath: codexHome } : (codexHome ?? {});
  const env = context.environment ? { ...process.env, ...context.environment } : process.env;
  const explicitHomePath = context.homePath?.trim();
  const accountSourceHomeIsDedicated = Boolean(
    explicitHomePath &&
    !codexPathsReferenceSameLocation(
      resolveBaseCodexHomePath(env, explicitHomePath),
      resolveBaseCodexHomePath(env),
    ),
  );
  return {
    ...(explicitHomePath ? { homePath: explicitHomePath } : {}),
    ...(context.shadowHomePath?.trim() ? { shadowHomePath: context.shadowHomePath } : {}),
    ...(context.accountId?.trim() ? { accountId: context.accountId } : {}),
    // The child runs with the instance environment layered over the server's,
    // so the write-home decision must see the same merged view.
    ...(context.environment ? { env } : {}),
    ...(explicitHomePath ? { accountSourceHomeIsDedicated } : {}),
  };
}

function codexHomeCandidateKey(candidate: CodexGeneratedImageHomeCandidate): string {
  if (typeof candidate === "string") {
    return `path:${candidate.trim()}`;
  }
  const envKey = CODEX_HOME_CONTEXT_ENV_KEYS.map(
    (key) => `${key}=${candidate.environment?.[key] ?? ""}`,
  ).join("\0");
  return JSON.stringify([
    candidate.homePath?.trim() ?? "",
    candidate.shadowHomePath?.trim() ?? "",
    candidate.accountId?.trim() ?? "",
    envKey,
  ]);
}

/**
 * Resolves the home directory the codex app-server child process actually
 * writes images under for the current process env. This is Synara's isolated
 * overlay—not the user's source `~/.codex`—and account-scoped instances use
 * their own overlay.
 */
export function resolveCodexHomePath(codexHome?: string | CodexGeneratedImageHomeContext): string {
  return resolveActiveCodexHomeWritePath(codexHomePathsInputFromContext(codexHome));
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
export function codexConfiguredHomePathsFromSettings(
  settings: ServerSettings,
): readonly CodexGeneratedImageHomeCandidate[] {
  const candidates = new Map<string, CodexGeneratedImageHomeCandidate>();
  const addCandidate = (candidate: CodexGeneratedImageHomeCandidate | undefined) => {
    if (!candidate) {
      return;
    }
    if (typeof candidate === "string" && !candidate.trim()) {
      return;
    }
    candidates.set(codexHomeCandidateKey(candidate), candidate);
  };

  for (const instance of deriveProviderInstances(settings)) {
    if (instance.driver !== "codex" || !instance.enabled) {
      continue;
    }
    // Keep the full account/shadow/environment context. Collapsing this to a
    // plain home path loses account overlay roots and can cross-allowlist data.
    const codexOptions = providerStartOptionsFromInstance(instance)?.codex;
    // The enabled default instance normally has no explicit launch options;
    // an empty context intentionally resolves its ambient/default Codex roots.
    addCandidate(codexOptions ?? (instance.isDefault ? {} : undefined));
  }
  return [...candidates.values()];
}

export function enabledCodexProviderInstanceIdsFromSettings(
  settings: ServerSettings,
): ReadonlySet<ProviderInstanceId> {
  return new Set(
    deriveProviderInstances(settings)
      .filter((instance) => instance.driver === "codex" && instance.enabled)
      .map((instance) => instance.instanceId),
  );
}

export function resolveCodexGeneratedImagesRoots(
  homePath?: CodexGeneratedImageHomeCandidate,
): readonly string[] {
  return resolveCodexHomeAllowlistCandidates(codexHomePathsInputFromContext(homePath)).map((home) =>
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

/**
 * Returns true when the given assistant text contains only generated-image
 * markdown references (e.g. `![Generated image](...)`) and no other content.
 *
 * Used by ingestion to skip messages that exist solely to host an image when
 * deciding where to append a new generated-image reference.
 */
export function isGeneratedImageOnlyMarkdown(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return false;
  }
  const withoutImages = trimmed.replace(/!\[[^\]]*]\((?:<[^>]+>|[^)]+)\)/g, "").trim();
  return withoutImages.length === 0;
}

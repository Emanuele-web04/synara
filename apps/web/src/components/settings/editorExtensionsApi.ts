import type { EditorExtensionsInput, EditorExtensionsResult } from "@synara/contracts";
import { ensureNativeApi } from "~/nativeApi";

export const EXTENSION_STATE_KEY = ["editor-extensions"] as const;

/** Catalog and lifecycle actions use the same authenticated native API. */
export function requestEditorExtensions(
  input: EditorExtensionsInput,
  signal?: AbortSignal,
): Promise<EditorExtensionsResult> {
  const extensions = ensureNativeApi().editor?.extensions;
  if (!extensions) return Promise.reject(new Error("This server does not provide editor extension management."));
  return extensions(input, signal ? { signal } : undefined);
}

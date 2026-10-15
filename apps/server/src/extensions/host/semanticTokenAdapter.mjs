import { decodeSemanticTokensDto } from "@code-oss/vs/editor/common/services/semanticTokensDto.js";

/** Return an owned full snapshot, never the binary RPC envelope or a live cache. */
export async function requestSemanticTokens(target, handle, resource, cancellation) {
  // Zero explicitly asks upstream for a full result, not a delta against another
  // document/client's cache. No host cache id crosses the native JSON boundary.
  const encoded = await target.$provideDocumentSemanticTokens(handle, resource, 0, cancellation);
  if (!encoded) return null;
  const result = decodeSemanticTokensDto(encoded);
  try {
    if (result.type !== "full")
      throw new Error("Expected a full extension semantic-token snapshot.");
    if (result.data.length > 250_000 || result.data.length % 5 !== 0) {
      throw new Error("Extension semantic tokens exceed their size or tuple boundary.");
    }
    if (cancellation.isCancellationRequested) return null;
    return { data: Array.from(result.data) };
  } finally {
    await target.$releaseDocumentSemanticTokens(handle, result.id);
  }
}

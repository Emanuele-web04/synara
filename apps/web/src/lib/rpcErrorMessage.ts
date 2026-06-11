// A rejected WS-RPC call can reach the UI in several shapes: a reconstructed
// Error subclass (WsRpcError), a plain decoded `{ _tag, message, cause }` object
// after JSON transport, or a wrapper whose real cause is nested. Reading the
// message defensively from any of these beats gating on `instanceof Error`,
// which silently drops the server's reason and shows a generic fallback instead.
export function rpcErrorMessage(error: unknown, depth = 0): string | null {
  if (error == null || depth > 4) {
    return null;
  }
  if (typeof error === "string") {
    const trimmed = error.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof error === "object") {
    const record = error as {
      message?: unknown;
      detail?: unknown;
      cause?: unknown;
      error?: unknown;
    };
    if (typeof record.message === "string" && record.message.trim().length > 0) {
      return record.message;
    }
    if (typeof record.detail === "string" && record.detail.trim().length > 0) {
      return record.detail;
    }
    return rpcErrorMessage(record.cause, depth + 1) ?? rpcErrorMessage(record.error, depth + 1);
  }
  return null;
}

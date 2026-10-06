import type { OpenCodeEvent } from "./openCodeClient";
import { createOpenCodeV2EventNormalizer } from "./openCodeV2EventNormalization";
import type { OpenCodeV2Fetch } from "./openCodeV2TransportHttp.ts";

export interface OpenCodeV2EventOptions {
  baseUrl: string;
  headers?: RequestInit["headers"];
  fetchImpl?: OpenCodeV2Fetch;
  signal?: AbortSignal | null | undefined;
  normalize?: ReturnType<typeof createOpenCodeV2EventNormalizer>;
}

const MAX_FRAME_LENGTH = 8 * 1024 * 1024;

/** Read the v2 bus once; the session runtime owns reconnection and reconciliation. */
export async function subscribeOpenCodeV2Events(
  options: OpenCodeV2EventOptions,
): Promise<{ stream: AsyncIterable<OpenCodeEvent> }> {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const headers = new Headers(options.headers);
  headers.set("accept", "text/event-stream");
  const connectionTimeout = setTimeout(
    () => controller.abort(new Error("OpenCode v2 event connection timed out.")),
    15_000,
  );
  let response: Response;
  try {
    response = await (options.fetchImpl ?? globalThis.fetch)(
      `${options.baseUrl.replace(/\/$/, "")}/api/event`,
      { headers, signal, redirect: "error" },
    );
  } finally {
    clearTimeout(connectionTimeout);
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`OpenCode v2 event subscription failed (HTTP ${response.status}).`);
  }
  const contentType = response.headers.get("content-type");
  if (contentType && !contentType.toLowerCase().includes("text/event-stream")) {
    await response.body.cancel();
    throw new Error("OpenCode v2 event subscription did not return an event stream.");
  }
  const reader = response.body.getReader();
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    controller.abort();
  };
  const normalize = options.normalize ?? createOpenCodeV2EventNormalizer();
  const iterator = (async function* () {
    const decoder = new TextDecoder();
    let pending = "";
    let data: string[] = [];
    let frameLength = 0;
    let eventType = "";
    const processLine = (line: string): OpenCodeEvent[] => {
      if (line.length === 0) {
        const payload = data.join("\n");
        const type = eventType;
        data = [];
        eventType = "";
        frameLength = 0;
        if (!payload) return [];
        if (type === "error" || type === "cause") {
          throw new Error("OpenCode v2 event stream reported a server failure.");
        }
        let frame: unknown;
        try {
          frame = JSON.parse(payload);
        } catch {
          throw new Error("OpenCode v2 event stream contained invalid JSON.");
        }
        return normalize(frame);
      }
      if (line.startsWith(":")) return [];
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") eventType = value;
      if (field === "data") {
        // Count field framing too: empty data lines still allocate array entries.
        frameLength += line.length + 1;
        if (frameLength > MAX_FRAME_LENGTH)
          throw new Error("OpenCode v2 event frame is too large.");
        data.push(value);
      }
      return [];
    };
    try {
      while (true) {
        const chunk = await reader.read();
        if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
        pending += decoder.decode(chunk.value, { stream: !chunk.done });
        let start = 0;
        for (let index = 0; index < pending.length; index += 1) {
          const char = pending[index];
          if (char !== "\n" && char !== "\r") continue;
          // A CR at a byte-chunk boundary may be half of a CRLF pair.
          if (char === "\r" && index + 1 === pending.length && !chunk.done) break;
          for (const normalized of processLine(pending.slice(start, index))) yield normalized;
          if (char === "\r" && pending[index + 1] === "\n") index += 1;
          start = index + 1;
        }
        pending = pending.slice(start);
        if (pending.length > MAX_FRAME_LENGTH)
          throw new Error("OpenCode v2 event frame is too large.");
        if (chunk.done) {
          // An incomplete event is not dispatched. The runtime reconciles a disconnected bus.
          break;
        }
      }
    } finally {
      await close();
    }
  })();
  let consumed = false;
  return {
    stream: {
      [Symbol.asyncIterator]() {
        if (consumed) throw new Error("OpenCode event subscriptions can only be consumed once.");
        consumed = true;
        return {
          next: () => iterator.next(),
          async return() {
            await close();
            return iterator.return();
          },
          async throw(error: unknown) {
            await close();
            return iterator.throw(error);
          },
        };
      },
    },
  };
}

import http from "node:http";
import { Transform, pipeline } from "node:stream";

const RESPONSE_HEADERS = new Set([
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "content-disposition",
  "etag",
  "last-modified",
  "cache-control",
  "content-security-policy",
  "x-content-type-options",
]);

/** Rebuild headers at each trust boundary. Never relay cookies or credentials. */
export function resourceRequestHeaders(
  headers: http.IncomingHttpHeaders,
  maxBodyBytes: number,
): http.OutgoingHttpHeaders {
  const result: http.OutgoingHttpHeaders = {};
  const range = headers.range;
  if (range !== undefined) {
    if (maxBodyBytes || !/^bytes=(?:\d+-\d*|-\d+)$/.test(range))
      throw new Error("Only one valid byte range is supported");
    result.range = range;
  }
  if (headers["content-length"] !== undefined) {
    const value = headers["content-length"];
    if (
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) > maxBodyBytes
    )
      throw new Error("Resource request body exceeds limit");
    result["content-length"] = value;
  }
  if (maxBodyBytes) {
    const type = headers["content-type"];
    if (typeof type !== "string" || type.length > 256 || /[\r\n]/.test(type))
      throw new Error("Resource content type is required");
    result["content-type"] = type;
  }
  return result;
}

/** Streaming in both directions, bounded memory, cancellation, and no retries. */
export function proxyResourceRequest(input: {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  target: http.RequestOptions;
  maxBodyBytes: number;
  onDone?: () => void;
}): void {
  let done = false;
  const complete = () => {
    if (!done) {
      done = true;
      clearTimeout(deadline);
      input.onDone?.();
    }
  };
  const upstream = http.request(input.target);
  const deadline = setTimeout(() => fail(new Error("Resource transfer timed out")), 15 * 60_000);
  deadline.unref();
  const fail = (_error: Error) => {
    upstream.destroy();
    if (!input.response.headersSent) input.response.writeHead(502, { "Cache-Control": "no-store" });
    input.response.destroy();
    complete();
  };
  input.response.once("close", () => {
    upstream.destroy();
    complete();
  });
  input.request.once("aborted", () => fail(new Error("Resource caller cancelled")));
  upstream.once("error", fail);
  upstream.once("response", (remote) => {
    const headers: http.OutgoingHttpHeaders = { "Cache-Control": "no-store" };
    for (const [name, value] of Object.entries(remote.headers))
      if (RESPONSE_HEADERS.has(name) && value !== undefined) headers[name] = value;
    // Redirects are never followed and never expose an upstream Location.
    const status = remote.statusCode ?? 502;
    if (status >= 300 && status < 400 && status !== 304) {
      remote.destroy();
      input.response.writeHead(502).end();
      complete();
      return;
    }
    input.response.writeHead(status, headers);
    // The Effect HTTP adapter already observes the response lifecycle. Keep one
    // owned listener per terminal event instead of pipeline's extra response
    // listener set; pipe still propagates writable backpressure.
    remote.once("error", fail);
    remote.once("aborted", () => fail(new Error("Remote response truncated")));
    input.response.once("error", fail);
    input.response.once("finish", complete);
    remote.pipe(input.response);
  });
  let bytes = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(
        bytes > input.maxBodyBytes ? new Error("Resource request body exceeds limit") : null,
        chunk,
      );
    },
  });
  pipeline(input.request, limit, upstream, (error) => {
    if (error) fail(error);
  });
}

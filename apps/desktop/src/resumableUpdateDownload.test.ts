import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildDownloadHeaders,
  classifyDownloadResponse,
  computeProgressInfo,
  computeRetryDelayMs,
  DEFAULT_RESUMABLE_DOWNLOAD_CONFIG,
  installIdleTimeout,
  installResumableUpdateDownloader,
  isCrossOrigin,
  parseContentRangeTotal,
  type ResumableDownloaderTarget,
  type UpdaterHttpExecutorLike,
  selectSha512Encoding,
  shouldGiveUp,
} from "./resumableUpdateDownload";

describe("computeProgressInfo", () => {
  it("computes percent and throughput", () => {
    const info = computeProgressInfo({
      transferred: 50,
      total: 200,
      delta: 10,
      elapsedMs: 2000,
    });
    expect(info).toEqual({
      total: 200,
      delta: 10,
      transferred: 50,
      percent: 25,
      bytesPerSecond: 25,
    });
  });

  it("avoids divide-by-zero on total and elapsed", () => {
    const info = computeProgressInfo({ transferred: 0, total: 0, delta: 0, elapsedMs: 0 });
    expect(info.percent).toBe(0);
    expect(Number.isFinite(info.bytesPerSecond)).toBe(true);
  });
});

describe("parseContentRangeTotal", () => {
  it("extracts the total from a satisfied range", () => {
    expect(parseContentRangeTotal("bytes 200-1000/1001")).toBe(1001);
  });

  it("extracts the total from an unsatisfied range", () => {
    expect(parseContentRangeTotal("bytes */1001")).toBe(1001);
  });

  it("returns null for missing or unknown totals", () => {
    expect(parseContentRangeTotal(null)).toBeNull();
    expect(parseContentRangeTotal(undefined)).toBeNull();
    expect(parseContentRangeTotal("bytes 0-100/*")).toBeNull();
    expect(parseContentRangeTotal("garbage")).toBeNull();
  });
});

describe("selectSha512Encoding", () => {
  it("treats a 128-char hex digest as hex", () => {
    expect(selectSha512Encoding("a".repeat(128))).toBe("hex");
  });

  it("treats base64 digests (with padding/+/Z or other length) as base64", () => {
    expect(selectSha512Encoding("a".repeat(86) + "==")).toBe("base64");
    expect(selectSha512Encoding("Z".repeat(128))).toBe("base64");
    expect(selectSha512Encoding("a".repeat(127) + "+")).toBe("base64");
  });
});

describe("isCrossOrigin", () => {
  it("treats identical scheme/host/port as same-origin", () => {
    expect(
      isCrossOrigin(
        new URL("https://github.com/owner/repo/releases/download/v1/app.zip"),
        new URL("https://github.com/owner/repo/releases/download/v1/app.zip"),
      ),
    ).toBe(false);
  });

  it("ignores path and query differences on the same origin", () => {
    expect(
      isCrossOrigin(
        new URL("https://github.com/a/app.zip"),
        new URL("https://github.com/b/app.zip?token=signed"),
      ),
    ).toBe(false);
  });

  it("flags a different host as cross-origin (GitHub -> signed CDN)", () => {
    expect(
      isCrossOrigin(
        new URL("https://github.com/owner/repo/releases/download/v1/app.zip"),
        new URL("https://objects.githubusercontent.com/storage/app.zip?token=signed"),
      ),
    ).toBe(true);
  });

  it("flags a scheme change as cross-origin", () => {
    expect(isCrossOrigin(new URL("https://host/x"), new URL("http://host/x"))).toBe(true);
  });

  it("treats an explicit default port as same-origin", () => {
    expect(isCrossOrigin(new URL("https://host:443/x"), new URL("https://host/x"))).toBe(false);
  });

  it("flags a non-default port as cross-origin", () => {
    expect(isCrossOrigin(new URL("https://host:8443/x"), new URL("https://host/x"))).toBe(true);
  });

  it("compares hostnames case-insensitively", () => {
    expect(isCrossOrigin(new URL("https://GitHub.com/x"), new URL("https://github.com/x"))).toBe(
      false,
    );
  });
});

describe("buildDownloadHeaders", () => {
  it("keeps the auth token and copies call headers when same-origin", () => {
    const headers = buildDownloadHeaders({
      callHeaders: { authorization: "token secret", "X-Custom": "v" },
      startOffset: 0,
      attachAuth: true,
    });
    expect(headers["authorization"]).toBe("token secret");
    expect(headers["X-Custom"]).toBe("v");
  });

  it("strips authorization and proxy-authorization when cross-origin", () => {
    const headers = buildDownloadHeaders({
      callHeaders: {
        Authorization: "token secret",
        "Proxy-Authorization": "basic abc",
        "X-Keep": "yes",
      },
      startOffset: 0,
      attachAuth: false,
    });
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["Proxy-Authorization"]).toBeUndefined();
    expect(headers["X-Keep"]).toBe("yes");
  });

  it("adds a Range header only when resuming from a non-zero offset", () => {
    const atZero = buildDownloadHeaders({ callHeaders: null, startOffset: 0, attachAuth: true });
    expect(atZero["Range"]).toBeUndefined();
    const resumed = buildDownloadHeaders({
      callHeaders: null,
      startOffset: 1024,
      attachAuth: true,
    });
    expect(resumed["Range"]).toBe("bytes=1024-");
  });

  it("defaults User-Agent and forces Cache-Control no-cache", () => {
    const headers = buildDownloadHeaders({ callHeaders: null, startOffset: 0, attachAuth: true });
    expect(headers["User-Agent"]).toBe("electron-builder");
    expect(headers["Cache-Control"]).toBe("no-cache");
  });

  it("preserves a caller-provided User-Agent", () => {
    const headers = buildDownloadHeaders({
      callHeaders: { "User-Agent": "synara/1.0" },
      startOffset: 0,
      attachAuth: true,
    });
    expect(headers["User-Agent"]).toBe("synara/1.0");
  });
});

describe("classifyDownloadResponse", () => {
  it("appends on 206 using Content-Range total", () => {
    expect(
      classifyDownloadResponse({
        statusCode: 206,
        contentRange: "bytes 100-1000/1001",
        contentLength: 901,
        bytesAlreadyDownloaded: 100,
      }),
    ).toEqual({ kind: "append", total: 1001 });
  });

  it("derives total from Content-Length + offset on 206 without Content-Range", () => {
    expect(
      classifyDownloadResponse({
        statusCode: 206,
        contentRange: null,
        contentLength: 900,
        bytesAlreadyDownloaded: 100,
      }),
    ).toEqual({ kind: "append", total: 1000 });
  });

  it("restarts from zero on 200 (server ignored Range)", () => {
    expect(
      classifyDownloadResponse({
        statusCode: 200,
        contentRange: null,
        contentLength: 1001,
        bytesAlreadyDownloaded: 500,
      }),
    ).toEqual({ kind: "fromStart", total: 1001 });
  });

  it("treats 416 as already complete", () => {
    expect(
      classifyDownloadResponse({
        statusCode: 416,
        contentRange: "bytes */1001",
        contentLength: null,
        bytesAlreadyDownloaded: 1001,
      }),
    ).toEqual({ kind: "complete" });
  });

  it("marks 429 and 5xx as retryable", () => {
    for (const statusCode of [429, 500, 502, 503, 504]) {
      expect(
        classifyDownloadResponse({
          statusCode,
          contentRange: null,
          contentLength: null,
          bytesAlreadyDownloaded: 0,
        }),
      ).toEqual({ kind: "retryable", statusCode });
    }
  });

  it("marks other 4xx as fatal", () => {
    for (const statusCode of [400, 403, 404]) {
      expect(
        classifyDownloadResponse({
          statusCode,
          contentRange: null,
          contentLength: null,
          bytesAlreadyDownloaded: 0,
        }),
      ).toEqual({ kind: "fatal", statusCode });
    }
  });
});

describe("computeRetryDelayMs", () => {
  const config = { retryBaseDelayMs: 500, retryMaxDelayMs: 5_000 };

  it("reconnects immediately after fresh progress", () => {
    expect(computeRetryDelayMs(0, config)).toBe(0);
    expect(computeRetryDelayMs(1, config)).toBe(0);
  });

  it("backs off exponentially and clamps to the max", () => {
    expect(computeRetryDelayMs(2, config)).toBe(500);
    expect(computeRetryDelayMs(3, config)).toBe(1000);
    expect(computeRetryDelayMs(4, config)).toBe(2000);
    expect(computeRetryDelayMs(10, config)).toBe(5000);
  });
});

describe("installIdleTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  type Listener = (...args: unknown[]) => void;

  function makeEmitter() {
    const listeners = new Map<string, Listener[]>();
    return {
      on(event: string, listener: Listener) {
        const existing = listeners.get(event) ?? [];
        existing.push(listener);
        listeners.set(event, existing);
      },
      emit(event: string, ...args: unknown[]) {
        for (const listener of listeners.get(event) ?? []) {
          listener(...args);
        }
      },
    };
  }

  function setup() {
    const responseEmitter = makeEmitter();
    const requestEmitter = makeEmitter();
    const abort = vi.fn();
    const onTimeout = vi.fn();
    const request = {
      on: requestEmitter.on,
      abort,
    } as unknown as Parameters<typeof installIdleTimeout>[0];
    installIdleTimeout(request, onTimeout, 15_000);
    return { responseEmitter, requestEmitter, abort, onTimeout };
  }

  it("aborts and reports a timeout after inactivity before any response", () => {
    const { abort, onTimeout } = setup();
    vi.advanceTimersByTime(15_000);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("resets the idle window on every response data chunk", () => {
    const { responseEmitter, requestEmitter, abort, onTimeout } = setup();
    requestEmitter.emit("response", responseEmitter);
    vi.advanceTimersByTime(10_000);
    responseEmitter.emit("data");
    vi.advanceTimersByTime(10_000);
    responseEmitter.emit("data");
    vi.advanceTimersByTime(10_000);
    expect(abort).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5_000);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("stops the timer when the response ends", () => {
    const { responseEmitter, requestEmitter, abort, onTimeout } = setup();
    requestEmitter.emit("response", responseEmitter);
    responseEmitter.emit("end");
    vi.advanceTimersByTime(60_000);
    expect(abort).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("stops the timer when the request errors or closes", () => {
    const { requestEmitter, abort, onTimeout } = setup();
    requestEmitter.emit("error");
    vi.advanceTimersByTime(60_000);
    expect(abort).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();
  });
});

describe("shouldGiveUp", () => {
  const config = DEFAULT_RESUMABLE_DOWNLOAD_CONFIG;

  it("keeps going while making progress within bounds", () => {
    expect(
      shouldGiveUp({ consecutiveStallCount: 3, totalAttempts: 5, elapsedMs: 10_000, config }),
    ).toBe(false);
  });

  it("gives up after too many consecutive zero-progress attempts", () => {
    expect(
      shouldGiveUp({
        consecutiveStallCount: config.maxConsecutiveStallRetries + 1,
        totalAttempts: 5,
        elapsedMs: 10_000,
        config,
      }),
    ).toBe(true);
  });

  it("gives up past the absolute attempt and time caps", () => {
    expect(
      shouldGiveUp({
        consecutiveStallCount: 0,
        totalAttempts: config.maxTotalAttempts + 1,
        elapsedMs: 0,
        config,
      }),
    ).toBe(true);
    expect(
      shouldGiveUp({
        consecutiveStallCount: 0,
        totalAttempts: 1,
        elapsedMs: config.overallTimeoutMs + 1,
        config,
      }),
    ).toBe(true);
  });
});

// End-to-end integration: a real loopback HTTP server, the real Electron-style
// request shape (node's http ClientRequest/IncomingMessage match it structurally),
// and the real installResumableUpdateDownloader wiring. These prove the behaviour
// the pure helpers can only imply: the downloader actually resumes from a byte
// offset after a mid-stream drop and verifies the published checksum.
describe("installResumableUpdateDownloader (integration)", () => {
  // Deterministic 256 KiB payload so resume offsets are reproducible.
  const payload = Buffer.alloc(256 * 1024);
  for (let i = 0; i < payload.length; i += 1) {
    payload[i] = i % 251;
  }
  const payloadSha512Base64 = createHash("sha512").update(payload).digest("base64");

  let tempDir: string;
  let server: Server | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "resumable-dl-"));
  });
  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    await rm(tempDir, { force: true, recursive: true });
  });

  // node's http request/response are structurally compatible with the Electron
  // net shapes the downloader expects (on data/end/error/aborted, pause/resume,
  // statusCode/headers; on error/abort/close, end, abort). This adapter is the
  // executor.createRequest the real updater would provide. The unused Electron
  // `redirect` event is simply never emitted by node, which is fine for the
  // same-origin loopback transfer under test.
  function makeExecutor(baseUrl: URL): UpdaterHttpExecutorLike {
    return {
      createRequest: (
        options: Parameters<UpdaterHttpExecutorLike["createRequest"]>[0],
        callback: Parameters<UpdaterHttpExecutorLike["createRequest"]>[1],
      ) =>
        httpRequest(
          {
            protocol: baseUrl.protocol,
            hostname: baseUrl.hostname,
            port: baseUrl.port,
            path: String(options.path ?? "/"),
            method: "GET",
            headers: (options.headers ?? {}) as Record<string, string>,
          },
          (res) => callback(res as never),
        ) as unknown as ReturnType<UpdaterHttpExecutorLike["createRequest"]>,
      download: () => {
        throw new Error("download must be replaced by installResumableUpdateDownloader");
      },
    };
  }

  function makeCancellationToken() {
    return {
      cancelled: false,
      createPromise<T>(
        executor: (
          resolve: (value: T) => void,
          reject: (error: Error) => void,
          onCancel: (handler: () => void) => void,
        ) => void,
      ): Promise<T> {
        return new Promise<T>((resolve, reject) => {
          executor(resolve, reject, () => {});
        });
      },
    };
  }

  it("returns false when the executor is not yet available", () => {
    expect(installResumableUpdateDownloader({ httpExecutor: null })).toBe(false);
  });

  it("resumes from the on-disk offset after a mid-stream drop and verifies sha512", async () => {
    let fullRequests = 0;
    let rangeRequests = 0;
    server = createServer((req, res) => {
      const range = req.headers["range"];
      if (typeof range === "string") {
        rangeRequests += 1;
        const start = Number(range.match(/bytes=(\d+)-/)?.[1] ?? "0");
        const slice = payload.subarray(start);
        res.writeHead(206, {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(slice.length),
          "Content-Range": `bytes ${start}-${payload.length - 1}/${payload.length}`,
        });
        res.end(slice);
        return;
      }
      // First connection: deliver a clean prefix, then sever the socket so the
      // client must resume from wherever it got to (the core stall scenario).
      fullRequests += 1;
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(payload.length),
      });
      res.write(payload.subarray(0, payload.length / 2), () => {
        // FIN after flush: the prefix is delivered, then the stream ends early.
        res.socket?.end();
      });
    });
    const baseUrl = await listen(server);

    const updater: ResumableDownloaderTarget = { httpExecutor: makeExecutor(baseUrl) };
    const installed = installResumableUpdateDownloader(
      updater,
      { idleTimeoutMs: 2_000, progressThrottleMs: 0 },
      silentLogger(),
    );
    expect(installed).toBe(true);

    const destination = join(tempDir, "update.zip");
    const progressPercents: number[] = [];
    const returned = await updater.httpExecutor!.download(baseUrl, destination, {
      headers: {},
      cancellationToken: makeCancellationToken(),
      sha512: payloadSha512Base64,
      onProgress: (info) => progressPercents.push(info.percent),
    });

    expect(returned).toBe(destination);
    // The downloaded file is byte-for-byte the published payload...
    const downloaded = await readFile(destination);
    expect(downloaded.equals(payload)).toBe(true);
    // ...assembled across one dropped attempt + at least one ranged resume.
    expect(fullRequests).toBe(1);
    expect(rangeRequests).toBeGreaterThanOrEqual(1);
    expect(progressPercents.at(-1)).toBe(100);
  });

  it("rejects and re-downloads once when the checksum does not match", async () => {
    let requests = 0;
    server = createServer((req, res) => {
      requests += 1;
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(payload.length),
      });
      res.end(payload);
    });
    const baseUrl = await listen(server);

    const updater: ResumableDownloaderTarget = { httpExecutor: makeExecutor(baseUrl) };
    installResumableUpdateDownloader(updater, { progressThrottleMs: 0 }, silentLogger());

    const destination = join(tempDir, "update.zip");
    await expect(
      updater.httpExecutor!.download(baseUrl, destination, {
        headers: {},
        cancellationToken: makeCancellationToken(),
        sha512: createHash("sha512").update("not-the-payload").digest("base64"),
      }),
    ).rejects.toThrow(/checksum mismatch/i);
    // Verifies the bad bytes were discarded and re-fetched from zero exactly once.
    expect(requests).toBe(2);
  });
});

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function listen(server: Server): Promise<URL> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(new URL(`http://127.0.0.1:${address.port}/update.zip`));
    });
  });
}

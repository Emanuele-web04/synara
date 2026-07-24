import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { captureBackendProcessOutput } from "./backendProcessOutput";

describe("captureBackendProcessOutput", () => {
  it("tees piped output to startup detectors and development stdio", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const forwardedStdout: Buffer[] = [];
    const forwardedStderr: Buffer[] = [];
    const detected: Buffer[] = [];

    const capture = captureBackendProcessOutput({
      stdout,
      stderr,
      writeStdout: (chunk) => forwardedStdout.push(chunk),
      writeStderr: (chunk) => forwardedStderr.push(chunk),
      detectors: [{ push: (chunk) => detected.push(chunk) }],
    });

    stdout.write("Server listening");
    stderr.write("DatabaseLifecycleLockedError:");

    expect(Buffer.concat(forwardedStdout).toString("utf8")).toBe("Server listening");
    expect(Buffer.concat(forwardedStderr).toString("utf8")).toBe(
      "DatabaseLifecycleLockedError:",
    );
    expect(Buffer.concat(detected).toString("utf8")).toBe(
      "Server listeningDatabaseLifecycleLockedError:",
    );
    stdout.end();
    stderr.end();
    await capture.drained;
  });

  it("writes to the packaged log without duplicating output to stdio", async () => {
    const stdout = new PassThrough();
    const logged: Buffer[] = [];
    const forwarded: Buffer[] = [];

    const capture = captureBackendProcessOutput({
      stdout,
      stderr: null,
      writeLog: (chunk) => logged.push(chunk),
      writeStdout: (chunk) => forwarded.push(chunk),
      writeStderr: (chunk) => forwarded.push(chunk),
      detectors: [],
    });

    stdout.write("packaged backend output");

    expect(Buffer.concat(logged).toString("utf8")).toBe("packaged backend output");
    expect(forwarded).toEqual([]);
    stdout.end();
    await capture.drained;
  });

  it("does not report drained until both output streams finish", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let drained = false;

    const capture = captureBackendProcessOutput({
      stdout,
      stderr,
      writeStdout: () => undefined,
      writeStderr: () => undefined,
      detectors: [],
    });
    void capture.drained.then(() => {
      drained = true;
    });

    stdout.end("last stdout chunk");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(drained).toBe(false);

    stderr.end("last stderr chunk");
    await capture.drained;
    expect(drained).toBe(true);
  });
});

export interface BackendOutputDetector {
  push(chunk: Buffer, source: "stdout" | "stderr"): void;
  end?(source: "stdout" | "stderr"): void;
}

export interface CaptureBackendProcessOutputInput {
  readonly stdout: NodeJS.ReadableStream | null | undefined;
  readonly stderr: NodeJS.ReadableStream | null | undefined;
  readonly writeLog?: ((chunk: Buffer) => void) | undefined;
  readonly writeStdout: (chunk: Buffer) => void;
  readonly writeStderr: (chunk: Buffer) => void;
  readonly detectors: ReadonlyArray<BackendOutputDetector>;
}

export interface BackendProcessOutputCapture {
  // resolves after both child streams close so detectors consumed every buffered chunk before callers classify the exit
  readonly drained: Promise<void>;
}

export function captureBackendProcessOutput(
  input: CaptureBackendProcessOutputInput,
): BackendProcessOutputCapture {
  const attachStream = (
    stream: NodeJS.ReadableStream | null | undefined,
    writeFallback: (chunk: Buffer) => void,
    source: "stdout" | "stderr",
  ): Promise<void> => {
    if (!stream) return Promise.resolve();

    stream.on("data", (chunk: unknown) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      if (input.writeLog) {
        input.writeLog(buffer);
      } else {
        writeFallback(buffer);
      }
      for (const detector of input.detectors) {
        detector.push(buffer, source);
      }
    });

    return new Promise((resolve) => {
      let resolved = false;
      const resolveOnce = () => {
        if (resolved) return;
        resolved = true;
        for (const detector of input.detectors) {
          detector.end?.(source);
        }
        resolve();
      };
      stream.once("end", resolveOnce);
      stream.once("close", resolveOnce);
      // stdio closes after an error — consume it without treating it as proof all buffered data was delivered
      stream.once("error", () => undefined);
    });
  };

  const stdoutDrained = attachStream(input.stdout, input.writeStdout, "stdout");
  const stderrDrained = attachStream(input.stderr, input.writeStderr, "stderr");
  return {
    drained: Promise.all([stdoutDrained, stderrDrained]).then(() => undefined),
  };
}

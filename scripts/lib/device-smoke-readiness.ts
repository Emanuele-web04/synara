// Only the post-Home SpringBoard readiness error is transient. Never retry
// missing capabilities, broken RPCs, invalid trees or timeouts from the helper.
const STARTING =
  "accessibility tree unavailable: no frontmost application (SpringBoard may still be starting)";

export async function waitForDeviceAccessibility(
  read: (timeoutMs: number) => Promise<Record<string, unknown>>,
  options: {
    timeoutMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<Record<string, unknown>> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid readiness timeout");
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  let lastError: unknown;
  while (now() < deadline) {
    try {
      const result = await read(Math.min(45_000, deadline - now()));
      if (now() >= deadline) break;
      return result;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== STARTING) throw error;
      lastError = error;
    }
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(500, remaining));
  }
  throw new Error(`SpringBoard accessibility was not ready within ${timeoutMs}ms.`, {
    cause: lastError,
  });
}

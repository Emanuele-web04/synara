// Timestamped, credential-free release stage records. Durations are wall time,
// including child processes/external services, never inferred CPU time.
export function startBuildStage(stage: string, kind: "local" | "download" | "external" = "local") {
  const started = performance.now();
  console.log(
    `[build-timing] ${JSON.stringify({ stage, kind, event: "start", at: new Date().toISOString() })}`,
  );
  return (success: boolean) => {
    console.log(
      `[build-timing] ${JSON.stringify({ stage, kind, event: success ? "complete" : "failed", at: new Date().toISOString(), durationMs: Math.round(performance.now() - started) })}`,
    );
  };
}

export function timeBuildStage<T>(
  stage: string,
  work: () => T,
  kind: "local" | "download" | "external" = "local",
): T {
  const finish = startBuildStage(stage, kind);
  try {
    const result = work();
    finish(true);
    return result;
  } catch (error) {
    finish(false);
    throw error;
  }
}

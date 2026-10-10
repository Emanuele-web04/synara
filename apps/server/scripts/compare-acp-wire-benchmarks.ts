interface EngineResult {
  readonly engine: string;
  readonly commit: string;
  readonly setupMs: number;
  readonly shutdownMs: number;
  readonly memory: {
    readonly afterSetupRssBytes: number;
    readonly maxObservedRssBytes: number;
  };
  readonly scenarios: ReadonlyArray<{
    readonly name: string;
    readonly operations: number;
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly operationsPerSecond: number;
    readonly afterRssBytes: number;
    readonly afterHeapUsedBytes: number;
  }>;
}

export {};

function argument(name: string): string {
  const value = process.argv
    .find((item) => item.startsWith(`--${name}=`))
    ?.split("=")
    .slice(1)
    .join("=");
  if (!value) throw new Error(`Missing --${name}=...`);
  return value;
}

function percentChange(before: number, after: number): number {
  return before === 0 ? 0 : ((after - before) / before) * 100;
}

const effect = (await Bun.file(argument("effect")).json()) as EngineResult;
const official = (await Bun.file(argument("official")).json()) as EngineResult;
const effectScenarios = new Map(effect.scenarios.map((scenario) => [scenario.name, scenario]));
const comparisons = official.scenarios.map((current) => {
  const baseline = effectScenarios.get(current.name);
  if (!baseline || baseline.operations !== current.operations) {
    throw new Error(`Scenario mismatch for ${current.name}`);
  }
  return {
    name: current.name,
    operations: current.operations,
    effect: baseline,
    official: current,
    officialThroughputChangePercent: percentChange(
      baseline.operationsPerSecond,
      current.operationsPerSecond,
    ),
    officialP50LatencyChangePercent: percentChange(baseline.p50Ms, current.p50Ms),
    officialP95LatencyChangePercent: percentChange(baseline.p95Ms, current.p95Ms),
  };
});
const report = {
  createdAt: new Date().toISOString(),
  baseline: { engine: effect.engine, commit: effect.commit },
  current: { engine: official.engine, commit: official.commit },
  setup: {
    effectMs: effect.setupMs,
    officialMs: official.setupMs,
    officialChangePercent: percentChange(effect.setupMs, official.setupMs),
  },
  shutdown: {
    effectMs: effect.shutdownMs,
    officialMs: official.shutdownMs,
    officialChangePercent: percentChange(effect.shutdownMs, official.shutdownMs),
  },
  memory: {
    effectAfterSetupRssBytes: effect.memory.afterSetupRssBytes,
    officialAfterSetupRssBytes: official.memory.afterSetupRssBytes,
    effectMaxObservedRssBytes: effect.memory.maxObservedRssBytes,
    officialMaxObservedRssBytes: official.memory.maxObservedRssBytes,
    officialMaxRssChangePercent: percentChange(
      effect.memory.maxObservedRssBytes,
      official.memory.maxObservedRssBytes,
    ),
  },
  comparisons,
};
const output = argument("output");
await Bun.write(output, `${JSON.stringify(report, null, 2)}\n`);
console.table(
  comparisons.map((item) => ({
    scenario: item.name,
    "effect ops/s": item.effect.operationsPerSecond.toFixed(0),
    "official ops/s": item.official.operationsPerSecond.toFixed(0),
    "official throughput %": item.officialThroughputChangePercent.toFixed(1),
    "official p95 latency %": item.officialP95LatencyChangePercent.toFixed(1),
  })),
);

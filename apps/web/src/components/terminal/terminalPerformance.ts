// FILE: terminalPerformance.ts
// Purpose: Lightweight opt-in measurements for terminal output parse latency.
// Layer: Terminal runtime diagnostics
// Exports: observeTerminalWriteParsed
// Depends on: Browser performance APIs and localStorage

interface TerminalWriteSample {
  runtimeKey: string;
  bytes: number;
  latencyMs: number;
  queuedAt: number;
  parsedAt: number;
}

declare global {
  interface Window {
    __synaraTerminalPerf?: {
      samples: TerminalWriteSample[];
      reset: () => void;
    };
  }
}

const TERMINAL_PERF_STORAGE_KEY = "synara:terminal-perf";
const MAX_TERMINAL_PERF_SAMPLES = 200;

function terminalPerfEnabled(): boolean {
  try {
    return window.localStorage.getItem(TERMINAL_PERF_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function getTerminalPerfStore() {
  window.__synaraTerminalPerf ??= {
    samples: [],
    reset() {
      this.samples.length = 0;
    },
  };
  return window.__synaraTerminalPerf;
}

// Records a write only after xterm reports that its parser consumed the data.
export function observeTerminalWriteParsed(input: {
  runtimeKey: string;
  bytes: number;
  queuedAt: number;
}): void {
  if (!terminalPerfEnabled()) return;

  const parsedAt = performance.now();
  const sample: TerminalWriteSample = {
    runtimeKey: input.runtimeKey,
    bytes: input.bytes,
    queuedAt: input.queuedAt,
    parsedAt,
    latencyMs: parsedAt - input.queuedAt,
  };
  const store = getTerminalPerfStore();
  store.samples.push(sample);
  if (store.samples.length > MAX_TERMINAL_PERF_SAMPLES) {
    store.samples.splice(0, store.samples.length - MAX_TERMINAL_PERF_SAMPLES);
  }
}

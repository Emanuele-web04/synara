/**
 * The durable half of scroll gearing: per-app travel-per-pixel ratios that
 * outlive a window.
 *
 * The in-memory `ScrollGearingStore` is the hot path keyed by exact window —
 * the strongest signal, because an inner scroller's gearing belongs to the
 * surface, not the process. But windows churn while toolkits persist: the
 * same Chromium build gears every window it opens the same way, so a window
 * nobody has measured yet can inherit what its app already taught us instead
 * of starting at pixel-true 1 and paying a probe scroll to find out.
 *
 * Nothing here is a security boundary. A corrupt or hand-edited file degrades
 * to no entries — planning then assumes gearing 1, exactly as if the app had
 * never been measured — and never to a failure, because wrong gearing at
 * worst means an off-target scroll, not a refused one.
 */
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  MAX_SCROLL_GEARING,
  MIN_LEARNABLE_SCROLL_INJECTION,
  MIN_SCROLL_GEARING,
  SCROLL_GEARING_SMOOTHING,
} from "./scrollCalibration.ts";

/** How many apps keep a durable gearing before the stalest is forgotten. */
const MAX_APP_ENTRIES = 64;
/** File envelope version; unknown versions read as empty rather than fail. */
const FILE_VERSION = 1;

interface AppGearingEntry {
  readonly gearing: number;
  readonly samples: number;
  readonly updatedAt: number;
}

export class ScrollGearingFile {
  private readonly apps = new Map<string, AppGearingEntry>();
  private writes = Promise.resolve();
  private readonly now: () => number;

  constructor(
    private readonly filePath?: string,
    now: () => number = Date.now,
  ) {
    this.now = now;
    if (!filePath) return;
    try {
      const data: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      const envelope = data as { version?: unknown; apps?: unknown };
      if (envelope.version !== FILE_VERSION) return;
      if (
        typeof envelope.apps !== "object" ||
        envelope.apps === null ||
        Array.isArray(envelope.apps)
      )
        return;
      for (const [key, value] of Object.entries(envelope.apps)) {
        const entry = value as Partial<AppGearingEntry> | null;
        if (entry === null || typeof entry !== "object") continue;
        if (
          typeof entry.gearing !== "number" ||
          !Number.isFinite(entry.gearing) ||
          entry.gearing < MIN_SCROLL_GEARING ||
          entry.gearing > MAX_SCROLL_GEARING ||
          !Number.isSafeInteger(entry.samples) ||
          (entry.samples ?? 0) < 1 ||
          typeof entry.updatedAt !== "number" ||
          !Number.isFinite(entry.updatedAt)
        )
          continue;
        this.apps.set(key, {
          gearing: entry.gearing,
          samples: entry.samples!,
          updatedAt: entry.updatedAt,
        });
      }
      while (this.apps.size > MAX_APP_ENTRIES) this.evictStalest();
    } catch {
      // Missing or corrupt state means "never measured", not "broken".
    }
  }

  /** The app's learned ratio, or undefined when it has never been measured. */
  get(appKey: string | undefined): number | undefined {
    return appKey === undefined ? undefined : this.apps.get(appKey)?.gearing;
  }

  /**
   * Folds one accepted window observation into the app's durable entry under
   * the same admissibility rules the hot store applies, then schedules a
   * write. Entries are smoothed identically so an app whose toolkit changes
   * converges the same way a window does.
   */
  learn(appKey: string | undefined, injected: number, traveled: number): void {
    if (appKey === undefined) return;
    if (!Number.isFinite(injected) || !Number.isFinite(traveled)) return;
    if (traveled === 0 || Math.abs(injected) < MIN_LEARNABLE_SCROLL_INJECTION) return;
    if (Math.sign(traveled) !== Math.sign(injected)) return;
    const observed = traveled / injected;
    if (observed < MIN_SCROLL_GEARING || observed > MAX_SCROLL_GEARING) return;
    const previous = this.apps.get(appKey);
    const next =
      previous === undefined
        ? observed
        : previous.gearing * (1 - SCROLL_GEARING_SMOOTHING) + observed * SCROLL_GEARING_SMOOTHING;
    if (previous === undefined && this.apps.size >= MAX_APP_ENTRIES) this.evictStalest();
    this.apps.set(appKey, {
      gearing: Math.min(MAX_SCROLL_GEARING, Math.max(MIN_SCROLL_GEARING, next)),
      samples: (previous?.samples ?? 0) + 1,
      updatedAt: this.now(),
    });
    void this.persist();
  }

  /** The least-recently-updated entry goes first — staleness, not recency of insertion. */
  private evictStalest(): void {
    let stalest: { key: string; updatedAt: number } | undefined;
    for (const [key, entry] of this.apps) {
      if (stalest === undefined || entry.updatedAt < stalest.updatedAt)
        stalest = { key, updatedAt: entry.updatedAt };
    }
    if (stalest !== undefined) this.apps.delete(stalest.key);
  }

  /**
   * Atomic rename write behind a serialized chain, matching the control-state
   * persistence contract. Write failures are swallowed into the chain tail —
   * gearing is an optimization, and a disk error must not fail a scroll.
   */
  private persist(): Promise<void> {
    if (!this.filePath) return Promise.resolve();
    const filePath = this.filePath;
    const content = JSON.stringify({
      version: FILE_VERSION,
      apps: Object.fromEntries(this.apps),
    });
    const write = this.writes
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
        const temporaryPath = `${filePath}.tmp`;
        await writeFile(temporaryPath, content, { mode: 0o600 });
        await rename(temporaryPath, filePath);
      });
    this.writes = write;
    return write;
  }
}

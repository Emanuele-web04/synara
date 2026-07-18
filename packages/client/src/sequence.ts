export type CompanionSequenceDisposition = "snapshot" | "next" | "duplicate" | "gap";

export interface CompanionSequenceObservation {
  readonly disposition: CompanionSequenceDisposition;
  readonly previous: number | null;
  readonly received: number;
}

/** Tracks one subscription stream without retaining any domain data. */
export class CompanionSequenceTracker {
  private latest: number | null = null;

  observe(sequence: number, snapshot = false): CompanionSequenceObservation {
    const previous = this.latest;
    if (snapshot) {
      this.latest = sequence;
      return { disposition: "snapshot", previous, received: sequence };
    }
    if (previous === null) {
      return { disposition: "gap", previous, received: sequence };
    }
    if (sequence === previous + 1) {
      this.latest = sequence;
      return { disposition: "next", previous, received: sequence };
    }
    if (sequence <= previous) {
      return { disposition: "duplicate", previous, received: sequence };
    }
    return { disposition: "gap", previous, received: sequence };
  }

  reset(): void {
    this.latest = null;
  }

  get current(): number | null {
    return this.latest;
  }
}

// a full reconcile re-ships multi-MB snapshots per poll even for provably-current threads — an empty replay resolving with no detail event since is that proof, so verified threads let the reconcile back off while a periodic authoritative resync bounds the worst case

export interface ThreadDetailSyncEvidence {
  /**
   * Monotonic count of detail events applied to this thread (live or replayed). A
   * counter, not a timestamp: wall-clock time is neither monotonic nor fine-grained
   * enough to order an applied event against the replay that should have proven it.
   */
  readonly appliedEventSerial: number;
  readonly emptyReplayAtEventSerial: number | null;
}

/**
 * True when the most recent replay poll proved the client cursor at (or past) the server's
 * detail-event head for this thread and no event has been applied since that proof.
 */
export function isThreadDetailVerifiedInSync(evidence: ThreadDetailSyncEvidence): boolean {
  return (
    evidence.emptyReplayAtEventSerial !== null &&
    evidence.emptyReplayAtEventSerial === evidence.appliedEventSerial
  );
}

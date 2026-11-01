// Counts request snapshots within a Claude turn, including later output updates.
// Retains the last nonempty SDK turn to ignore its already-settled tail.
export class ClaudeRequestUsage {
  private requests = new Map<string, number>();
  private previousRequests = new Map<string, number>();
  // Cache reads of the requests counted since the last settle, per response.
  private cacheReads = new Map<string, number>();

  settleTurn(): void {
    this.cacheReads = new Map();
    if (this.requests.size === 0) return;
    this.previousRequests = this.requests;
    this.requests = new Map();
  }

  // Block UUIDs identify delivery, whereas message.id identifies the API response.
  add(messageId: string, tokens: number, cacheReadTokens = 0): number {
    if (this.previousRequests.has(messageId)) return 0;
    const previous = this.requests.get(messageId) ?? 0;
    if (tokens <= previous) return 0;
    this.requests.set(messageId, tokens);
    this.cacheReads.set(
      messageId,
      Math.min(tokens, Math.max(this.cacheReads.get(messageId) ?? 0, cacheReadTokens)),
    );
    return tokens - previous;
  }

  /** Cache reads of the requests counted since the last settle. */
  unsettledCacheReadTokens(): number {
    let total = 0;
    for (const tokens of this.cacheReads.values()) total += tokens;
    return total;
  }

  reset(): void {
    this.requests.clear();
    this.previousRequests.clear();
    this.cacheReads.clear();
  }
}

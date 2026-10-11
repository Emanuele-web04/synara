// Counts request snapshots within a Claude turn, including later output updates.
// Retains the last nonempty SDK turn to ignore its already-settled tail.
export class ClaudeRequestUsage {
  private requests = new Map<string, number>();
  private previousRequests = new Map<string, number>();

  settleTurn(): void {
    if (this.requests.size === 0) return;
    this.previousRequests = this.requests;
    this.requests = new Map();
  }

  // Block UUIDs identify delivery, whereas message.id identifies the API response.
  add(messageId: string, tokens: number): number {
    if (this.previousRequests.has(messageId)) return 0;
    const previous = this.requests.get(messageId) ?? 0;
    if (tokens <= previous) return 0;
    this.requests.set(messageId, tokens);
    return tokens - previous;
  }

  reset(): void {
    this.requests.clear();
    this.previousRequests.clear();
  }
}

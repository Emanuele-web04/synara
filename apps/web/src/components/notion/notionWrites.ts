import type { NotionApi, NotionObject, NotionWriteInput } from "@synara/contracts";
import { notionCanonical } from "@synara/shared/notion";

export type NotionWriteProposal = Omit<NotionWriteInput, "requestId" | "createdAt">;

/** A receipt belongs to one editor, not to the content of every editor in the app. */
export class NotionWriteSession {
  private receipt: NotionWriteInput | null = null;
  private inFlight: Promise<NotionObject | null> | null = null;

  constructor(
    private readonly identify: () => string = () => crypto.randomUUID(),
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  get awaitingConfirmation(): boolean {
    return this.receipt !== null;
  }

  write(
    api: Pick<NotionApi, "write">,
    proposal: NotionWriteProposal,
  ): Promise<NotionObject | null> {
    if (this.receipt) {
      const { requestId: _requestId, createdAt: _createdAt, ...previous } = this.receipt;
      if (notionCanonical(previous) !== notionCanonical(proposal)) {
        return Promise.reject(
          new Error("Review the unconfirmed Notion change before submitting a different edit."),
        );
      }
      if (this.inFlight) return this.inFlight;
    } else {
      // Keep an immutable copy even if the editor changes after an interrupted response.
      this.receipt = {
        ...structuredClone(proposal),
        requestId: this.identify(),
        createdAt: this.now(),
      };
    }

    const receipt = this.receipt;
    const operation = Promise.resolve().then(async () => {
      const result = await api.write(structuredClone(receipt));
      if (result.change.state !== "synced") {
        throw new Error(
          result.change.message ??
            "This change is retained for review in Settings → Integrations → Notion. Do not submit it again.",
        );
      }
      this.receipt = null;
      return result.data;
    });
    this.inFlight = operation.finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }
}

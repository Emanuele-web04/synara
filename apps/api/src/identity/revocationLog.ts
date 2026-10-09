import type { RevocationKind } from "@synara/contracts";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema";
import { revocationEvents } from "../db/schema";

type RevocationWriter = Pick<NodePgDatabase<typeof schema>, "insert">;
type RevocationEventInput = { hostId: string; kind: RevocationKind; subject?: string };

/**
 * Writes events on the caller's transaction. Retention deliberately does NOT
 * run here: callers hold FOR UPDATE row locks and advisory locks, and a
 * backlog sweep inside their transaction would serialize unrelated host
 * mutations behind it. The host authorization snapshot reads recent
 * revocations directly.
 */
export async function writeRevocationEvents(
  writer: RevocationWriter,
  values: readonly RevocationEventInput[],
): Promise<void> {
  if (values.length > 0) {
    await writer.insert(revocationEvents).values(
      values.map((event) => ({
        hostId: event.hostId,
        kind: event.kind,
        subject: event.subject ?? null,
      })),
    );
  }
}

// Preserve Synara ownership when an operator migrates WorkOS environments.
// Explicit ID pairs only: neither email nor provider-supplied external IDs authorize linking.
import { Schema } from "effect";

const IdMap = Schema.Record(Schema.String, Schema.String);
const IdentityMap = Schema.Struct({
  clientId: Schema.String,
  users: IdMap,
  organizations: IdMap,
});

export type WorkosIdentityMap = typeof IdentityMap.Type;

// Bind the migration to its destination and reject ambiguous ownership mappings.
export function parseWorkosIdentityMap(raw: string, clientId: string): WorkosIdentityMap {
  try {
    const parsed = Schema.decodeUnknownSync(IdentityMap)(JSON.parse(raw));
    if (parsed.clientId !== clientId) throw new Error();
    for (const [prefix, pairs] of [
      ["user_", parsed.users],
      ["org_", parsed.organizations],
    ] as const) {
      const destinations = new Set(Object.values(pairs));
      if (destinations.size !== Object.keys(pairs).length) throw new Error();
      for (const [previous, current] of Object.entries(pairs)) {
        if (
          !previous.startsWith(prefix) ||
          !current.startsWith(prefix) ||
          previous.length <= prefix.length ||
          current.length <= prefix.length ||
          Object.hasOwn(pairs, current)
        )
          throw new Error();
      }
    }
    return parsed;
  } catch {
    throw new Error(
      "WORKOS_IDENTITY_MAP must contain unambiguous user/org ID pairs bound to WORKOS_CLIENT_ID",
    );
  }
}

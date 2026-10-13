import { pluralize as sourcePluralize } from "@synara/shared/text";

import { t } from ".";

/** UI-only nouns. Protocols and agent context keep using the shared source utility. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return t(sourcePluralize(count, singular, plural));
}

// Closed-category SQL expressions for analytics reads during receiver-first rollout.
// Categorize before aggregation so legacy strings cannot escape or inflate distinct installs.
import { PRODUCT_ANALYTICS_COMMANDS } from "@synara/contracts/productAnalytics";
import { USAGE_ANALYTICS_VOCABULARY as vocabulary } from "@synara/shared/usageAnalytics";

// Only bundled vocabulary enters these expressions; values still use SQL literal escaping.
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const list = (values: readonly string[]) => values.map(literal).join(", ");
const category = (column: string, values: readonly string[]) =>
  `CASE WHEN ${column} IN (${list(values)}) THEN ${column} ELSE 'other' END`;

export const USAGE_PROVIDER_CATEGORY_SQL = category("up.provider", vocabulary.provider);
const modelCategory = `CASE ${Object.entries(vocabulary.models)
  .filter(([, models]) => models.length > 0)
  .map(
    ([provider, models]) =>
      `WHEN provider = ${literal(provider)} AND model IN (${list(models)}) THEN model`,
  )
  .join(" ")} ELSE 'other' END`;
export const USAGE_TURN_CATEGORIES_SQL = [
  `${category("provider", vocabulary.provider)} AS provider`,
  `${modelCategory} AS model`,
  `${category("effort", vocabulary.effort)} AS effort`,
  `${category("interaction_mode", vocabulary.interactionMode)} AS interaction_mode`,
  `${category("runtime_mode", vocabulary.runtimeMode)} AS runtime_mode`,
  `${category("origin", vocabulary.origin)} AS origin`,
].join(", ");
export const PRODUCT_COMMAND_CATEGORY_SQL =
  `CASE WHEN command IN (${list(PRODUCT_ANALYTICS_COMMANDS)}) THEN command ` +
  "WHEN command LIKE 'shortcut:%' THEN 'shortcut:custom' ELSE 'slash:custom' END";

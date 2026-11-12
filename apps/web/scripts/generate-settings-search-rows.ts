// FILE: generate-settings-search-rows.ts
// Purpose: Regenerate src/settingsSearchRows.generated.ts from the settings rows.
// Usage: bun run --cwd apps/web settings-search:generate

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  readSettingsSearchRows,
  renderSettingsSearchRowsModule,
  SETTINGS_SEARCH_ROWS_MODULE,
} from "./settingsSearchRows";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rows = readSettingsSearchRows(webRoot);
writeFileSync(
  path.join(webRoot, SETTINGS_SEARCH_ROWS_MODULE),
  renderSettingsSearchRowsModule(rows),
);
console.log(`Wrote ${rows.length} settings search rows to ${SETTINGS_SEARCH_ROWS_MODULE}.`);

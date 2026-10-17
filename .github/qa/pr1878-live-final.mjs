import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
const dir = dirname(fileURLToPath(import.meta.url));
const original = await readFile(join(dir, 'pr1878-live.mjs'), 'utf8');
assert.equal(createHash('sha256').update(original).digest('hex'), 'c0d172d6710de145382348e175de0bd422c8ab331f540c59e7e59f8b396b50f5');
let source = original;
function replace(before, after) {
  assert.equal(source.split(before).length, 2, `Expected one driver anchor: ${before.slice(0, 80)}`);
  source = source.replace(before, after);
}
replace(
  "  // Interact with the real existing dismiss button. Do not forge localStorage or app state.\n  const skip",
  "  const setup = page.getByRole('button', { name: 'Skip setup', exact: true });\n  try { await setup.waitFor({ state: 'visible', timeout: 3500 }); await setup.click(); await expect(setup).toBeHidden(); }\n  catch (e) { if (await setup.isVisible()) throw e; }\n  // Use real first-run controls, not synthetic localStorage or app state.\n  const skip",
);
replace(
  "'--no-browser', '--auto-bootstrap-project-from-cwd'",
  "'--no-browser'",
);
replace(
  'return value.providerRuntimeIdleStopMinutes === expected;',
  'return (value.settings?.providerRuntimeIdleStopMinutes ?? null) === expected;',
);
replace(
  "  await check('SQLite integrity and bootstrap project persistence', async () => {",
  `  await check('creates a real project through the application dialog', async () => {
    await page.goto(baseUrl); await dismissTour();
    await page.getByRole('button', { name: 'Add project', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Create project', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Project folder path', exact: true }).fill(project);
    await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('composer-editor')).toBeVisible();
    await shot('02b-project-created');
  });
  await check('SQLite integrity and UI-created project persistence', async () => {`,
);
replace(
  "    const db = new DatabaseSync(join(home, 'userdata/state.sqlite'), { readOnly: true });",
  "    // The application's real SQLite lifecycle remains authoritative.\n    await stop();\n    const db = new DatabaseSync(join(home, 'userdata/state.sqlite'), { readOnly: true });",
);
replace('    } finally { db.close(); }', '    } finally { db.close(); await start(); }');
replace(
  "  await check('unsent composer draft survives actual page reload without provider execution', async () => {\n    await page.goto(baseUrl);",
  "  await check('unsent composer draft survives actual page reload without provider execution', async () => {\n    await page.setViewportSize({ width: 1440, height: 1000 });\n    await page.goto(baseUrl);",
);
await writeFile(join(dir, 'pr1878-live-final-executed.mjs'), source);
console.log('QA_DRIVER_PROVENANCE', JSON.stringify({
  originalSha256: createHash('sha256').update(original).digest('hex'),
  executedSha256: createHash('sha256').update(source).digest('hex'),
  changes: ['actual first-run Skip setup', 'read documented settings envelope', 'create synthetic project through real UI instead of the unconsumed bootstrap option', 'inspect SQLite only while owned server is stopped', 'restore viewport before draft case'],
}));
await import(pathToFileURL(join(dir, 'pr1878-live-final-executed.mjs')));

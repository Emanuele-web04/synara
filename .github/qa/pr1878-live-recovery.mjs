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
  assert.equal(source.split(before).length, 2, `Expected one harness anchor: ${before.slice(0, 80)}`);
  source = source.replace(before, after);
}
replace("  // Interact with the real existing dismiss button. Do not forge localStorage or app state.\n  const skip", "  // The first-run setup owns a distinct real dialog before the feature tour.\n  const setup = page.getByRole('button', { name: 'Skip setup', exact: true });\n  try { await setup.waitFor({ state: 'visible', timeout: 3500 }); await setup.click(); await expect(setup).toBeHidden(); }\n  catch (e) { if (await setup.isVisible()) throw e; }\n  // Interact with actual controls only; do not forge localStorage or app state.\n  const skip");
replace("    const db = new DatabaseSync(join(home, 'userdata/state.sqlite'), { readOnly: true });", "    // The running application owns its SQLite lifecycle. Inspect only after\n    // stopping this disposable server, rather than weakening database locks.\n    await stop();\n    const db = new DatabaseSync(join(home, 'userdata/state.sqlite'), { readOnly: true });");
replace("    } finally { db.close(); }", "    } finally { db.close(); await start(); }");
replace("  await check('unsent composer draft survives actual page reload without provider execution', async () => {\n    await page.goto(baseUrl);", "  await check('unsent composer draft survives actual page reload without provider execution', async () => {\n    await page.setViewportSize({ width: 1440, height: 1000 });\n    await page.goto(baseUrl);");
await writeFile(join(dir, 'pr1878-live-executed.mjs'), source);
console.log('QA_DRIVER_PROVENANCE', JSON.stringify({ originalSha256: createHash('sha256').update(original).digest('hex'), executedSha256: createHash('sha256').update(source).digest('hex'), changes: ['actual Skip setup button before tour', 'read-only database inspection between owned server stops', 'restore desktop viewport before independent draft case'] }));
await import(pathToFileURL(join(dir, 'pr1878-live-executed.mjs')));

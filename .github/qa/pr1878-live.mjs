import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(process.env.QA_REPO ?? process.cwd());
const out = resolve(process.env.QA_OUT);
await mkdir(out, { recursive: true });
const require = createRequire(join(root, 'apps/web/package.json'));
const { chromium, expect } = require('playwright/test');
const temp = await mkdtemp(join(tmpdir(), 'synara-pr1878-live-'));
const home = join(temp, 'home');
const project = join(temp, 'qa-project');
await mkdir(home); await mkdir(project);
execFileSync('git', ['init', '--initial-branch=main', project]);
await writeFile(join(project, 'README.md'), '# Runtime verification\n\nSynthetic disposable workspace.\n\n```mermaid\ngraph LR\n  A[Read] --> B[Verify]\n```\n');
await writeFile(join(project, 'sample.ts'), 'export const message = "persistent draft fixture";\n');
execFileSync('git', ['-C', project, 'add', 'README.md', 'sample.ts']);
execFileSync('git', ['-C', project, '-c', 'user.name=Synara QA', '-c', 'user.email=qa@example.invalid', 'commit', '-m', 'Disposable fixture']);
const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const results = { source, environment: { platform: process.platform, node: process.version }, cases: [], health: [], serverExits: [], pageErrors: [], ui: [] };
const logs = [];
let server, browser, context, page, baseUrl;
async function poll(name, fn, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const result = await fn(); if (result) return result; } catch (e) { last = e; }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`${name} not satisfied: ${last?.message ?? 'condition remained false'}`);
}
async function port() {
  const socket = createServer();
  await new Promise((res, rej) => { socket.once('error', rej); socket.listen(0, '127.0.0.1', res); });
  const p = socket.address().port;
  await new Promise((res, rej) => socket.close(e => e ? rej(e) : res()));
  return p;
}
const listenPort = await port();
baseUrl = `http://127.0.0.1:${listenPort}`;
async function start() {
  const env = { ...process.env, HOME: home, SYNARA_HOME: home };
  // Only the disposable process loses inherited instance settings. No global policy changes.
  for (const key of ['SYNARA_AUTH_TOKEN', 'SYNARA_PUBLIC_URL', 'VITE_DEV_SERVER_URL', 'VITE_WS_URL', 'SYNARA_DESKTOP_WS_URL', 'SYNARA_BROWSER_HOST_PIPE_PATH', 'SYNARA_BROWSER_HOST_CAPABILITY']) delete env[key];
  const log = createWriteStream(join(out, `server-${logs.length + 1}.log`)); logs.push(log);
  server = spawn(process.execPath, [join(root, 'apps/server/dist/index.mjs'), '--mode', 'web', '--host', '127.0.0.1', '--port', String(listenPort), '--home-dir', home, '--no-browser', '--auto-bootstrap-project-from-cwd'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.pipe(log, { end: false }); server.stderr.pipe(log, { end: false });
  server.on('exit', (code, signal) => results.serverExits.push({ code, signal }));
  await poll('actual server startup readiness', async () => {
    if (server.exitCode !== null) throw new Error(`Server exited ${server.exitCode}`);
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return false;
    const value = await response.json();
    if (value.status !== 'ok' || !value.startupReady) return false;
    results.health.push(value); return true;
  }, 60_000);
}
async function stop() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const owned = server;
  owned.kill('SIGTERM');
  try { await poll('owned server termination', () => owned.exitCode !== null || owned.signalCode !== null, 15_000); }
  catch (e) { owned.kill('SIGKILL'); await poll('owned server forced termination', () => owned.exitCode !== null || owned.signalCode !== null, 5000); throw e; }
}
async function shot(name) {
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
  results.ui.push({ name, url: page.url(), viewport: page.viewportSize() });
}
async function check(name, fn) {
  const start = Date.now();
  try { await fn(); results.cases.push({ name, status: 'pass', milliseconds: Date.now() - start }); }
  catch (e) {
    results.cases.push({ name, status: 'fail', error: String(e?.stack ?? e), milliseconds: Date.now() - start });
    if (page) {
      await shot(`failure-${results.cases.length}`).catch(() => {});
      await writeFile(join(out, `failure-${results.cases.length}.txt`), await page.locator('body').innerText().catch(() => 'Page unavailable'));
    }
  }
}
async function dismissTour() {
  // Interact with the real existing dismiss button. Do not forge localStorage or app state.
  const skip = page.getByRole('button', { name: 'Skip tour', exact: true });
  try { await skip.waitFor({ state: 'visible', timeout: 3500 }); await skip.click(); await expect(skip).toBeHidden(); }
  catch (e) { if (await skip.isVisible()) throw e; }
}
async function route(section) {
  await page.goto(`${baseUrl}/settings?section=${section}`);
  await dismissTour();
}
async function savedIdle(expected) {
  await poll('durable server setting', async () => {
    const value = JSON.parse(await readFile(join(home, 'userdata/settings.json'), 'utf8'));
    return value.providerRuntimeIdleStopMinutes === expected;
  });
}
try {
  await check('actual server boots with isolated SQLite and reaches readiness', start);
  if (!results.cases[0] || results.cases[0].status !== 'pass') throw new Error('Server startup failed; dependent UI checks cannot run');
  browser = await chromium.launch({ headless: true });
  results.environment.chromium = browser.version();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', recordVideo: { dir: join(out, 'video'), size: { width: 1440, height: 1000 } } });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', e => results.pageErrors.push(String(e)));
  await check('production frontend hydrates against real server', async () => {
    await page.goto(baseUrl);
    await expect(page.getByRole('button', { name: 'Settings', exact: true }).first()).toBeVisible();
    await dismissTour();
    await shot('01-live-home');
  });
  const idle = () => page.getByRole('spinbutton', { name: 'Stop idle agent processes after minutes', exact: true });
  await check('idle-stop setting saves through real transport to disk', async () => {
    await route('general');
    await expect(idle()).toBeVisible();
    await idle().fill('5'); await idle().press('Tab');
    await savedIdle(5);
    await shot('02-idle-stop-saved');
  });
  await check('idle-stop setting survives a browser reload', async () => {
    await route('general');
    await expect(idle()).toHaveValue('5');
  });
  await check('SQLite integrity and bootstrap project persistence', async () => {
    const db = new DatabaseSync(join(home, 'userdata/state.sqlite'), { readOnly: true });
    try {
      const integrity = db.prepare('PRAGMA integrity_check').all();
      assert.deepEqual(integrity.map(v => Object.values(v)[0]), ['ok']);
      const migrations = db.prepare('SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id').all();
      assert(migrations.length > 100);
      const projects = db.prepare('SELECT workspace_root FROM projection_projects').all();
      assert(projects.some(p => p.workspace_root === project));
      results.persistence = { integrity: 'ok', migrations, syntheticProjectPresent: true };
    } finally { db.close(); }
  });
  await check('saved setting and actual UI survive full server restart', async () => {
    await stop(); await start();
    await route('general'); await expect(idle()).toHaveValue('5');
    await savedIdle(5); await shot('03-after-server-restart');
  });
  await check('idle-stop disable and reset persist without discarding other settings', async () => {
    await route('general'); await idle().fill('0'); await idle().press('Tab'); await savedIdle(0);
    await idle().fill(''); await idle().press('Tab'); await savedIdle(null);
    await page.reload(); await expect(idle()).toHaveValue('');
  });
  await check('light and dark appearance use real Settings controls', async () => {
    await route('appearance');
    const group = page.getByRole('radiogroup', { name: 'Theme preference', exact: true });
    await group.getByRole('radio', { name: 'Light', exact: true }).click();
    await expect(group.getByRole('radio', { name: 'Light', exact: true })).toHaveAttribute('aria-checked', 'true');
    await shot('04-appearance-light');
    await group.getByRole('radio', { name: 'Dark', exact: true }).click();
    await expect(group.getByRole('radio', { name: 'Dark', exact: true })).toHaveAttribute('aria-checked', 'true');
    await shot('05-appearance-dark');
    await page.reload();
    await expect(group.getByRole('radio', { name: 'Dark', exact: true })).toHaveAttribute('aria-checked', 'true');
  });
  await check('narrow Settings layout has no horizontal document overflow', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await route('general'); await expect(idle()).toBeVisible();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await shot('06-narrow-settings');
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await check('unsent composer draft survives actual page reload without provider execution', async () => {
    await page.goto(baseUrl); await dismissTour();
    const newThread = page.getByRole('button', { name: 'New thread', exact: true }).first();
    await expect(newThread).toBeVisible(); await newThread.click();
    const editor = page.getByTestId('composer-editor');
    await expect(editor).toBeVisible();
    await editor.fill('QA unsent draft — do not send');
    await expect(editor).toContainText('QA unsent draft — do not send');
    await shot('07-unsent-draft');
    await page.reload();
    await expect(editor).toContainText('QA unsent draft — do not send');
    await shot('08-restored-draft');
  });
  await check('no unhandled renderer exceptions across real journeys', async () => assert.deepEqual(results.pageErrors, []));
} catch (e) { results.fatal = String(e?.stack ?? e); }
finally {
  if (context) await context.tracing.stop({ path: join(out, 'live-app-trace.zip') }).catch(() => {});
  if (context) await context.close();
  if (browser) await browser.close();
  try { await stop(); } catch (e) { results.cleanupError = String(e); }
  for (const log of logs) log.end();
  // Retain only synthetic observations, not secret stores or auth-bearing local state.
  await writeFile(join(out, 'live-app-results.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(results, null, 2));
}
if (results.fatal || results.cleanupError || results.cases.some(v => v.status !== 'pass')) process.exitCode = 1;

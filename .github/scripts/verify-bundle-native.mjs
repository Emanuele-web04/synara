import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [sourceArgument, platform, reportArgument] = process.argv.slice(2);
const source = resolve(sourceArgument);
const report = resolve(reportArgument);
const stages = readdirSync(tmpdir()).filter((name) => name.startsWith(`synara-desktop-${platform}-stage-`)).map((name) => join(tmpdir(), name)).filter((path) => existsSync(join(path, "app/dist"))).sort((a, b) => lstatSync(b).mtimeMs - lstatSync(a).mtimeMs);
assert(stages[0]);
const dist = join(stages[0], "app/dist");
const packaged = readdirSync(dist).filter((name) => lstatSync(join(dist, name)).isDirectory() && (name.startsWith("mac") || name.endsWith("-unpacked")));
assert.equal(packaged.length, 1);
let root = join(dist, packaged[0]);
if (platform === "mac") {
  const apps = readdirSync(root).filter((name) => name.endsWith(".app"));
  assert.equal(apps.length, 1);
  root = join(root, apps[0], "Contents");
}
const resources = join(root, platform === "mac" ? "Resources" : "resources");
const electron = join(root, platform === "mac" ? "MacOS/Synara" : platform === "win" ? "Synara.exe" : "synara");
const isolated = mkdtempSync(join(tmpdir(), "synara-bundle-native-"));
const env = { ...process.env, HOME: isolated, USERPROFILE: isolated, APPDATA: isolated, LOCALAPPDATA: isolated, XDG_CONFIG_HOME: isolated, XDG_DATA_HOME: isolated, XDG_CACHE_HOME: isolated, SYNARA_HOME: join(isolated, "synara"), SYNARA_DISABLE_AUTO_UPDATE: "1" };
delete env.NODE_OPTIONS;
delete env.NODE_PATH;
delete env.SYNARA_AUTH_TOKEN;
const sdkPackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
const cli = join(resources, "app.asar.unpacked/node_modules", sdkPackage, platform === "win" ? "claude.exe" : "claude");
assert(existsSync(cli), `Missing target Claude binary: ${cli}`);
const version = execFileSync(cli, ["--version"], { env, cwd: isolated, encoding: "utf8", timeout: 30000 }).trim();
assert(version.length > 0);
console.log(`Bundled Claude executable starts: ${version}`);
const ptyScript = join(isolated, "pty-smoke.mjs");
writeFileSync(ptyScript, `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(${JSON.stringify(join(resources, "app.asar/package.json"))});
const pty = require('node-pty');
const { waitForSuccessfulPtyExit } = await import(${JSON.stringify(pathToFileURL(join(source, "scripts/lib/node-pty-smoke.ts")).href)});
const win = process.platform === 'win32';
const expectedOutput = 'synara-packaged-pty-smoke';
const terminal = pty.spawn(win ? process.env.ComSpec || 'cmd.exe' : '/bin/sh', win ? ['/d', '/q'] : ['-lc', "printf '" + expectedOutput + "'"], { cwd: ${JSON.stringify(isolated)}, env: process.env, cols: 80, rows: 24, name: 'xterm-color' });
if (win) { assert(terminal.pid > 0); terminal.kill(); }
else await waitForSuccessfulPtyExit({ terminal, expectedOutput, timeoutMs: 5000 });
console.log('Packaged native PTY loaded and spawned successfully');
process.exit(0);
`);
const ptyOutput = execFileSync(electron, [ptyScript], { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, cwd: isolated, encoding: "utf8", timeout: 30000 }).trim();
console.log(ptyOutput);
mkdirSync(report, { recursive: true });
writeFileSync(join(report, "native-smoke.json"), JSON.stringify({ claudeVersion: version, ptyOutput, source }, null, 2));

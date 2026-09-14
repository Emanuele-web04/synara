// Manual, isolated CI experiments. Never runs against a developer's workspace.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.RUNNER_TEMP) {
  throw new Error('Run this harness only on an ephemeral GitHub Actions runner.');
}
const root = process.cwd();
const out = resolve('benchmark-results');
mkdirSync(out, { recursive: true });
const records = [];
const source = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const bunVersion = spawnSync('bun', ['--version'], { encoding: 'utf8' }).stdout.trim();
function execute(command, args, cwd, env, name, timeout = 600_000) {
  const start = performance.now();
  const result = spawnSync(command, args, {
    cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  const seconds = (performance.now() - start) / 1000;
  const log = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  writeFileSync(join(out, `${name}.log`), log);
  const record = {
    name, command: [command, ...args], seconds, status: result.status,
    signal: result.signal, error: result.error?.message ?? null,
    source, platform: process.platform, arch: process.arch,
    node: process.version, bun: bunVersion,
  };
  records.push(record);
  writeFileSync(join(out, 'results.json'), JSON.stringify(records, null, 2));
  console.log(`CI_BENCHMARK ${JSON.stringify(record)}`);
  console.log(log.slice(-3000));
  return record;
}
const hash = (dir) => createHash('sha256').update(readFileSync(join(dir, 'bun.lock'))).digest('hex');
const profile = process.env.BENCH_PROFILE;
if (profile === 'install') {
  const mac = process.platform === 'darwin';
  const variants = mac
    ? [ ['full', []], ['runtime', ['--filter', '!@synara/marketing']], ['device', ['--filter', '@synara/scripts']] ]
    : [ ['full', []], ['runtime', ['--filter', '!@synara/marketing']], ...(process.platform === 'linux' ? [['static', ['--filter', './']]] : []) ];
  for (let sample = 0; sample < 3; sample++) {
    const ordered = sample % 2 === 0 ? variants : [...variants].reverse();
    for (const [variant, filter] of ordered) {
      const scratch = mkdtempSync(join(process.env.RUNNER_TEMP, 'synara-benchmark-'));
      const cwd = join(scratch, 'repo');
      const worktree = spawnSync('git', ['worktree', 'add', '--detach', cwd, source], { encoding: 'utf8' });
      if (worktree.status !== 0) throw new Error(worktree.stderr);
      try {
        const env = { ELECTRON_SKIP_BINARY_DOWNLOAD: '1', BUN_INSTALL_CACHE_DIR: join(scratch, 'bun-cache') };
        const before = hash(cwd);
        const result = execute('bun', ['install', '--frozen-lockfile', ...(mac ? ['--ignore-scripts'] : []), ...filter], cwd, env, `install-${variant}-${sample}`);
        if (before !== hash(cwd)) throw new Error('Frozen install changed bun.lock');
        if (sample === 0 && result.status === 0) {
          const checks = variant === 'static'
            ? [['bun', ['run', 'brand:check']], ['bun', ['run', 'windows-runtime:check']], ['bun', ['run', 'lint']]]
            : mac && variant === 'device'
              ? [['bun', ['run', 'test:device:probe']]]
              : [['bun', ['run', '--cwd', 'packages/shared', 'test', 'src/windowsProcess.test.ts', 'src/platformProcess.test.ts', 'src/processRuntime.test.ts', 'src/migrationRecovery.test.ts']], ['bun', ['run', '--cwd', 'apps/desktop', 'test', 'src/desktopMigrationRecovery.test.ts']]];
          for (const [index, [command, args]] of checks.entries()) execute(command, args, cwd, env, `verify-${variant}-${index}`, 300_000);
        }
      } finally {
        const cleanup = spawnSync('git', ['worktree', 'remove', '--force', cwd], { encoding: 'utf8' });
        if (cleanup.status !== 0) console.warn(cleanup.stderr);
        rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      }
    }
  }
} else if (profile === 'server' || profile === 'browser') {
  const args = profile === 'server'
    ? ['run', '--cwd', 'apps/server', 'test']
    : ['run', '--cwd', 'apps/web', 'test:browser:ci', '--', '--project=chat-workflows'];
  for (let sample = 0; sample < 2; sample++) {
    execute('bun', [...args, '--reporter=default', '--reporter=json', `--outputFile=${join(out, `${profile}-${sample}.json`)}`], root, {}, `${profile}-${sample}`, 900_000);
  }
} else {
  throw new Error(`Unknown benchmark profile: ${profile}`);
}
if (records.some((record) => record.status !== 0)) process.exitCode = 1;

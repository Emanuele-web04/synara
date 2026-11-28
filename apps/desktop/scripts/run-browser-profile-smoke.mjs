import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import electron from "electron";

const home = await mkdtemp(join(tmpdir(), "synara-browser-profile-"));
const fixture = fork(new URL("./browser-integration-fixture.mjs", import.meta.url), {
  silent: true,
  env: { ...process.env, SYNARA_FIXTURE_PORT: "0" },
});
try {
  const output = createInterface({ input: fixture.stdout });
  const { value: origin } = await output[Symbol.asyncIterator]().next();
  assert.match(origin ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
  const worker = fileURLToPath(new URL("../.smoke/browser-profile.mjs", import.meta.url));
  for (const phase of ["sign-in", "restart", "after-sign-out"]) {
    execFileSync(electron, [`--user-data-dir=${home}`, worker, phase, origin, home], {
      stdio: "inherit",
      timeout: 45_000,
      killSignal: "SIGKILL",
    });
  }
} finally {
  fixture.kill();
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

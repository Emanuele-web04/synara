// Starts an isolated Synara (server + web dev server) for SynBot scenarios.
//
//   node start-app.ts <webPort> [--stable]
//
// Everything lives under `.scenario/`, recreated on every start: a scratch HOME (bot folders go to
// ~/Documents/Synara/Groups), SYNARA_HOME, a disposable git repo that becomes the first project, and
// the fake agent's script/log folder. Every provider but Grok is disabled and Grok's binary is the
// scripted fake agent, so no real model can run.
//
// `--stable` starts the Stable desktop flavor instead, in its own folder (`STABLE` in paths.ts),
// with a local fake Account API (fake-account.ts) whose address goes to `<state>/account.json`.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import * as nodeFs from "node:fs";
import * as nodeNet from "node:net";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { startFakeAccount } from "./fake-account.ts";
import { RUN_DIR, STABLE, runPaths } from "./paths.ts";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.resolve(HERE, "../..");
const FAKE_GROK = nodePath.join(HERE, "fake-agent/bin/grok");
const LOOPBACK = "127.0.0.1";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Scenario",
  GIT_AUTHOR_EMAIL: "scenario@example.invalid",
  GIT_COMMITTER_NAME: "Scenario",
  GIT_COMMITTER_EMAIL: "scenario@example.invalid",
};

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = nodeNet.createServer();
    server.once("error", reject);
    server.listen(0, LOOPBACK, () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });

const write = (file: string, contents: string) => {
  nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
  nodeFs.writeFileSync(file, contents);
};

const STABLE_MODE = process.argv.includes("--stable");
const { DEMO_REPO, HOME, STATE_DIR, SYNARA_HOME } = STABLE_MODE ? STABLE : runPaths(RUN_DIR);

function prepare() {
  nodeFs.rmSync(STABLE_MODE ? STABLE.RUN_DIR : RUN_DIR, { recursive: true, force: true });
  for (const dir of [HOME, SYNARA_HOME, STATE_DIR, DEMO_REPO]) {
    nodeFs.mkdirSync(dir, { recursive: true });
  }
  write(
    nodePath.join(DEMO_REPO, "package.json"),
    `${JSON.stringify({ name: "demo-app", private: true }, null, 2)}\n`,
  );
  write(nodePath.join(DEMO_REPO, "README.md"), "# demo-app\n\nA disposable scenario repo.\n");
  write(nodePath.join(DEMO_REPO, "src/index.ts"), "export const answer = 42;\n");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: DEMO_REPO, env: { ...process.env, ...GIT_ENV, HOME } });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "Initial commit");

  const disabled = { enabled: false };
  write(
    nodePath.join(SYNARA_HOME, "dev/settings.json"),
    `${JSON.stringify(
      {
        onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
        enableProviderUpdateChecks: false,
        providers: {
          grok: { enabled: true, binaryPath: FAKE_GROK },
          codex: disabled,
          claudeAgent: disabled,
          cursor: disabled,
          devin: disabled,
          antigravity: disabled,
          droid: disabled,
          opencode: disabled,
          pi: disabled,
          omp: disabled,
        },
      },
      null,
      2,
    )}\n`,
  );
}

async function waitFor(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.status < 500) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`${url} did not answer within ${timeoutMs} ms`);
}

async function main() {
  const webPort = Number(process.argv[2]);
  if (!Number.isInteger(webPort) || webPort <= 0) throw new Error("usage: start-app.ts <webPort>");
  prepare();
  const serverPort = await freePort();
  const children: ChildProcess[] = [];
  const stop = () => {
    for (const child of children) child.kill("SIGTERM");
  };
  process.on("SIGTERM", () => {
    stop();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    stop();
    process.exit(0);
  });

  const baseEnv = { ...process.env };
  delete baseEnv.SYNARA_AUTH_TOKEN;
  delete baseEnv.SYNARA_DESKTOP_BUNDLE_ID;
  delete baseEnv.SYNARA_ACCOUNT_URL;
  let stableEnv: Record<string, string> = {};
  if (STABLE_MODE) {
    const fakeAccount = await startFakeAccount(LOOPBACK, await freePort());
    write(nodePath.join(STATE_DIR, "account.json"), JSON.stringify({ url: fakeAccount.url }));
    stableEnv = {
      SYNARA_DESKTOP_BUNDLE_ID: "com.emanueledipietro.synara",
      SYNARA_ACCOUNT_URL: fakeAccount.url,
    };
  }

  const server = spawn("bun", [nodePath.join(REPO, "apps/server/src/index.ts")], {
    cwd: DEMO_REPO,
    stdio: "inherit",
    env: {
      ...baseEnv,
      ...GIT_ENV,
      HOME,
      SYNARA_HOME,
      SYNARA_PORT: String(serverPort),
      SYNARA_MODE: "web",
      SYNARA_NO_BROWSER: "1",
      VITE_DEV_SERVER_URL: `http://${LOOPBACK}:${webPort}`,
      SYNBOT_FAKE_STATE_DIR: STATE_DIR,
      SYNBOT_NODE: process.execPath,
      ...stableEnv,
    },
  });
  children.push(server);
  server.on("exit", (code) => {
    console.error(`[start-app] server exited with ${code}`);
    stop();
    process.exit(1);
  });
  await waitFor(`http://${LOOPBACK}:${serverPort}/health`, 120_000);
  console.error(`[start-app] server ready on ${serverPort}`);

  const web = spawn("bun", ["run", "dev", "--host", LOOPBACK], {
    cwd: nodePath.join(REPO, "apps/web"),
    stdio: "inherit",
    env: {
      ...baseEnv,
      PORT: String(webPort),
      VITE_WS_URL: `ws://${LOOPBACK}:${serverPort}`,
    },
  });
  children.push(web);
  web.on("exit", (code) => {
    console.error(`[start-app] web exited with ${code}`);
    stop();
    process.exit(1);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

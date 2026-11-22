// Starts an isolated Synara (server + web dev server) for SynBot scenarios.
//
//   node start-app.ts <webPort> [--stable [--alto-ui] | --cli | --beta | --old-host]
//
// Everything lives under `.scenario/`, recreated on every start: a scratch HOME (bot folders go to
// ~/Documents/Synara/Groups), SYNARA_HOME, a disposable git repo that becomes the first project, and
// the fake agent's script/log folder. Every provider but Grok is disabled and Grok's binary is the
// scripted fake agent, so no real model can run.
//
// The default run names the Dev desktop flavor, where SynBot is free; a server with no flavor would
// require Synara Alto. `--stable` starts the Stable desktop flavor instead, and `--cli` a server with
// no desktop flavor at all (as `npx synara` runs it). Each has its own folder (`STABLE` and `CLI` in
// paths.ts) and a local fake Account API (fake-account.ts) whose address goes to
// `<state>/account.json`. With `--stable --alto-ui`, the web app shows the (sandbox) billing UI and
// the Account API sits behind fake-account-switch.ts, which adds checkout links and a network switch.
//
// `--beta` starts the Beta desktop flavor (`BETA`), with no account at all.
//
// `--old-host` (`OLD_HOST`, Dev flavor) puts old-host-proxy.ts between the web app and the server: the
// server never learns a `bots.*` method name, so it answers them as a host built before SynBot does.
//
// Every flavor's server finds `gh` in fake-gh/bin first: it answers only what a scenario wrote to
// `<state>/gh.json` (and acts signed out otherwise), so no scenario ever reaches GitHub.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import * as nodeFs from "node:fs";
import * as nodeNet from "node:net";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { startFakeAccount } from "./fake-account.ts";
import { startAccountSwitch } from "./fake-account-switch.ts";
import { BETA, CLI, OLD_HOST, RUN_DIR, STABLE, runPaths } from "./paths.ts";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.resolve(HERE, "../..");
const FAKE_GROK = nodePath.join(HERE, "fake-agent/bin/grok");
const FAKE_GH_BIN = nodePath.join(HERE, "fake-gh/bin");
const OLD_HOST_PROXY = nodePath.join(HERE, "old-host-proxy.ts");
const BETA_BUNDLE_ID = "com.emanueledipietro.synara.beta";
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
const CLI_MODE = !STABLE_MODE && process.argv.includes("--cli");
const ALTO_UI = STABLE_MODE && process.argv.includes("--alto-ui");
const BETA_MODE = !STABLE_MODE && !CLI_MODE && process.argv.includes("--beta");
const OLD_HOST_MODE =
  !STABLE_MODE && !CLI_MODE && !BETA_MODE && process.argv.includes("--old-host");
const PATHS = STABLE_MODE
  ? STABLE
  : CLI_MODE
    ? CLI
    : BETA_MODE
      ? BETA
      : OLD_HOST_MODE
        ? OLD_HOST
        : runPaths(RUN_DIR);
const { DEMO_REPO, HOME, STATE_DIR, SYNARA_HOME } = PATHS;
/** The desktop flavor each run names; the CLI run names none. */
const BUNDLE_ID = STABLE_MODE
  ? "com.emanueledipietro.synara"
  : CLI_MODE
    ? null
    : BETA_MODE
      ? BETA_BUNDLE_ID
      : "com.emanueledipietro.synara.dev";

function prepare() {
  nodeFs.rmSync(PATHS.RUN_DIR, { recursive: true, force: true });
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
  const flavorEnv: Record<string, string> = BUNDLE_ID
    ? { SYNARA_DESKTOP_BUNDLE_ID: BUNDLE_ID }
    : {};
  if (STABLE_MODE || CLI_MODE) {
    const fakeAccount = await startFakeAccount(LOOPBACK, await freePort());
    const account = ALTO_UI
      ? await startAccountSwitch(LOOPBACK, await freePort(), fakeAccount.url)
      : fakeAccount;
    write(nodePath.join(STATE_DIR, "account.json"), JSON.stringify({ url: account.url }));
    flavorEnv.SYNARA_ACCOUNT_URL = account.url;
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
      PATH: [FAKE_GH_BIN, baseEnv.PATH].filter(Boolean).join(nodePath.delimiter),
      // As the desktop shell does: this PATH is final, so the server does not put the login
      // shell's PATH (and the real `gh`) in front of the fake one.
      SYNARA_PATH_HYDRATED: "1",
      ...flavorEnv,
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

  let wsPort = serverPort;
  if (OLD_HOST_MODE) {
    wsPort = await freePort();
    const proxy = spawn("bun", [OLD_HOST_PROXY, String(wsPort), String(serverPort)], {
      stdio: "inherit",
      env: baseEnv,
    });
    children.push(proxy);
    proxy.on("exit", (code) => {
      console.error(`[start-app] old-host proxy exited with ${code}`);
      stop();
      process.exit(1);
    });
    await waitFor(`http://${LOOPBACK}:${wsPort}/__scenario/state`, 30_000);
    write(
      nodePath.join(STATE_DIR, "proxy.json"),
      JSON.stringify({ url: `http://${LOOPBACK}:${wsPort}` }),
    );
    console.error(`[start-app] old-host proxy ready on ${wsPort}`);
  }

  const web = spawn("bun", ["run", "dev", "--host", LOOPBACK], {
    cwd: nodePath.join(REPO, "apps/web"),
    stdio: "inherit",
    env: {
      ...baseEnv,
      PORT: String(webPort),
      VITE_WS_URL: `ws://${LOOPBACK}:${wsPort}`,
      // The billing UI a Stable desktop build ships, against Polar's sandbox.
      ...(ALTO_UI ? { VITE_SYNARA_BILLING_SANDBOX: "1" } : {}),
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

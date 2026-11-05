/** Real public discovery and private recovery state, independent of host/account lifetime. */
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import {
  accountApiIssuer,
  accountCredentialsPath,
  runAuthLogout,
  writeAccountCredentials,
} from "./accountAuth";
import { startRemoteAuthorization } from "./cloudflare/authorization";
import { recordRemoteBillingPolicyHint, startRemoteBillingPolicy } from "./remoteBillingPolicy";
import { RemoteSessionRegistry } from "./remoteSessions/sessionRegistry";

const directories: string[] = [];
const servers: http.Server[] = [];
const policies: Array<Awaited<ReturnType<typeof startRemoteBillingPolicy>>> = [];

afterEach(async () => {
  for (const policy of policies.splice(0)) await policy.stop();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

async function fixture(enforced?: boolean) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "synara-public-billing-policy-"));
  directories.push(baseDir);
  const stateDir = path.join(baseDir, "userdata");
  await fs.mkdir(stateDir, { mode: 0o700 });
  const reply: {
    enforced: boolean | undefined;
    status: number;
    hold: boolean;
    redirectTo?: string;
  } = { enforced, status: 200, hold: false };
  const requests: http.IncomingMessage[] = [];
  let release: (() => void) | undefined;
  const server = http.createServer((request, response) => {
    requests.push(request);
    const respond = () => {
      response.writeHead(reply.status, {
        "content-type": "application/json",
        ...(reply.redirectTo ? { location: reply.redirectTo } : {}),
      });
      response.end(
        JSON.stringify(
          reply.status === 200
            ? {
                version: "test",
                authMode: "workos",
                clientId: "test-client",
                workosApiUrl: "https://identity.test",
                ...(reply.enforced === undefined ? {} : { remoteBillingEnforced: reply.enforced }),
              }
            : { error: "internal_error", message: "Unavailable" },
        ),
      );
    };
    if (reply.hold) release = respond;
    else respond();
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("HTTP server did not bind");
  const accountUrl = `http://127.0.0.1:${address.port}`;
  async function start(
    required: boolean,
    registry = new RemoteSessionRegistry(),
    now?: () => number,
    url = accountUrl,
  ) {
    const policy = await startRemoteBillingPolicy({
      stateDir,
      accountUrl: url,
      required,
      remoteSessions: registry,
      pollIntervalMs: 60_000,
      ...(now === undefined ? {} : { now }),
    });
    policies.push(policy);
    return { policy, registry };
  }
  return {
    baseDir,
    stateDir,
    accountUrl,
    reply,
    requests,
    server,
    start,
    release: () => release?.(),
  };
}

it.each([false, true])(
  "keeps required=%s admission correct on a cold outage or missing public flag",
  async (required) => {
    const f = await fixture();
    f.reply.status = 503;
    const { policy, registry } = await f.start(required);
    expect(registry.canAdmitRemoteSession()).toBe(!required);
    await policy.refresh();
    f.reply.status = 200;
    await policy.refresh();
    expect(registry.canAdmitRemoteSession()).toBe(!required);
    expect(await fs.readdir(f.stateDir)).toEqual([]);
    expect(
      f.requests.every(
        (request) =>
          request.url === "/api/v1/instance" && request.headers.authorization === undefined,
      ),
    ).toBe(true);
  },
);

it("starts without waiting for a stalled public endpoint and bounds the background attempt", async () => {
  const f = await fixture(false);
  f.reply.hold = true;
  const { policy, registry } = await f.start(true);
  expect(registry.canAdmitRemoteSession()).toBe(false);
  await policy.refresh();
  expect(f.requests).toHaveLength(1);
  expect(registry.canAdmitRemoteSession()).toBe(false);
  f.reply.hold = false;
  await policy.refresh();
  expect(registry.canAdmitRemoteSession()).toBe(true);
});

it("expires false proof within sixty seconds without extending it on older responses", async () => {
  const f = await fixture(false);
  let clock = 1_000;
  const { policy, registry } = await f.start(true, undefined, () => clock);
  await policy.refresh();
  expect(registry.canAdmitRemoteSession()).toBe(true);
  let closed = 0;
  registry.registerLegacyConnection(() => {
    closed++;
  });
  f.reply.enforced = undefined;
  clock = 31_000;
  await policy.refresh();
  clock = 60_999;
  expect(registry.canAdmitRemoteSession()).toBe(true);
  clock = 61_000;
  expect(registry.canAdmitRemoteSession()).toBe(false);
  await policy.refresh();
  expect(closed).toBe(1);
  clock = 60_999;
  expect(registry.canAdmitRemoteSession()).toBe(false);
  clock = 61_000;
  f.reply.enforced = false;
  await policy.refresh();
  expect(registry.canAdmitRemoteSession()).toBe(true);
  clock = 60_999;
  expect(registry.canAdmitRemoteSession()).toBe(false);
});

it("closes unpaid connections on true and restores that policy after actual account logout", async () => {
  const f = await fixture(true);
  const registry = new RemoteSessionRegistry();
  let closed = 0;
  registry.registerLegacyConnection(() => {
    closed++;
  });
  const { policy } = await f.start(false, registry);
  await policy.refresh();
  expect(closed).toBe(1);
  expect(registry.canAdmitRemoteSession()).toBe(false);
  await writeAccountCredentials(f.baseDir, {
    accountUrl: f.accountUrl,
    workosClientId: "test-client",
    workosApiUrl: "https://identity.test",
    organizationId: "test-org",
    accessToken: "test-access",
    refreshToken: "test-refresh",
  });
  await runAuthLogout({ baseDir: f.baseDir, stdout: () => {} });
  await expect(fs.stat(accountCredentialsPath(f.baseDir))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await policy.stop();
  f.reply.status = 503;
  const restored = await f.start(false);
  expect(restored.registry.canAdmitRemoteSession()).toBe(false);
  await restored.policy.refresh();
  const files = await fs.readdir(f.stateDir);
  const policyName = files.find((file) => file.startsWith("remote-billing-policy-"));
  expect(policyName).toBeDefined();
  const stored = JSON.parse(await fs.readFile(path.join(f.stateDir, policyName!), "utf8"));
  expect(Object.keys(stored).sort()).toEqual(["apiIssuer", "checkedAt", "enforced"]);
  expect(stored).toMatchObject({ apiIssuer: accountApiIssuer(f.accountUrl), enforced: true });
  if (process.platform !== "win32")
    expect((await fs.stat(path.join(f.stateDir, policyName!))).mode & 0o777).toBe(0o600);
});

it("pauses an unpaid OFF lease at public ON, preserves paid access, and accepts explicit OFF", async () => {
  const f = await fixture(false);
  const registry = new RemoteSessionRegistry();
  const abort = new AbortController();
  let hostRefreshes = 0;
  const hostPoll = startRemoteAuthorization({
    refresh: async () => {
      hostRefreshes++;
      return {
        ownerUserId: "owner",
        orgId: "workspace",
        ownerInOrg: true,
        discoverable: true,
        revokedDeviceJkts: [],
        pendingRevocationDeviceJkts: [],
        remoteBillingEnforced: false,
      };
    },
    apply: async () => {},
    unavailable: async () => {},
    signal: abort.signal,
    pollIntervalMs: 3_600_000,
  });
  registry.registerAdmissionGuard({
    authority: accountApiIssuer(f.accountUrl),
    available: hostPoll.paidAvailable,
  });
  let closed = 0;
  try {
    await vi.waitFor(() => expect(hostPoll.available()).toBe(true));
    expect(hostPoll.paidAvailable()).toBe(false);
    const { policy } = await f.start(false, registry);
    await policy.refresh();
    registry.registerLegacyConnection(() => {
      closed++;
    });
    f.reply.enforced = true;
    await policy.refresh();
    expect(hostRefreshes).toBe(1);
    expect(hostPoll.available()).toBe(true);
    expect(hostPoll.paidAvailable()).toBe(false);
    expect(registry.canAdmitRemoteSession()).toBe(false);
    expect(closed).toBe(1);

    registry.registerAdmissionGuard({
      authority: accountApiIssuer(f.accountUrl),
      available: () => true,
    });
    registry.registerLegacyConnection(() => {
      closed++;
    });
    await policy.refresh();
    expect(closed).toBe(1);
    expect(registry.canAdmitRemoteSession()).toBe(true);
    registry.setRemoteBillingEnforced(true);
    f.reply.enforced = false;
    await policy.refresh();
    expect(registry.remoteBillingEnforced).toBe(false);
    await policy.stop();
    expect(registry.remoteBillingEnforced).toBe(false);
  } finally {
    abort.abort();
    await hostPoll.done;
  }
});

it("retains authority A's true hint while an independent authority B disables enforcement", async () => {
  const f = await fixture();
  await recordRemoteBillingPolicyHint(f.stateDir, f.accountUrl, true);
  const otherUrl = `${f.accountUrl}/other`;
  await recordRemoteBillingPolicyHint(f.stateDir, otherUrl, false);
  f.reply.status = 503;
  const other = await f.start(false, undefined, undefined, otherUrl);
  expect(other.registry.remoteBillingEnforced).toBe(false);
  await other.policy.stop();
  const original = await f.start(false);
  expect(original.registry.remoteBillingEnforced).toBe(true);
  await original.policy.stop();
  expect(original.registry.remoteBillingEnforced).toBe(true);
});

it("does not follow a deployment redirect to another authority's disabled policy", async () => {
  const original = await fixture(true);
  const other = await fixture(false);
  const { policy, registry } = await original.start(false);
  await policy.refresh();
  expect(registry.remoteBillingEnforced).toBe(true);
  original.reply.status = 302;
  original.reply.redirectTo = `${other.accountUrl}/api/v1/instance`;
  await policy.refresh();
  expect(registry.remoteBillingEnforced).toBe(true);
  expect(other.requests).toHaveLength(0);
});

it.each([false, true])(
  "discards an old false response after a new authenticated denial when enforcement was already %s",
  async (initiallyEnforced) => {
    const f = await fixture(false);
    f.reply.hold = true;
    const registry = new RemoteSessionRegistry();
    registry.setRemoteBillingEnforced(initiallyEnforced);
    const { policy } = await f.start(false, registry);
    if (f.requests.length === 0) await once(f.server, "request");
    registry.setRemoteBillingEnforced(true);
    await recordRemoteBillingPolicyHint(f.stateDir, f.accountUrl, true);
    f.release();
    await policy.refresh();
    expect(registry.remoteBillingEnforced).toBe(true);
    await policy.stop();
    f.reply.hold = false;
    f.reply.status = 503;
    const restored = await f.start(false);
    expect(restored.registry.remoteBillingEnforced).toBe(true);
  },
);

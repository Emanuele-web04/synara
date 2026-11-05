// Purpose: Keep pairing redemption's first bearer bound to its captured account authority.
// Uses the public management entry point, real account helper/client, and an inert fetch observer.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EnvironmentId } from "@synara/contracts";
import { Effect } from "effect";
import { calculateJwkThumbprint, exportJWK, generateKeyPair } from "jose";
import { afterEach, expect, it, vi } from "vitest";

import { readAccountFile, writeAccountCredentials } from "../accountAuth";
import { makeRemoteAccessManagement, type RemoteAccessManagementOptions } from "./management";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each(["unchanged", "replaced"] as const)(
  "keeps pairing's first bearer bound to its captured authority (account %s)",
  async (accountState) => {
    vi.stubEnv("SYNARA_DESKTOP_BUNDLE_ID", "");
    vi.stubEnv("SYNARA_REMOTE_CONNECTIONS", "1");
    const baseDir = await mkdtemp(path.join(tmpdir(), "synara-pairing-account-scope-"));
    const initial = {
      accountUrl: "https://account-a.example.test",
      workosClientId: "client-a",
      workosApiUrl: "https://identity-a.example.test",
      organizationId: "org-a",
      userId: "owner-a",
      accessToken: "dummy-access-a",
      refreshToken: "dummy-refresh-a",
      hostId: "host-a",
      hostOwnerUserId: "owner-a",
      hostKeyGeneration: 1,
    };
    const replacement = {
      ...initial,
      accountUrl: "https://account-b.example.test",
      userId: "owner-b",
      organizationId: "org-b",
      accessToken: "dummy-access-b",
      refreshToken: "dummy-refresh-b",
      hostId: "host-b",
      hostOwnerUserId: "owner-b",
    };
    const requests: Array<{ url: string; authorization: string | null }> = [];
    // The actual AccountClient reaches this observer; no request leaves the fixture.
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Response.json({ error: "internal_error", message: "Dummy refusal" }, { status: 503 });
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
      await writeAccountCredentials(baseDir, initial);
      const keys = await generateKeyPair("ES256", { extractable: true });
      const publicJwk = await exportJWK(keys.publicKey);
      const jkt = await calculateJwkThumbprint(publicJwk);
      const manage = makeRemoteAccessManagement({
        config: { baseDir, stateDir: baseDir },
        environment: {
          getDescriptor: Effect.succeed({
            environmentId: EnvironmentId.makeUnsafe("controller"),
            label: "Dummy controller",
          }),
        },
        account: {
          dialIdentity: async () => {
            entered.resolve();
            await release.promise;
            return { key: keys.privateKey, publicJwk, jkt, userId: initial.userId };
          },
        },
      } as unknown as RemoteAccessManagementOptions);
      const attempted = manage(
        { operation: "redeem-code", code: "ABCD-2345" },
        new AbortController().signal,
      ).catch((error: unknown) => error);
      await entered.promise;
      if (accountState === "replaced") await writeAccountCredentials(baseDir, replacement);
      release.resolve();
      expect(await attempted).toBeInstanceOf(Error);
      if (accountState === "unchanged") expect(requests).toHaveLength(1);
      for (const request of requests) {
        expect(request).toEqual({
          url: `${initial.accountUrl}/api/v1/remote/pairing-codes/redeem`,
          authorization: `Bearer ${initial.accessToken}`,
        });
      }
      expect(await readAccountFile(baseDir)).toMatchObject(
        accountState === "replaced" ? replacement : initial,
      );
    } finally {
      release.resolve();
      await rm(baseDir, { recursive: true, force: true });
    }
  },
);

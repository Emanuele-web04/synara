import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ComputerAuditEntry } from "./computerAuditLog.ts";
import {
  COMPUTER_GRANT_APPLIED_CODE,
  COMPUTER_GRANT_AUDIT_TOOL,
  COMPUTER_GRANT_CREATED_CODE,
  COMPUTER_GRANT_EXPIRED_CODE,
  COMPUTER_GRANT_PERSIST_FAILED_CODE,
  COMPUTER_GRANT_REFUSED_CODE,
  COMPUTER_GRANT_REVOKED_CODE,
  ComputerGrantStore,
  computerGrantAppIdentityMatches,
  computerGrantClassesForTool,
  computerGrantIdentityForApp,
  computerGrantIdentityForAppArg,
  computerGrantIdentityForPid,
  computerGrantIdentityForWindow,
  type ComputerGrantCallContext,
} from "./computerGrants.ts";
import type {
  ComputerApp,
  ComputerGrantActionClass,
  ComputerGrantAppIdentity,
  ComputerWindow,
} from "@synara/contracts";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "computer-grants-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const SAFARI: ComputerApp = {
  pid: 100,
  name: "Safari",
  bundleId: "com.apple.Safari",
  teamId: "APPLE_TEAM",
  running: true,
  active: true,
};

const FINDER: ComputerApp = {
  pid: 200,
  name: "Finder",
  bundleId: "com.apple.finder",
  teamId: "APPLE_TEAM",
  running: true,
  active: false,
};

const SAFARI_WINDOW: ComputerWindow = {
  id: "win-safari-1",
  title: "Safari",
  appName: "Safari",
  pid: 100,
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  focused: true,
  minimized: false,
  visible: true,
};

function context(input: Partial<ComputerGrantCallContext>): ComputerGrantCallContext {
  return {
    apps: [],
    includesUnattributedTarget: false,
    classes: [],
    ...input,
  };
}

function auditCollector() {
  const entries: Array<Omit<ComputerAuditEntry, "ts">> = [];
  return {
    entries,
    audit: (entry: Omit<ComputerAuditEntry, "ts">) => {
      entries.push(entry);
    },
  };
}

describe("computerGrantAppIdentityMatches", () => {
  it("matches on bundle id case-insensitively and honors a recorded team id", () => {
    const grant = { name: "Safari", bundleId: "COM.APPLE.SAFARI", teamId: "APPLE_TEAM" };
    expect(
      computerGrantAppIdentityMatches(grant, {
        name: "Safari",
        bundleId: "com.apple.Safari",
        teamId: "apple_team",
      }),
    ).toBe(true);
    // A different signer under the same bundle id never inherits the grant.
    expect(
      computerGrantAppIdentityMatches(grant, {
        name: "Safari",
        bundleId: "com.apple.Safari",
        teamId: "OTHER_TEAM",
      }),
    ).toBe(false);
    // A call that resolved no team id cannot satisfy a team-pinned grant.
    expect(
      computerGrantAppIdentityMatches(grant, { name: "Safari", bundleId: "com.apple.Safari" }),
    ).toBe(false);
    // A grant recorded without a team matches whatever signer the call saw.
    expect(
      computerGrantAppIdentityMatches(
        { name: "Safari", bundleId: "com.apple.Safari" },
        { name: "Safari", bundleId: "com.apple.Safari", teamId: "ANY_TEAM" },
      ),
    ).toBe(true);
  });

  it("refuses name-only agreement under a known bundle id, and keeps name grants residual", () => {
    // The bundle-id grant must not match a call that only saw a name — that
    // is exactly the spoof a durable grant cannot inherit.
    expect(
      computerGrantAppIdentityMatches(
        { name: "Safari", bundleId: "com.apple.Safari" },
        {
          name: "Safari",
        },
      ),
    ).toBe(false);
    expect(computerGrantAppIdentityMatches({ name: "Safari" }, { name: "safari" })).toBe(true);
    expect(
      computerGrantAppIdentityMatches({ name: "Safari" }, { name: "Safari Technology Preview" }),
    ).toBe(false);
    expect(
      computerGrantAppIdentityMatches(
        { name: "Safari" },
        { name: "Safari", bundleId: "com.apple.Safari" },
      ),
    ).toBe(true);
  });
});

describe("computerGrant identity resolvers", () => {
  it("resolves window and pid targets through the app inventory, never to a pid", () => {
    const fromWindow = computerGrantIdentityForWindow(SAFARI_WINDOW, [SAFARI, FINDER]);
    expect(fromWindow).toEqual({
      name: "Safari",
      bundleId: "com.apple.Safari",
      teamId: "APPLE_TEAM",
    });
    expect(fromWindow).not.toHaveProperty("pid");
    expect(computerGrantIdentityForPid(100, [SAFARI, FINDER])).toEqual(fromWindow);
    // A pid with no running owner resolves nothing rather than keying on a
    // recycled handle.
    expect(computerGrantIdentityForPid(999, [SAFARI])).toBeUndefined();
    // A window whose pid resolves to no running app falls back to its app name.
    expect(computerGrantIdentityForWindow({ ...SAFARI_WINDOW, pid: 999 }, [SAFARI])).toEqual({
      name: "Safari",
    });
  });

  it("resolves launch_app spellings on bundle id or exact name", () => {
    expect(computerGrantIdentityForAppArg("com.apple.Safari", [SAFARI])).toEqual(
      computerGrantIdentityForApp(SAFARI),
    );
    expect(computerGrantIdentityForAppArg("Safari", [SAFARI])).toEqual(
      computerGrantIdentityForApp(SAFARI),
    );
    // Unknown spellings keep a name-only residual identity — the denylist
    // still decides whether the launch itself may proceed.
    expect(computerGrantIdentityForAppArg("com.unknown.App", [])).toEqual({
      name: "com.unknown.App",
      bundleId: "com.unknown.App",
    });
    expect(computerGrantIdentityForAppArg("Not Installed", [])).toEqual({
      name: "Not Installed",
    });
    expect(computerGrantIdentityForAppArg("   ", [SAFARI])).toBeUndefined();
  });
});

describe("computerGrantClassesForTool", () => {
  it("maps tools to their action classes and unions a run's steps", () => {
    expect(computerGrantClassesForTool("computer_click", {})).toEqual(["input"]);
    expect(computerGrantClassesForTool("computer_activate_window", {})).toEqual(["lifecycle"]);
    expect(computerGrantClassesForTool("computer_read_clipboard", {})).toEqual(["clipboard"]);
    expect(computerGrantClassesForTool("computer_paste", {})).toEqual(["clipboard", "input"]);
    expect(computerGrantClassesForTool("computer_browser_click", {})).toEqual(["browser"]);
    expect(
      computerGrantClassesForTool("computer_run", {
        steps: [
          { type: "click" },
          { type: "activate_window", window_id: "w1" },
          { type: "wait", duration_ms: 10 },
          { type: "write_clipboard", text: "x" },
        ],
      }),
    ).toEqual(["input", "lifecycle", "clipboard"]);
    // An ungated read contributes nothing — there is no class to grant.
    expect(computerGrantClassesForTool("computer_get_state", {})).toEqual([]);
  });
});

describe("ComputerGrantStore", () => {
  it("covers a call whose app and action classes a live grant spans, and audits it", async () => {
    const dir = await tempDir();
    const { entries, audit } = auditCollector();
    const store = new ComputerGrantStore({
      filePath: join(dir, "computer-grants.json"),
      audit,
      defaultTtlMs: 60_000,
    });
    const created = store.createFromApproval({
      offer: { apps: [computerGrantIdentityForApp(SAFARI)], classes: ["input"] },
      choice: { classes: ["input"], scope: "app" },
      threadId: "thread-1",
      isAppDenied: () => false,
    });
    expect(created).toHaveLength(1);
    expect(created[0]!.app).toMatchObject({ bundleId: "com.apple.Safari", teamId: "APPLE_TEAM" });
    expect(created[0]!.classes).toEqual(["input"]);
    expect(created[0]!.createdByThreadId).toBe("thread-1");
    expect(entries.map((entry) => entry.code)).toEqual([COMPUTER_GRANT_CREATED_CODE]);
    expect(entries[0]).toMatchObject({
      tool: COMPUTER_GRANT_AUDIT_TOOL,
      threadId: "thread-1",
      target: { app: "Safari", bundleId: "com.apple.Safari" },
      effect: "verified",
    });

    const covered = store.covers(
      context({
        apps: [computerGrantIdentityForApp(SAFARI)],
        classes: ["input"],
      }),
    );
    expect(covered?.map((grant) => grant.id)).toEqual([created[0]!.id]);
    store.noteUse(
      covered!.map((grant) => grant.id),
      { toolName: "computer_click", threadId: "thread-1", turnId: "turn-1" },
    );
    expect(entries.at(-1)).toMatchObject({
      code: COMPUTER_GRANT_APPLIED_CODE,
      threadId: "thread-1",
      turnId: "turn-1",
      args: { forTool: "computer_click", grantIds: [created[0]!.id] },
      effect: "verified",
    });
    expect(store.list()[0]!.lastUsedAt).toBeDefined();
    await store.flush();
  });

  it("refuses mismatched bundle ids and action classes, and requires every app covered", () => {
    const store = new ComputerGrantStore({ defaultTtlMs: 60_000 });
    store.createFromApproval({
      offer: { apps: [computerGrantIdentityForApp(SAFARI)], classes: ["input"] },
      choice: { classes: ["input"], scope: "app" },
      isAppDenied: () => false,
    });
    // A different bundle id never matches.
    expect(
      store.covers(context({ apps: [computerGrantIdentityForApp(FINDER)], classes: ["input"] })),
    ).toBeUndefined();
    // A lifecycle call is outside an input grant's classes.
    expect(
      store.covers(
        context({ apps: [computerGrantIdentityForApp(SAFARI)], classes: ["lifecycle"] }),
      ),
    ).toBeUndefined();
    // A call spanning two apps needs each covered — one ungranted app denies.
    store.createFromApproval({
      offer: { apps: [computerGrantIdentityForApp(FINDER)], classes: ["input"] },
      choice: { classes: ["input"], scope: "app" },
      isAppDenied: () => false,
    });
    expect(
      store.covers(
        context({
          apps: [computerGrantIdentityForApp(SAFARI), computerGrantIdentityForApp(FINDER)],
          classes: ["input"],
        }),
      ),
    ).toHaveLength(2);
  });

  it("keeps unattributed targets for any-app grants only", () => {
    const store = new ComputerGrantStore({ defaultTtlMs: 60_000 });
    store.createFromApproval({
      offer: { apps: [computerGrantIdentityForApp(SAFARI)], classes: ["input"] },
      choice: { classes: ["input"], scope: "app" },
      isAppDenied: () => false,
    });
    // The shared clipboard has no owning app: an app grant cannot cover it.
    expect(
      store.covers(context({ includesUnattributedTarget: true, classes: ["clipboard"] })),
    ).toBeUndefined();
    const anyApp = store.createFromApproval({
      offer: { apps: [], classes: ["clipboard", "input"] },
      choice: { classes: ["clipboard", "input"], scope: "any-app" },
      isAppDenied: () => false,
    });
    expect(anyApp).toHaveLength(1);
    expect(anyApp[0]!.app).toBeNull();
    // The any-app grant covers the unattributed clipboard call — and only the
    // classes it names, not Safari's ungranted lifecycle calls.
    expect(
      store.covers(context({ includesUnattributedTarget: true, classes: ["clipboard"] })),
    ).toHaveLength(1);
    expect(
      store.covers(context({ includesUnattributedTarget: true, classes: ["lifecycle"] })),
    ).toBeUndefined();
    // An any-app grant covers a resolved app it never named, for the classes
    // it carries — that is the whole point of the scope.
    expect(
      store.covers(context({ apps: [computerGrantIdentityForApp(FINDER)], classes: ["input"] })),
    ).toHaveLength(1);
  });

  it("clamps the created classes to the prompt's offer and mints nothing outside it", () => {
    const store = new ComputerGrantStore({ defaultTtlMs: 60_000 });
    const created = store.createFromApproval({
      offer: { apps: [computerGrantIdentityForApp(SAFARI)], classes: ["input"] },
      // A response asking for more than the prompt offered narrows, never widens.
      choice: { classes: ["input", "lifecycle", "clipboard"], scope: "app" },
      isAppDenied: () => false,
    });
    expect(created[0]!.classes).toEqual(["input"]);
    expect(
      store.createFromApproval({
        offer: { apps: [computerGrantIdentityForApp(SAFARI)], classes: ["input"] },
        choice: { classes: ["lifecycle"], scope: "app" },
        isAppDenied: () => false,
      }),
    ).toHaveLength(0);
    // An app-scope choice on a target that never resolved mints nothing —
    // only an any-app grant can cover an unattributed call.
    expect(
      store.createFromApproval({
        offer: { apps: [], classes: ["clipboard"] },
        choice: { classes: ["clipboard"], scope: "app" },
        isAppDenied: () => false,
      }),
    ).toHaveLength(0);
    // A scope the offer never proposed mints nothing either: a call that
    // reached something unattributable offered only `any-app`, and an `app`
    // choice cannot quietly convert that into app grants the prompt hid.
    expect(
      store.createFromApproval({
        offer: {
          apps: [computerGrantIdentityForApp(SAFARI)],
          classes: ["input"],
          scopes: ["any-app"],
        },
        choice: { classes: ["input"], scope: "app" },
        isAppDenied: () => false,
      }),
    ).toHaveLength(0);
  });

  it("refuses denylisted identities at mint time with an audit row", () => {
    const { entries, audit } = auditCollector();
    const store = new ComputerGrantStore({ audit });
    const created = store.createFromApproval({
      offer: { apps: [computerGrantIdentityForApp(SAFARI)], classes: ["input"] },
      choice: { classes: ["input"], scope: "app" },
      isAppDenied: (identity) => identity.bundleId === "com.apple.Safari",
    });
    expect(created).toHaveLength(0);
    expect(store.list()).toHaveLength(0);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      effect: "refused",
      code: "computer_denylist_refused",
      target: { app: "Safari", bundleId: "com.apple.Safari" },
    });
  });

  it("clamps requested lifetimes to the store bounds and renews an identical grant in place", () => {
    let now = 1_000_000;
    const { entries, audit } = auditCollector();
    const store = new ComputerGrantStore({ now: () => now, audit, defaultTtlMs: 60_000 });
    const offer: {
      apps: ComputerGrantAppIdentity[];
      classes: ComputerGrantActionClass[];
    } = { apps: [computerGrantIdentityForApp(SAFARI)], classes: ["input"] };
    const created = store.createFromApproval({
      offer,
      choice: { classes: ["input"], scope: "app", ttlMs: 1 },
      isAppDenied: () => false,
    });
    // Below-minimum TTL clamps up, never silently drops.
    expect(Date.parse(created[0]!.expiresAt) - now).toBe(60_000);
    now += 10_000;
    const renewed = store.createFromApproval({
      offer,
      choice: { classes: ["input"], scope: "app", ttlMs: Number.MAX_SAFE_INTEGER },
      isAppDenied: () => false,
    });
    // The same app + classes renews the row instead of stacking a duplicate.
    expect(renewed).toHaveLength(1);
    expect(renewed[0]!.id).toBe(created[0]!.id);
    expect(Date.parse(renewed[0]!.expiresAt) - now).toBe(7 * 24 * 60 * 60 * 1_000);
    expect(store.list()).toHaveLength(1);
    expect(entries.at(-1)?.args).toMatchObject({ renewed: true });
  });

  it("expires grants lazily, audits the lapse once, and stops covering", async () => {
    const dir = await tempDir();
    let now = 1_000_000;
    const { entries, audit } = auditCollector();
    const store = new ComputerGrantStore({
      filePath: join(dir, "computer-grants.json"),
      now: () => now,
      audit,
      defaultTtlMs: 60_000,
    });
    const created = store.createFromApproval({
      offer: { apps: [computerGrantIdentityForApp(SAFARI)], classes: ["input"] },
      choice: { classes: ["input"], scope: "app" },
      threadId: "thread-1",
      isAppDenied: () => false,
    });
    await store.flush();
    now += 60_001;
    expect(
      store.covers(context({ apps: [computerGrantIdentityForApp(SAFARI)], classes: ["input"] })),
    ).toBeUndefined();
    expect(store.list()).toHaveLength(0);
    const expired = entries.filter((entry) => entry.code === COMPUTER_GRANT_EXPIRED_CODE);
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({
      threadId: "thread-1",
      args: { grantId: created[0]!.id },
      effect: "refused",
    });
    // A second read does not re-audit the same lapse.
    store.list();
    expect(entries.filter((entry) => entry.code === COMPUTER_GRANT_EXPIRED_CODE)).toHaveLength(1);
    // The prune persisted: a reload sees an empty store, not a stale grant.
    // (One live writer per file — flush before handing the path over.)
    await store.flush();
    const reloaded = new ComputerGrantStore({
      filePath: join(dir, "computer-grants.json"),
      now: () => now,
    });
    expect(reloaded.list()).toHaveLength(0);
    await reloaded.flush();
  });

  it("expires grants that lapsed while the server was off on first load", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "computer-grants.json");
    let now = 1_000_000;
    const first = new ComputerGrantStore({ filePath, now: () => now });
    const created = first.createFromApproval({
      offer: { apps: [computerGrantIdentityForApp(SAFARI)], classes: ["input"] },
      choice: { classes: ["input"], scope: "app", ttlMs: 60_000 },
      isAppDenied: () => false,
    });
    await first.flush();
    now += 60_001;
    const { entries, audit } = auditCollector();
    const reloaded = new ComputerGrantStore({ filePath, now: () => now, audit });
    expect(reloaded.list()).toHaveLength(0);
    expect(
      reloaded.covers(context({ apps: [computerGrantIdentityForApp(SAFARI)], classes: ["input"] })),
    ).toBeUndefined();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      code: COMPUTER_GRANT_EXPIRED_CODE,
      args: { grantId: created[0]!.id },
    });
    await reloaded.flush();
  });

  it("revokes durably, audits the revocation, and stops covering", async () => {
    const dir = await tempDir();
    const { entries, audit } = auditCollector();
    const store = new ComputerGrantStore({
      filePath: join(dir, "computer-grants.json"),
      audit,
    });
    const created = store.createFromApproval({
      offer: { apps: [computerGrantIdentityForApp(SAFARI)], classes: ["input"] },
      choice: { classes: ["input"], scope: "app" },
      isAppDenied: () => false,
    });
    expect(store.revoke("cg_missing")).toBe(false);
    expect(store.revoke(created[0]!.id)).toBe(true);
    expect(store.list()).toHaveLength(0);
    expect(
      store.covers(context({ apps: [computerGrantIdentityForApp(SAFARI)], classes: ["input"] })),
    ).toBeUndefined();
    expect(entries.at(-1)).toMatchObject({
      code: COMPUTER_GRANT_REVOKED_CODE,
      args: { grantId: created[0]!.id, classes: ["input"] },
      target: { app: "Safari", bundleId: "com.apple.Safari" },
      effect: "verified",
    });
    await store.flush();
    const reloaded = new ComputerGrantStore({ filePath: join(dir, "computer-grants.json") });
    expect(reloaded.list()).toHaveLength(0);
  });

  it("persists created grants across a reload", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "computer-grants.json");
    const store = new ComputerGrantStore({ filePath });
    const created = store.createFromApproval({
      offer: { apps: [computerGrantIdentityForApp(SAFARI)], classes: ["input"] },
      choice: { classes: ["input"], scope: "app", ttlMs: 60_000 },
      isAppDenied: () => false,
    });
    await store.flush();
    const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
      version: number;
      grants: Array<{ id: string }>;
    };
    expect(persisted.version).toBe(1);
    expect(persisted.grants.map((grant) => grant.id)).toEqual([created[0]!.id]);
    const reloaded = new ComputerGrantStore({ filePath });
    expect(reloaded.list()).toHaveLength(1);
    expect(
      reloaded.covers(context({ apps: [computerGrantIdentityForApp(SAFARI)], classes: ["input"] })),
    ).toHaveLength(1);
    await reloaded.flush();
  });

  it("fails closed on a malformed grant file: nothing covers, nothing mints", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "computer-grants.json");
    await writeFile(filePath, "{ not json", { mode: 0o600 });
    const store = new ComputerGrantStore({ filePath });
    expect(
      store.covers(context({ apps: [computerGrantIdentityForApp(SAFARI)], classes: ["input"] })),
    ).toBeUndefined();
    expect(
      store.createFromApproval({
        offer: { apps: [computerGrantIdentityForApp(SAFARI)], classes: ["input"] },
        choice: { classes: ["input"], scope: "app" },
        isAppDenied: () => false,
      }),
    ).toHaveLength(0);
    // The unreadable file is left untouched rather than overwritten.
    expect(await readFile(filePath, "utf8")).toBe("{ not json");
  });

  it("refuses creation past the live-grant cap with an audit row", () => {
    const { entries, audit } = auditCollector();
    const store = new ComputerGrantStore({ audit });
    const denied = vi.fn(() => false);
    // Mint through distinct identities until the cap row lands.
    let refusedAt = -1;
    for (let index = 0; index < 300; index += 1) {
      const created = store.createFromApproval({
        offer: {
          apps: [{ name: `App ${index}`, bundleId: `com.example.app${index}` }],
          classes: ["input"],
        },
        choice: { classes: ["input"], scope: "app" },
        isAppDenied: denied,
      });
      if (created.length === 0) {
        refusedAt = index;
        break;
      }
    }
    expect(refusedAt).toBeGreaterThanOrEqual(0);
    expect(store.list().length).toBeLessThanOrEqual(256);
    expect(entries.some((entry) => entry.code === COMPUTER_GRANT_REFUSED_CODE)).toBe(true);
  });

  it("a failed durable write marks the store degraded, writes an audit row, and clears on the next success", async () => {
    const dir = await tempDir();
    const { entries, audit } = auditCollector();
    // A read-only directory: the file load ENOENTs clean (no store yet), but
    // every durable write EACCESes.
    const grantsDir = join(dir, "grants-dir");
    await mkdir(grantsDir);
    await chmod(grantsDir, 0o500);
    const filePath = join(grantsDir, "computer-grants.json");
    const store = new ComputerGrantStore({ filePath, audit, defaultTtlMs: 60_000 });
    const created = store.createFromApproval({
      offer: { apps: [computerGrantIdentityForApp(SAFARI)], classes: ["input"] },
      choice: { classes: ["input"], scope: "app" },
      threadId: "thread-1",
      isAppDenied: () => false,
    });
    expect(created).toHaveLength(1);
    await store.flush();
    // The in-memory grant stays live for this process — but the store must
    // not claim it persisted, and the failure must be evidence.
    expect(store.list()).toHaveLength(1);
    expect(store.degraded()?.message).toBe("Computer grant store could not be persisted.");
    expect(
      entries.some(
        (entry) =>
          entry.code === COMPUTER_GRANT_PERSIST_FAILED_CODE &&
          entry.tool === COMPUTER_GRANT_AUDIT_TOOL &&
          entry.effect === "refused",
      ),
    ).toBe(true);

    // With write permission back, the next mutation's write succeeds and
    // the degraded flag clears — recovery is reported, not just assumed.
    await chmod(grantsDir, 0o700);
    expect(store.revoke(created[0]!.id)).toBe(true);
    await store.flush();
    expect(store.degraded()).toBeUndefined();
    expect(store.list()).toHaveLength(0);
    const persisted = JSON.parse(await readFile(filePath, "utf8")) as { grants: unknown[] };
    expect(persisted.grants).toHaveLength(0);
  });
});

import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ComputerControlState } from "./ComputerControlState.ts";
import { ComputerManager } from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";

describe("durable Computer activation", () => {
  it("rejects frozen local and server queue generations after disable, re-enable and restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "synara-control-state-"));
    const file = join(dir, "control.json");
    const manager = new ComputerManager({
      backend: new FakeComputerBackend(),
      controlStatePath: file,
    });
    try {
      expect(manager.canActivateControl("thread", 0)).toBe(true);
      expect(await manager.setControlEnabled("thread", false)).toEqual({
        enabled: false,
        generation: 1,
      });
      expect(manager.canActivateControl("thread", 1)).toBe(false);
      expect(await manager.setControlEnabled("thread", true)).toEqual({
        enabled: true,
        generation: 1,
      });
      expect(manager.canActivateControl("thread", 0)).toBe(false);
      expect(manager.canActivateControl("thread", 1)).toBe(true);
      const restored = new ComputerControlState(file);
      expect(restored.allows("thread", 0)).toBe(false);
      expect(restored.allows("thread", 1)).toBe(true);
      await manager.setControlEnabled("thread", false);
      expect(new ComputerControlState(file).allows("thread", 2)).toBe(false);
    } finally {
      await manager.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("increments revocation synchronously and does not let overlapping enable undo a later disable", async () => {
    const manager = new ComputerManager({ backend: new FakeComputerBackend() });
    try {
      const firstDisable = manager.setControlEnabled("thread", false);
      expect(manager.canActivateControl("thread", 0)).toBe(false);
      const enable = manager.setControlEnabled("thread", true);
      const lastDisable = manager.setControlEnabled("thread", false);
      await Promise.all([firstDisable, enable, lastDisable]);
      expect(manager.canActivateControl("thread", 2)).toBe(false);
      expect(await manager.setControlEnabled("thread", true)).toEqual({
        enabled: true,
        generation: 2,
      });
      expect(manager.canActivateControl("thread", 1)).toBe(false);
    } finally {
      await manager.dispose();
    }
  });

  it("keeps authority closed if durable preference writes fail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "synara-control-failure-"));
    const blockedParent = join(dir, "blocked");
    const manager = new ComputerManager({
      backend: new FakeComputerBackend(),
      controlStatePath: join(blockedParent, "control.json"),
    });
    try {
      await writeFile(blockedParent, "not a directory");
      await expect(manager.setControlEnabled("thread", false)).rejects.toThrow();
      expect(manager.canActivateControl("thread", 0)).toBe(false);
      await expect(manager.setControlEnabled("thread", true)).rejects.toThrow();
      expect(manager.canActivateControl("thread", 1)).toBe(false);
    } finally {
      await manager.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

it("a malformed saved consent file disables Computer without breaking ordinary startup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "synara-control-corrupt-"));
  const file = join(dir, "control.json");
  await writeFile(file, "{broken");
  const manager = new ComputerManager({
    backend: new FakeComputerBackend(),
    controlStatePath: file,
  });
  try {
    expect(manager.canActivateControl("thread", 0)).toBe(false);
    await expect(manager.setControlEnabled("thread", true)).rejects.toThrow("could not be loaded");
    await expect(manager.withAgentActivity("thread", async () => undefined)).rejects.toThrow(
      "revoked",
    );
  } finally {
    await manager.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

it("persists only explicit matching-generation chat intent and clears it on background request, off and disable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "synara-chat-intent-"));
  const file = join(dir, "control.json");
  const manager = new ComputerManager({
    backend: new FakeComputerBackend(),
    controlStatePath: file,
  });
  try {
    expect(await manager.admitControl("thread", "request", 0)).toBe(true);
    expect(manager.canContinueChatControl("thread")).toBe(false);
    expect(await manager.admitControl("thread", "chat", 0)).toBe(true);
    expect(manager.canContinueChatControl("thread")).toBe(true);
    expect(new ComputerControlState(file).get("thread").chatGeneration).toBe(0);
    expect(manager.canContinueChatControl("other-thread")).toBe(false);
    await manager.admitControl("thread", "off", 0);
    expect(manager.canContinueChatControl("thread")).toBe(false);
    await manager.admitControl("thread", "chat", 0);
    await manager.setControlEnabled("thread", false);
    await manager.setControlEnabled("thread", true);
    expect(manager.canContinueChatControl("thread")).toBe(false);
    expect(await manager.admitControl("thread", "chat", 0)).toBe(false);
    expect(manager.canContinueChatControl("thread")).toBe(false);
    expect(await manager.admitControl("thread", "chat", 1)).toBe(true);
    expect(new ComputerControlState(file).get("thread").chatGeneration).toBe(1);
  } finally {
    await manager.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

it("one-shot requests never persist chat consent, including after a previous chat opt-in", async () => {
  const dir = await mkdtemp(join(tmpdir(), "synara-one-shot-"));
  const file = join(dir, "control.json");
  const manager = new ComputerManager({
    backend: new FakeComputerBackend(),
    controlStatePath: file,
  });
  try {
    expect(await manager.admitControl("thread", "chat", 0)).toBe(true);
    expect(manager.canContinueChatControl("thread")).toBe(true);
    for (const explicitInvocation of [false, true, true]) {
      expect(await manager.admitControl("thread", "request", 0, explicitInvocation)).toBe(true);
      expect(manager.canContinueChatControl("thread")).toBe(false);
      expect(new ComputerControlState(file).get("thread").chatGeneration).toBeUndefined();
    }
    await manager.admitControl("thread", "off", 0);
    expect(manager.canContinueChatControl("thread")).toBe(false);
  } finally {
    await manager.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

it("ordinary off admission does not create a consent file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "synara-off-no-io-"));
  const file = join(dir, "control.json");
  const manager = new ComputerManager({
    backend: new FakeComputerBackend(),
    controlStatePath: file,
  });
  try {
    expect(await manager.admitControl("thread", "off", 0)).toBe(false);
    expect(await manager.admitControl("thread", "off", 0)).toBe(false);
    await expect(access(file)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await manager.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

it("failed chat-intent persistence cannot authorize a later goal after re-enable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "synara-chat-write-failure-"));
  const blocked = join(dir, "blocked");
  const manager = new ComputerManager({
    backend: new FakeComputerBackend(),
    controlStatePath: join(blocked, "control.json"),
  });
  try {
    await writeFile(blocked, "not a directory");
    await expect(manager.admitControl("thread", "chat", 0)).rejects.toThrow();
    expect(manager.canContinueChatControl("thread")).toBe(false);
    await rm(blocked);
    await manager.setControlEnabled("thread", true);
    expect(manager.canContinueChatControl("thread")).toBe(false);
  } finally {
    await manager.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

it("serializes concurrent control writes per thread in call order", async () => {
  // Queued-dispatch and edit-resend admissions race through admitControl for
  // the same thread. Without serialization their read-modify-write sequences
  // interleave and concurrent revocations lose increments (last-writer-wins).
  const state = new ComputerControlState();
  await Promise.all([state.set("thread", true), state.set("thread", true)]);
  expect(state.get("thread")).toMatchObject({ disabled: true, generation: 2 });
});

it("applies a racing chat intent against the serialized generation", async () => {
  const state = new ComputerControlState();
  const record = state.recordChatIntent("thread", true, 0);
  const disable = state.set("thread", true);
  await Promise.all([record, disable]);
  // Call order wins: the intent recorded at generation 0, then the disable
  // bumped the generation and dropped it. A stale intent never survives a
  // concurrent revocation.
  expect(state.get("thread")).toMatchObject({ disabled: true, generation: 1 });
  expect(state.get("thread").chatGeneration).toBeUndefined();
});

import { EventEmitter } from "node:events";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createKeepAwakeController,
  type PersistedKeepAwakePreference,
  readKeepAwakePreference,
  writeKeepAwakePreference,
} from "./keepAwake";

function harness(initial: Partial<PersistedKeepAwakePreference> = {}, battery = false) {
  const power = { battery };
  const monitor = Object.assign(new EventEmitter(), { isOnBatteryPower: () => power.battery });
  const held = new Set<number>();
  let nextId = 1;
  const saved: PersistedKeepAwakePreference[] = [];
  const controller = createKeepAwakeController({
    monitor,
    blocker: {
      start: (type) => {
        expect(type).toBe("prevent-app-suspension");
        const id = nextId++;
        held.add(id);
        return id;
      },
      stop: (id) => {
        held.delete(id);
      },
    },
    load: () => ({ version: 1, enabled: false, remoteAccessAllowed: false, ...initial }),
    save: (preference) => saved.push(preference),
  });
  const setBattery = (next: boolean) => {
    power.battery = next;
    monitor.emit(next ? "on-battery" : "on-ac");
  };
  return { controller, held, saved, monitor, setBattery };
}

describe("keep awake controller", () => {
  it("holds the blocker only with the setting on, remote access allowed, and AC power", () => {
    const { controller, held, saved } = harness();
    expect(controller.setEnabled(true)).toEqual({ enabled: true, active: false, onBattery: false });
    expect(held.size).toBe(0);
    expect(controller.setRemoteAccessAllowed(true).active).toBe(true);
    expect(held.size).toBe(1);
    expect(controller.setRemoteAccessAllowed(false).active).toBe(false);
    expect(held.size).toBe(0);
    expect(saved.at(-1)).toEqual({ version: 1, enabled: true, remoteAccessAllowed: false });
  });

  it("follows power source changes and applies the saved preference at launch", () => {
    const { controller, held, setBattery } = harness({ enabled: true, remoteAccessAllowed: true });
    expect(held.size).toBe(1);
    setBattery(true);
    expect(held.size).toBe(0);
    expect(controller.getState()).toEqual({ enabled: true, active: false, onBattery: true });
    setBattery(false);
    expect(held.size).toBe(1);
  });

  it("does not start on battery and releases everything on dispose", () => {
    const { controller, held, monitor, setBattery } = harness(
      { enabled: true, remoteAccessAllowed: true },
      true,
    );
    expect(held.size).toBe(0);
    setBattery(false);
    expect(held.size).toBe(1);
    controller.dispose();
    expect(held.size).toBe(0);
    expect(monitor.listenerCount("on-ac")).toBe(0);
    expect(monitor.listenerCount("on-battery")).toBe(0);
  });

  it("does not rewrite the preference when nothing changed", () => {
    const { controller, saved } = harness({ enabled: true });
    controller.setEnabled(true);
    expect(saved).toEqual([]);
  });
});

describe("keep awake preference file", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) FS.rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips and falls back to off for missing or malformed files", () => {
    const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "keep-awake-"));
    dirs.push(dir);
    const file = Path.join(dir, "nested", "keep-awake.json");
    expect(readKeepAwakePreference(file)).toEqual({
      version: 1,
      enabled: false,
      remoteAccessAllowed: false,
    });
    writeKeepAwakePreference(file, { version: 1, enabled: true, remoteAccessAllowed: true });
    expect(readKeepAwakePreference(file).enabled).toBe(true);
    FS.writeFileSync(file, JSON.stringify({ version: 2, enabled: true }));
    expect(readKeepAwakePreference(file).enabled).toBe(false);
  });
});

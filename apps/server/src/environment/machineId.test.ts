import { describe, expect, it } from "vitest";
import {
  hashMachineId,
  parseIoregPlatformUuid,
  parseWindowsMachineGuid,
  readMachineId,
} from "./machineId";

describe("machineId", () => {
  it("hashes the hardware id, case-insensitively, never echoing it", () => {
    const uuid = "6A1C2F3E-0B9D-4C8A-9F1E-2D3C4B5A6978";
    const id = hashMachineId(uuid);
    expect(id).toMatch(/^[0-9a-f]{32}$/u);
    expect(id).toBe(hashMachineId(uuid.toLowerCase()));
    expect(id).not.toContain(uuid.toLowerCase().slice(0, 8));
    expect(hashMachineId("  ")).toBeUndefined();
  });

  it("reads the platform outputs", () => {
    expect(
      parseIoregPlatformUuid(
        '  "IOPlatformSerialNumber" = "X"\n  "IOPlatformUUID" = "6A1C2F3E-0B9D-4C8A-9F1E-2D3C4B5A6978"\n',
      ),
    ).toBe("6A1C2F3E-0B9D-4C8A-9F1E-2D3C4B5A6978");
    expect(
      parseWindowsMachineGuid(
        "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\n    MachineGuid    REG_SZ    0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0\n",
      ),
    ).toBe("0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0");
    expect(parseIoregPlatformUuid("nothing here")).toBeUndefined();
  });

  it("is stable on this machine", async () => {
    const first = await readMachineId();
    expect(await readMachineId()).toBe(first);
  });
});

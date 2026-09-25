import { COMPUTER_FRAME_MAGIC, DEVICE_FRAME_MAGIC } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  ComputerFrameEncodeError,
  decodeComputerFrame,
  encodeComputerFrame,
} from "./computerFrame";
import { FRAME_HEADER_FIXED_BYTES } from "./frameTransport";
import { decodeDeviceFrame, encodeDeviceFrame } from "./deviceFrame";

const header = {
  computerId: "desktop",
  sequence: 42,
  timestampMs: 1_234.5,
  keyframe: false,
  codecConfig: false,
};

const payload = new Uint8Array([0x00, 0x01, 0x02, 0xff]);

describe("encodeComputerFrame / decodeComputerFrame", () => {
  it("round-trips header fields and payload bytes", () => {
    const result = decodeComputerFrame(encodeComputerFrame({ header, payload }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frame.header).toEqual(header);
    expect(Array.from(result.frame.payload)).toEqual(Array.from(payload));
  });

  it("uses a distinct wire magic from device frames", () => {
    expect(COMPUTER_FRAME_MAGIC).not.toBe(DEVICE_FRAME_MAGIC);
    const computerBytes = encodeComputerFrame({ header, payload });
    const deviceBytes = encodeDeviceFrame({
      header: {
        deviceId: "device",
        sequence: header.sequence,
        timestampMs: header.timestampMs,
        keyframe: header.keyframe,
        codecConfig: header.codecConfig,
      },
      payload,
    });

    expect(decodeDeviceFrame(computerBytes)).toEqual({ ok: false, reason: "bad-magic" });
    expect(decodeComputerFrame(deviceBytes)).toEqual({ ok: false, reason: "bad-magic" });
  });

  it("rejects empty or oversized computer ids", () => {
    expect(() => encodeComputerFrame({ header: { ...header, computerId: "" }, payload })).toThrow(
      ComputerFrameEncodeError,
    );
    expect(() =>
      encodeComputerFrame({ header: { ...header, computerId: "x".repeat(256) }, payload }),
    ).toThrow(ComputerFrameEncodeError);
  });
});

describe("decodeComputerFrame malformed input", () => {
  const encoded = encodeComputerFrame({ header, payload });

  it("rejects zero-length and invalid UTF-8 computer ids", () => {
    const zeroLength = encoded.slice();
    zeroLength[16] = 0;
    expect(decodeComputerFrame(zeroLength)).toEqual({
      ok: false,
      reason: "truncated-computer-id",
    });

    const invalidUtf8 = encoded.slice();
    invalidUtf8[FRAME_HEADER_FIXED_BYTES] = 0xff;
    expect(decodeComputerFrame(invalidUtf8)).toEqual({
      ok: false,
      reason: "invalid-computer-id",
    });
  });
});

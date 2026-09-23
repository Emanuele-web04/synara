import {
  COMPUTER_FRAME_MAGIC,
  COMPUTER_FRAME_VERSION,
  DEVICE_FRAME_MAGIC,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  ComputerFrameEncodeError,
  computerFrameMimeType,
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
    // A frame that names no format is a PNG still, as every frame was before.
    expect(result.frame.header).toEqual({ ...header, mimeType: "image/png" });
    expect(Array.from(result.frame.payload)).toEqual(Array.from(payload));
  });

  it("carries the preview image type per frame", () => {
    const jpeg = decodeComputerFrame(
      encodeComputerFrame({ header: { ...header, mimeType: "image/jpeg" }, payload }),
    );
    const png = decodeComputerFrame(
      encodeComputerFrame({ header: { ...header, mimeType: "image/png" }, payload }),
    );
    expect(jpeg.ok && jpeg.frame.header.mimeType).toBe("image/jpeg");
    expect(png.ok && png.frame.header.mimeType).toBe("image/png");
    expect(jpeg.ok && computerFrameMimeType(jpeg.frame.header)).toBe("image/jpeg");
    expect(computerFrameMimeType(header)).toBe("image/png");
  });

  it("writes a PNG frame byte-identically to the pre-format envelope", () => {
    // Older clients read the flags byte as keyframe/codec-config only; a PNG
    // frame must not set anything they do not know.
    const bytes = encodeComputerFrame({ header: { ...header, mimeType: "image/png" }, payload });
    expect(bytes[3]).toBe(0);
  });

  it("round-trips an empty payload and independent flags", () => {
    const result = decodeComputerFrame(
      encodeComputerFrame({
        header: { ...header, keyframe: true, codecConfig: true },
        payload: new Uint8Array(),
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frame.header.keyframe).toBe(true);
    expect(result.frame.header.codecConfig).toBe(true);
    expect(result.frame.payload.byteLength).toBe(0);
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

  it("rejects buffers shorter than the fixed header", () => {
    expect(decodeComputerFrame(new Uint8Array(FRAME_HEADER_FIXED_BYTES - 1))).toEqual({
      ok: false,
      reason: "too-short",
    });
  });

  it("rejects a wrong magic and unsupported version", () => {
    const wrongMagic = encoded.slice();
    new DataView(wrongMagic.buffer, wrongMagic.byteOffset, wrongMagic.byteLength).setUint16(
      0,
      COMPUTER_FRAME_MAGIC ^ 0xffff,
      true,
    );
    expect(decodeComputerFrame(wrongMagic)).toEqual({ ok: false, reason: "bad-magic" });

    const future = encoded.slice();
    future[2] = COMPUTER_FRAME_VERSION + 1;
    expect(decodeComputerFrame(future)).toEqual({
      ok: false,
      reason: "unsupported-version",
    });
  });

  it("rejects a format code this build cannot display", () => {
    const unknown = encoded.slice();
    unknown[3] = (unknown[3] ?? 0) | 0b0000_1100;
    expect(decodeComputerFrame(unknown)).toEqual({ ok: false, reason: "unsupported-format" });
  });

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

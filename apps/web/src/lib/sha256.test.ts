import { describe, expect, it } from "vitest";

import { bytesToHex, sha256Hex } from "./sha256";

describe("bytesToHex", () => {
  it("pads every byte to two lowercase digits", () => {
    expect(bytesToHex(new Uint8Array([0, 1, 15, 16, 171, 255]))).toBe("00010f10abff");
  });

  it("returns an empty string for no bytes", () => {
    expect(bytesToHex(new Uint8Array([]))).toBe("");
  });
});

describe("sha256Hex", () => {
  it("matches the known digest of the empty string", async () => {
    await expect(sha256Hex("")).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("matches the known digest of an ASCII payload", async () => {
    await expect(sha256Hex("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes UTF-8 bytes rather than UTF-16 code units", async () => {
    await expect(sha256Hex("é")).resolves.toBe(
      "4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c",
    );
    await expect(sha256Hex("日本語 🎉")).resolves.toBe(
      "565f98c5ac0940bbc49b03a3415c5d91936e53e2d01b4d0209eae08658d6f8c9",
    );
  });

  it("distinguishes contents that differ only in a trailing newline", async () => {
    expect(await sha256Hex("line")).not.toBe(await sha256Hex("line\n"));
  });
});

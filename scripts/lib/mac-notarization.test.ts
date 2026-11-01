import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appNotaryStateDirectory,
  notarizeMacPayload,
  payloadDigest,
  recordStapledPayload,
  reusableSubmission,
  runMacCommand,
} from "./mac-notarization.ts";

const id = "12345678-1234-1234-1234-123456789abc";
const credentials = { appleApiKey: "/fake/key", appleApiKeyId: "key-id", appleApiIssuer: "issuer" };
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "notary-test-"));
  roots.push(root);
  const payload = join(root, "payload.dmg");
  writeFileSync(payload, "signed bytes");
  const log = join(root, "calls");
  // Exercise the real subprocess boundary; no Apple credentials or service.
  writeFileSync(
    join(root, "xcrun"),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, args[1]+'\\n');
if (args[0] === 'stapler') {
  const calls = fs.readFileSync(${JSON.stringify(log)}, 'utf8').trim().split('\\n').length;
  if (calls <= Number(process.env.TEST_STAPLER_FAILURES || 0)) {
    console.error(process.env.TEST_STAPLER_ERROR || 'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."');
    process.exit(Number(process.env.TEST_STAPLER_EXIT || 68));
  }
}
if(args[1]==='submit') console.log(JSON.stringify({id:${JSON.stringify(id)}}));
if(args[1]==='info') console.log(JSON.stringify({status:process.env.TEST_NOTARY_STATUS || 'Accepted'}));
if(args[1]==='wait' && process.env.TEST_NOTARY_FAIL_WAIT) process.exit(1);
if(args[1]==='log') fs.writeFileSync(args.at(-1), '{}');
`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${root}:${process.env.PATH}`);
  return { root, payload, log, stateDir: join(root, "state") };
}
describe.skipIf(process.platform === "win32")("Apple submission retention", () => {
  it.each(["staple", "validate"])(
    "recovers a lost ticket connection during %s without resubmitting the payload",
    (action) => {
      const f = fixture();
      vi.stubEnv("TEST_STAPLER_FAILURES", "1");
      const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
      expect(() => runMacCommand("xcrun", ["stapler", action, f.payload], action)).not.toThrow();
      expect(readFileSync(f.log, "utf8").trim().split("\n")).toEqual([action, action]);
      expect(readFileSync(f.payload, "utf8")).toBe("signed bytes");
      expect(wait).toHaveBeenCalledTimes(1);
    },
  );
  it("fails closed after four unsuccessful ticket requests", () => {
    const f = fixture();
    vi.stubEnv("TEST_STAPLER_FAILURES", "100");
    const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    expect(() => runMacCommand("xcrun", ["stapler", "validate", f.payload], "validate")).toThrow(
      "failed with exit code 68",
    );
    expect(readFileSync(f.log, "utf8").trim().split("\n")).toEqual(Array(4).fill("validate"));
    expect(wait).toHaveBeenCalledTimes(3);
  });
  it.each([
    {
      exit: "65",
      error: 'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."',
    },
    { exit: "68", error: "Ticket validation failed: invalid signature." },
  ])("does not retry other ticket failures ($exit, $error)", ({ exit, error }) => {
    const f = fixture();
    vi.stubEnv("TEST_STAPLER_FAILURES", "100");
    vi.stubEnv("TEST_STAPLER_EXIT", exit);
    vi.stubEnv("TEST_STAPLER_ERROR", error);
    const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    expect(() => runMacCommand("xcrun", ["stapler", "validate", f.payload], "validate")).toThrow(
      `failed with exit code ${exit}`,
    );
    expect(readFileSync(f.log, "utf8").trim()).toBe("validate");
    expect(wait).not.toHaveBeenCalled();
  });
  it("keeps retained submission directories out of packaged app discovery", () => {
    const entries = [basename(appNotaryStateDirectory("/stage/Synara.app")), "Synara.app"];
    expect(entries.filter((entry) => entry.endsWith(".app"))).toEqual(["Synara.app"]);
  });
  it("resumes an unchanged submitted payload after wait failure without uploading again", async () => {
    const f = fixture();
    vi.stubEnv("TEST_NOTARY_FAIL_WAIT", "1");
    await expect(notarizeMacPayload(f.payload, credentials, f.stateDir, "test")).rejects.toThrow(
      "wait failed",
    );
    vi.stubEnv("TEST_NOTARY_FAIL_WAIT", "");
    await notarizeMacPayload(f.payload, credentials, f.stateDir, "test");
    expect(readFileSync(f.log, "utf8").trim().split("\n")).toEqual([
      "submit",
      "wait",
      "info",
      "log",
      "wait",
      "info",
      "log",
    ]);
  });
  it("requires authenticated Accepted status and retains diagnostics on rejection", async () => {
    const f = fixture();
    vi.stubEnv("TEST_NOTARY_STATUS", "Invalid");
    await expect(notarizeMacPayload(f.payload, credentials, f.stateDir, "test")).rejects.toThrow(
      "not accepted",
    );
    expect(existsSync(join(f.stateDir, `${id}.log.json`))).toBe(true);
  });
  it("rejects changed payload bytes before any reuse and recognizes a recorded staple", async () => {
    const f = fixture();
    const submission = await notarizeMacPayload(f.payload, credentials, f.stateDir, "test");
    writeFileSync(f.payload, "changed signed bytes");
    await expect(notarizeMacPayload(f.payload, credentials, f.stateDir, "test")).rejects.toThrow(
      "payload changed",
    );
    await recordStapledPayload(f.payload, submission);
    expect(
      reusableSubmission(
        JSON.parse(readFileSync(submission.statePath, "utf8")),
        await payloadDigest(f.payload),
      ),
    ).toBe(true);
  });
  it("refuses missing credentials before submission", async () => {
    const f = fixture();
    await expect(
      notarizeMacPayload(f.payload, { ...credentials, appleApiKey: undefined }, f.stateDir, "test"),
    ).rejects.toThrow("requires --key");
    expect(existsSync(f.log)).toBe(false);
  });
});

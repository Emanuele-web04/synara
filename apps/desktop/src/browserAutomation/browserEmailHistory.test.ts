import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BrowserEmailHistory } from "./browserEmailHistory";

const directories: string[] = [];
const keys = {
  available: async () => true,
  encrypt: (text: string) => Buffer.from(Buffer.from(text).toString("base64")),
  decrypt: (bytes: Buffer) => Buffer.from(bytes.toString(), "base64").toString(),
};
const origin = "https://accounts.example";
const separate = "https://other.example";
async function profile() {
  const dir = await mkdtemp(join(tmpdir(), "synara-email-test-"));
  directories.push(dir);
  return join(dir, "browser-emails.enc");
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("remembers concurrent submissions across tabs and reopens the exact-origin history in recency order", async () => {
  const file = await profile();
  const tabs = new BrowserEmailHistory(file, keys);
  await Promise.all([
    tabs.remember(origin, "amy@example.org"),
    tabs.remember(origin, "alex@example.org"),
    tabs.remember(separate, "another@example.org"),
    tabs.remember(origin, "ben@example.org"),
    tabs.remember(origin, "amy@example.org"),
    tabs.remember(origin, "not an address"),
  ]);
  const reopened = new BrowserEmailHistory(file, keys);
  expect(await reopened.matching(origin, "A")).toEqual(["amy@example.org", "alex@example.org"]);
  expect(await reopened.matching(origin, "")).toEqual([
    "amy@example.org",
    "ben@example.org",
    "alex@example.org",
  ]);
  expect(await reopened.matching("https://accounts.example:8443", "")).toEqual([]);
  expect(await reopened.matching(separate, "")).toEqual(["another@example.org"]);
});

it("keeps learning in memory when the OS key store is unavailable and preserves the sealed profile", async () => {
  const file = await profile();
  await new BrowserEmailHistory(file, keys).remember(origin, "saved@example.org");
  const original = await readFile(file);
  const unavailable = new BrowserEmailHistory(file, { ...keys, available: async () => false });
  await unavailable.remember(origin, "temporary@example.org");
  expect(await unavailable.matching(origin, "")).toEqual(["temporary@example.org"]);
  expect(await readFile(file)).toEqual(original);
  expect(await new BrowserEmailHistory(file, keys).matching(origin, "")).toEqual([
    "saved@example.org",
  ]);
});

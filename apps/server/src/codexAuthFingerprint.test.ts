import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCodexAuthFingerprintAsync } from "./codexProcessEnv";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-async-auth-"));
  roots.push(root);
  const homePath = path.join(root, "home");
  fs.mkdirSync(homePath);
  fs.writeFileSync(path.join(homePath, "config.toml"), 'cli_auth_credentials_store = "file"\n');
  return { root, homePath, env: { CODEX_HOME: homePath, SYNARA_HOME: root } };
}

describe("asynchronous Codex auth freshness", () => {
  it.each(["identity", "content"] as const)(
    "rejects descriptor %s races and closes the descriptor",
    async (race) => {
      const input = fixture();
      const open = fs.promises.open.bind(fs.promises);
      const close = vi.fn();
      vi.spyOn(fs.promises, "open").mockImplementation(async (file, flags, mode) => {
        const handle = await open(file, flags, mode);
        const stat = handle.stat.bind(handle);
        const read = handle.readFile.bind(handle);
        const originalClose = handle.close.bind(handle);
        vi.spyOn(handle, "close").mockImplementation(async () => {
          close();
          await originalClose();
        });
        if (race === "identity") {
          vi.spyOn(handle, "stat").mockImplementation(async () => {
            const actual = await stat({ bigint: true });
            return Object.assign(Object.create(actual), { mode: actual.mode ^ 1n });
          });
        } else {
          vi.spyOn(handle, "readFile").mockImplementation(async () => {
            const content = await read();
            await fs.promises.writeFile(file, "changed while reading");
            return content;
          });
        }
        return handle;
      });
      await expect(readCodexAuthFingerprintAsync(input)).rejects.toThrow(/changed while/);
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it("rejects a logical home retargeted after binding", async () => {
    const input = fixture();
    const logicalHome = path.join(input.root, "logical");
    const other = path.join(input.root, "other");
    fs.mkdirSync(other);
    fs.symlinkSync(input.homePath, logicalHome);
    await expect(
      readCodexAuthFingerprintAsync(
        { ...input, homePath: logicalHome },
        {
          afterSourceHomeBound: () => {
            fs.unlinkSync(logicalHome);
            fs.symlinkSync(other, logicalHome);
          },
        },
      ),
    ).rejects.toThrow(/changed|bound/);
  });
  it("revalidates auth without synchronous filesystem work", async () => {
    const input = fixture();
    const configPath = path.join(input.homePath, "config.toml");
    for (const method of [
      "realpathSync",
      "lstatSync",
      "statSync",
      "openSync",
      "readFileSync",
      "fstatSync",
      "closeSync",
    ] as const) {
      vi.spyOn(fs, method).mockImplementation(() => {
        throw new Error(`blocking ${method}`);
      });
    }
    await expect(readCodexAuthFingerprintAsync(input)).resolves.toBe(
      '{"storeMode":"file","auth":{"state":"missing"}}',
    );
    await fs.promises.writeFile(configPath, 'cli_auth_credentials_store = "keyring"\n');
    await expect(readCodexAuthFingerprintAsync(input)).rejects.toThrow(
      "require file-backed Codex auth",
    );
  });

  it("rejects a replaced home between binding and revalidation", async () => {
    const input = fixture();
    await expect(
      readCodexAuthFingerprintAsync(input, {
        afterSourceHomeBound: () => {
          fs.renameSync(input.homePath, path.join(input.root, "original"));
          fs.mkdirSync(input.homePath);
        },
      }),
    ).rejects.toThrow("changed after its identity was bound");
  });

  it("rejects symlinked auth and private homes", async () => {
    const input = fixture();
    const other = path.join(input.root, "other");
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, "auth.json"), "{}");
    fs.symlinkSync(path.join(other, "auth.json"), path.join(input.homePath, "auth.json"));
    await expect(readCodexAuthFingerprintAsync(input)).rejects.toThrow(
      "must not be a symbolic link",
    );
    const shadowHomePath = path.join(input.root, "shadow");
    fs.symlinkSync(other, shadowHomePath);
    await expect(readCodexAuthFingerprintAsync({ ...input, shadowHomePath })).rejects.toThrow(
      "is a symlink",
    );
  });
});

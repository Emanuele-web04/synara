import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { VaultKeyStore } from "./vaultKeyProtection";
import { isLoginEmail } from "./loginEmail";

interface LoginEmail {
  origin: string;
  email: string;
}

const MAX_ADDRESSES = 200;
const MAX_PER_ORIGIN = 8;

/** One bounded history per desktop profile. Keep working in memory when OS storage is unavailable. */
export class BrowserEmailHistory {
  private entries: LoginEmail[] = [];
  private loaded?: Promise<void>;
  private pending = Promise.resolve();
  private keepOnDisk = true;

  constructor(
    private readonly file: string,
    private readonly keys: VaultKeyStore,
  ) {}

  private async load(): Promise<void> {
    try {
      const bytes = await readFile(this.file);
      if (!(await this.keys.available())) throw new Error("OS storage unavailable");
      const entries: unknown = JSON.parse(this.keys.decrypt(bytes));
      if (!Array.isArray(entries) || entries.length > MAX_ADDRESSES)
        throw new Error("Invalid history");
      this.entries = entries.filter(
        (entry): entry is LoginEmail =>
          entry && typeof entry.origin === "string" && isLoginEmail(entry.email),
      );
    } catch (error) {
      // Preserve a temporarily inaccessible or newer profile file.
      this.keepOnDisk = (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }

  async matching(origin: string, prefix: string): Promise<string[]> {
    await (this.loaded ??= this.load());
    await this.pending;
    const lower = prefix.toLowerCase();
    return this.entries
      .filter((entry) => entry.origin === origin && entry.email.toLowerCase().startsWith(lower))
      .map((entry) => entry.email);
  }

  flush(): Promise<void> {
    return this.pending;
  }

  remember(origin: string, email: unknown): Promise<void> {
    if (!isLoginEmail(email)) return Promise.resolve();
    const write = async () => {
      await (this.loaded ??= this.load());
      let sameOrigin = 1;
      const kept = this.entries.filter((entry) => {
        if (entry.origin !== origin) return true;
        if (entry.email === email || sameOrigin >= MAX_PER_ORIGIN) return false;
        sameOrigin++;
        return true;
      });
      this.entries = [{ origin, email }, ...kept].slice(0, MAX_ADDRESSES);
      if (!this.keepOnDisk || !(await this.keys.available())) return;
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, this.keys.encrypt(JSON.stringify(this.entries)), {
          flag: "wx",
          mode: 0o600,
          flush: true,
        });
        await rename(temporary, this.file);
      } finally {
        await unlink(temporary).catch(() => {});
      }
    };
    const done = this.pending.then(write);
    this.pending = done.catch(() => {});
    return done;
  }
}

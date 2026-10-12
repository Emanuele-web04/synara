import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserInventoryList } from "@synara/contracts";
import { Schema } from "effect";
import {
  CHROMIUM_INVENTORY_SOURCES,
  listChromiumProfileInventory,
} from "./chromiumProfileInventory";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let home: string;
const scan = () => listChromiumProfileInventory(home, [join(home, "Applications")]);

function dataRoot(data: string) {
  return join(home, "Library", "Application Support", data);
}

async function installLinuxProfile(rootPath: string) {
  const root = join(home, rootPath);
  const profile = join(root, "Default");
  await makeCookies(join(profile, "Network", "Cookies"), 3);
  const logins = new DatabaseSync(join(profile, "Login Data"));
  logins.exec(
    "CREATE TABLE logins (blacklisted_by_user INTEGER, password_value BLOB); INSERT INTO logins VALUES (0, X'01'), (1, X'02'), (0, X'')",
  );
  logins.close();
  await writeFile(
    join(root, "Local State"),
    JSON.stringify({
      profile: { info_cache: { Default: { name: "Work" } }, last_used: "Default" },
    }),
  );
}

async function install(source: (typeof CHROMIUM_INVENTORY_SOURCES)[number]) {
  await mkdir(join(home, "Applications", source.app), { recursive: true });
  const root = dataRoot(source.data);
  const profile = source.id === "opera" || source.id === "opera-gx" ? root : join(root, "Default");
  const cookiePath = join(profile, "Network", "Cookies");
  const loginPath = join(profile, "Login Data");
  await mkdir(join(cookiePath, ".."), { recursive: true });
  const cookies = new DatabaseSync(cookiePath);
  cookies.exec("CREATE TABLE cookies (name TEXT); INSERT INTO cookies VALUES ('one'), ('two')");
  cookies.close();
  const logins = new DatabaseSync(loginPath);
  logins.exec(
    "CREATE TABLE logins (blacklisted_by_user INTEGER, password_value BLOB); INSERT INTO logins VALUES (0, X'01'), (0, X'02'), (1, X'03'), (0, X'')",
  );
  logins.close();
  await writeFile(
    join(root, "Local State"),
    JSON.stringify({
      profile: { info_cache: { Default: { name: "Work" } }, last_used: "Default" },
    }),
  );
  return { profile, cookiePath, loginPath };
}

async function makeCookies(path: string, count: number) {
  await mkdir(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec("CREATE TABLE cookies (name TEXT)");
  const insert = database.prepare("INSERT INTO cookies VALUES (?)");
  for (let index = 0; index < count; index++) insert.run(`cookie-${index}`);
  database.close();
}

beforeEach(async () => {
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  home = await mkdtemp(join(tmpdir(), "synara-chromium-inventory-"));
});

afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  await rm(home, { recursive: true, force: true });
});

describe("macOS Chromium profile inventory", () => {
  it("discovers only installed catalog candidates with profile stores and counts without decrypting", async () => {
    for (const source of CHROMIUM_INVENTORY_SOURCES) await install(source);
    const inventory = await scan();
    expect(Schema.decodeUnknownSync(BrowserInventoryList)(inventory)).toEqual(inventory);
    expect(inventory.map(({ id }) => id)).toEqual([
      "chrome",
      "chrome-beta",
      "chrome-dev",
      "chrome-canary",
      "edge",
      "brave",
      "arc",
      "dia",
      "vivaldi",
      "opera",
      "opera-gx",
      "chromium",
      "helium",
      "comet",
      "aside",
    ]);
    expect(inventory).toContainEqual({
      id: "chrome-beta",
      name: "Google Chrome Beta",
      profileStatus: "available",
      profiles: [
        {
          id: "Default",
          name: "Work",
          isDefault: true,
          cookieCount: 2,
          passwordCount: 2,
          cookieStatus: "available",
          passwordStatus: "available",
        },
      ],
    });
    expect(inventory.map(({ profiles }) => profiles[0]?.cookieCount)).toEqual(
      CHROMIUM_INVENTORY_SOURCES.map(() => 2),
    );
    expect(inventory.find(({ id }) => id === "opera")?.profiles[0]).toMatchObject({
      id: "Opera",
      name: "Opera",
      isDefault: true,
      cookieCount: 2,
      passwordCount: 2,
    });
    expect(inventory.find(({ id }) => id === "opera-gx")?.profiles[0]).toMatchObject({
      id: "Opera GX",
      name: "Opera GX",
      isDefault: true,
      cookieCount: 2,
      passwordCount: 2,
    });
  });

  it("distinguishes installed browsers with no profiles from discovery failures", async () => {
    const noProfile = CHROMIUM_INVENTORY_SOURCES[0];
    await mkdir(join(home, "Applications", noProfile.app), { recursive: true });

    const brokenRoot = CHROMIUM_INVENTORY_SOURCES[1];
    await mkdir(join(home, "Applications", brokenRoot.app), { recursive: true });
    await mkdir(dirname(dataRoot(brokenRoot.data)), { recursive: true });
    await writeFile(dataRoot(brokenRoot.data), "not a profile directory");

    const inventory = await scan();
    expect(inventory).toEqual([
      {
        id: "chrome",
        name: "Google Chrome",
        profileStatus: "no_profiles",
        profiles: [],
      },
      {
        id: "chrome-beta",
        name: "Google Chrome Beta",
        profileStatus: "unavailable",
        profiles: [],
      },
    ]);
  });

  it("reports unavailable counts for malformed stores and excludes uninstalled browser data", async () => {
    const source = CHROMIUM_INVENTORY_SOURCES[0];
    const { loginPath } = await install(source);
    await rm(loginPath);
    await writeFile(loginPath, "not a sqlite database");
    const uninstalled = CHROMIUM_INVENTORY_SOURCES[1];
    const root = dataRoot(uninstalled.data);
    const folder = join(root, "Default");
    await mkdir(folder, { recursive: true });
    const cookies = new DatabaseSync(join(folder, "Cookies"));
    cookies.exec("CREATE TABLE cookies (name TEXT)");
    cookies.close();
    const inventory = await scan();
    expect(inventory.map(({ id }) => id)).toEqual(["chrome"]);
    expect(inventory[0]?.profiles[0]).toMatchObject({
      cookieCount: 2,
      cookieStatus: "available",
      passwordCount: null,
      passwordStatus: "unavailable",
    });
  });

  it("prefers Opera's current nested Default profile over a stale root store", async () => {
    const source = CHROMIUM_INVENTORY_SOURCES.find(({ id }) => id === "opera")!;
    await mkdir(join(home, "Applications", source.app), { recursive: true });
    const root = dataRoot(source.data);
    await makeCookies(join(root, "Cookies"), 1);
    const defaultProfile = join(root, "Default");
    await makeCookies(join(defaultProfile, "Network", "Cookies"), 3);
    const loginPath = join(defaultProfile, "Login Data");
    const logins = new DatabaseSync(loginPath);
    logins.exec(
      "CREATE TABLE logins (blacklisted_by_user INTEGER, password_value BLOB); INSERT INTO logins VALUES (0, X'01')",
    );
    logins.close();
    await writeFile(
      join(root, "Local State"),
      JSON.stringify({
        profile: { info_cache: { Default: { name: "Main" } }, last_used: "Default" },
      }),
    );

    const opera = (await scan()).find(({ id }) => id === "opera");
    expect(opera).toMatchObject({
      profileStatus: "available",
      profiles: [
        {
          id: "Default",
          name: "Main",
          isDefault: true,
          cookieCount: 3,
          passwordCount: 1,
        },
      ],
    });
  });

  it("keeps Opera's legacy root profile as a fallback when nested profiles are absent", async () => {
    const source = CHROMIUM_INVENTORY_SOURCES.find(({ id }) => id === "opera")!;
    await install(source);
    expect((await scan()).find(({ id }) => id === "opera")?.profiles[0]).toMatchObject({
      id: "Opera",
      cookieCount: 2,
      passwordCount: 2,
    });
  });

  it("isolates an inaccessible Network store and preserves healthy browser and password counts", async () => {
    const chrome = await install(CHROMIUM_INVENTORY_SOURCES[0]);
    const rootCookies = join(chrome.profile, "Cookies");
    await makeCookies(rootCookies, 1);
    await chmod(join(chrome.profile, "Network"), 0);
    await install(CHROMIUM_INVENTORY_SOURCES.find(({ id }) => id === "aside")!);
    try {
      const inventory = await scan();
      expect(inventory.find(({ id }) => id === "chrome")?.profiles[0]).toMatchObject({
        cookieCount: null,
        cookieStatus: "unavailable",
        passwordCount: 2,
        passwordStatus: "available",
      });
      expect(inventory.find(({ id }) => id === "aside")?.profiles[0]).toMatchObject({
        cookieCount: 2,
        passwordCount: 2,
      });
    } finally {
      await chmod(join(chrome.profile, "Network"), 0o700);
    }
  });

  it("keeps a readable sibling profile when another profile directory is inaccessible", async () => {
    const chrome = await install(CHROMIUM_INVENTORY_SOURCES[0]);
    const blocked = join(dataRoot("Google/Chrome"), "Profile 1");
    await mkdir(blocked, { recursive: true });
    await chmod(blocked, 0);
    try {
      const chromeInventory = (await scan()).find(({ id }) => id === "chrome");
      expect(chromeInventory?.profileStatus).toBe("unavailable");
      expect(chromeInventory?.profiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "Default", cookieCount: 2, passwordCount: 2 }),
          expect.objectContaining({
            id: "Profile 1",
            cookieCount: null,
            cookieStatus: "unavailable",
            passwordCount: null,
            passwordStatus: "unavailable",
          }),
        ]),
      );
    } finally {
      await chmod(blocked, 0o700);
    }
    expect(chrome.profile).toContain("Default");
  });

  it("reports an inaccessible app lookup without erasing an accessible sibling browser", async () => {
    const deniedApps = join(home, "Denied Applications");
    await mkdir(deniedApps, { recursive: true });
    await chmod(deniedApps, 0);
    const aside = CHROMIUM_INVENTORY_SOURCES.find(({ id }) => id === "aside")!;
    await install(aside);
    try {
      const inventory = await listChromiumProfileInventory(home, [
        deniedApps,
        join(home, "Applications"),
      ]);
      expect(inventory.find(({ id }) => id === "chrome")).toMatchObject({
        profileStatus: "unavailable",
        profiles: [],
      });
      expect(inventory.find(({ id }) => id === "aside")?.profiles[0]).toMatchObject({
        cookieCount: 2,
        passwordCount: 2,
      });
    } finally {
      await chmod(deniedApps, 0o700);
    }
  });

  it("reports a busy database as locked without losing other profile counts", async () => {
    const source = CHROMIUM_INVENTORY_SOURCES[0];
    const { cookiePath } = await install(source);
    const lock = new DatabaseSync(cookiePath);
    lock.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
    try {
      const inventory = await scan();
      expect(inventory[0]?.profiles[0]).toMatchObject({
        cookieCount: null,
        cookieStatus: "locked",
        passwordCount: 2,
        passwordStatus: "available",
      });
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
    }
  });

  it.each(["linux", "win32"])("does not inventory macOS candidates on %s", async (value) => {
    await install(CHROMIUM_INVENTORY_SOURCES[0]);
    Object.defineProperty(process, "platform", { ...platform, value });
    expect(await scan()).toEqual([]);
  });
});

describe("Linux Chromium profile inventory", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  });

  it.each([
    ["Chrome", ".config/google-chrome", "chrome"],
    ["Edge", ".var/app/com.microsoft.Edge/config/microsoft-edge", "edge"],
    ["Brave", "snap/brave/current/.config/BraveSoftware/Brave-Browser", "brave"],
    ["Chromium", "snap/chromium/current/.config/chromium", "chromium"],
    ["Opera", ".config/opera", "opera"],
    ["Vivaldi", ".config/vivaldi", "vivaldi"],
  ])("counts %s cookie and password rows without decrypting", async (_name, root, id) => {
    await installLinuxProfile(root);

    const inventory = await scan();
    expect(Schema.decodeUnknownSync(BrowserInventoryList)(inventory)).toEqual(inventory);
    expect(inventory.map(({ id: browser }) => browser)).toEqual([id]);
    expect(inventory[0]?.profiles).toEqual([
      {
        id: "Default",
        name: "Work",
        isDefault: true,
        cookieCount: 3,
        passwordCount: 1,
        cookieStatus: "available",
        passwordStatus: "available",
      },
    ]);
  });

  it("prefers a Flatpak profile root when it is the installed Chrome data store", async () => {
    await installLinuxProfile(".var/app/com.google.Chrome/config/google-chrome");
    expect(await scan()).toMatchObject([
      {
        id: "chrome",
        profileStatus: "available",
        profiles: [{ cookieCount: 3, passwordCount: 1 }],
      },
    ]);
  });

  it("discovers a Snap common profile root", async () => {
    await installLinuxProfile("snap/chromium/common/.config/chromium");
    expect(await scan()).toMatchObject([
      {
        id: "chromium",
        profileStatus: "available",
        profiles: [{ cookieCount: 3, passwordCount: 1 }],
      },
    ]);
  });
});

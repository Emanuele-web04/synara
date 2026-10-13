import { constants } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { lstat, open, opendir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const MAX_CHROMIUM_DATABASE_BYTES = 512 * 1024 * 1024;
const MAX_SOURCE_ENTRIES = 256;

export const CHROMIUM_INVENTORY_SOURCES = [
  { id: "chrome", name: "Google Chrome", data: "Google/Chrome", app: "Google Chrome.app" },
  {
    id: "chrome-beta",
    name: "Google Chrome Beta",
    data: "Google/Chrome Beta",
    app: "Google Chrome Beta.app",
  },
  {
    id: "chrome-dev",
    name: "Google Chrome Dev",
    data: "Google/Chrome Dev",
    app: "Google Chrome Dev.app",
  },
  {
    id: "chrome-canary",
    name: "Google Chrome Canary",
    data: "Google/Chrome Canary",
    app: "Google Chrome Canary.app",
  },
  { id: "edge", name: "Microsoft Edge", data: "Microsoft Edge", app: "Microsoft Edge.app" },
  {
    id: "brave",
    name: "Brave",
    data: "BraveSoftware/Brave-Browser",
    app: "Brave Browser.app",
  },
  { id: "arc", name: "Arc", data: "Arc/User Data", app: "Arc.app" },
  { id: "dia", name: "Dia", data: "Dia/User Data", app: "Dia.app" },
  { id: "vivaldi", name: "Vivaldi", data: "Vivaldi", app: "Vivaldi.app" },
  { id: "opera", name: "Opera", data: "com.operasoftware.Opera", app: "Opera.app" },
  {
    id: "opera-gx",
    name: "Opera GX",
    data: "com.operasoftware.OperaGX",
    app: "Opera GX.app",
  },
  { id: "chromium", name: "Chromium", data: "Chromium", app: "Chromium.app" },
  { id: "helium", name: "Helium", data: "net.imput.helium", app: "Helium.app" },
  { id: "comet", name: "Comet", data: "Comet", app: "Comet.app" },
  { id: "aside", name: "Aside", data: "Aside", app: "Aside.app" },
] as const;

export type ChromiumInventorySourceId = (typeof CHROMIUM_INVENTORY_SOURCES)[number]["id"];
export type ChromiumProfileInventory = {
  id: string;
  name: string;
  isDefault: boolean;
  cookieCount: number | null;
  passwordCount: number | null;
  cookieStatus: "available" | "unavailable" | "locked";
  passwordStatus: "available" | "unavailable" | "locked";
};
export type ChromiumBrowserInventory = {
  id: ChromiumInventorySourceId;
  name: string;
  profileStatus: "available" | "no_profiles" | "unavailable";
  profiles: ChromiumProfileInventory[];
};

const appSupport = (home: string) => join(home, "Library", "Application Support");
const browserDataPath = (home: string, data: string) => join(appSupport(home), data);
const linuxDataPaths: Partial<Record<ChromiumInventorySourceId, string[]>> = {
  chrome: [".config/google-chrome", ".var/app/com.google.Chrome/config/google-chrome"],
  "chrome-beta": [".config/google-chrome-beta"],
  "chrome-dev": [".config/google-chrome-unstable"],
  edge: [".config/microsoft-edge", ".var/app/com.microsoft.Edge/config/microsoft-edge"],
  brave: [
    ".config/BraveSoftware/Brave-Browser",
    ".var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser",
    "snap/brave/common/.config/BraveSoftware/Brave-Browser",
    "snap/brave/current/.config/BraveSoftware/Brave-Browser",
  ],
  vivaldi: [".config/vivaldi"],
  opera: [".config/opera", "snap/opera/common/.config/opera", "snap/opera/current/.config/opera"],
  "opera-gx": [".config/opera-gx"],
  chromium: [
    ".config/chromium",
    ".var/app/org.chromium.Chromium/config/chromium",
    "snap/chromium/common/.config/chromium",
    "snap/chromium/current/.config/chromium",
  ],
};

export async function resolveChromiumProfileFolder(
  home: string,
  browser: ChromiumInventorySourceId,
  profileId: string,
): Promise<string | null> {
  const source = CHROMIUM_INVENTORY_SOURCES.find(({ id }) => id === browser);
  if (!source) return null;
  const root = browserDataPath(home, source.data);
  if (!(await isRealDirectory(root))) return null;
  const singleProfile =
    (source.id === "opera" || source.id === "opera-gx") && profileId === source.name;
  if (
    !singleProfile &&
    (!profileId ||
      profileId === "." ||
      profileId === ".." ||
      /[\\/\0]/.test(profileId) ||
      profileId === "Guest Profile" ||
      profileId === "System Profile")
  )
    return null;
  const folder = singleProfile ? root : join(root, profileId);
  return (await isRealDirectory(folder)) ? folder : null;
}

async function isRealFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function installed(
  source: (typeof CHROMIUM_INVENTORY_SOURCES)[number],
  applicationRoots: string[],
): Promise<boolean | null> {
  let inaccessible = false;
  for (const appRoot of applicationRoots) {
    try {
      if ((await lstat(join(appRoot, source.app))).isDirectory()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") inaccessible = true;
    }
  }
  return inaccessible ? null : false;
}

async function profileFolders(
  source: (typeof CHROMIUM_INVENTORY_SOURCES)[number],
  home: string,
  root = browserDataPath(home, source.data),
): Promise<{ folders: string[]; status: "available" | "no_profiles" | "unavailable" }> {
  let rootIsDirectory: boolean;
  try {
    rootIsDirectory = (await lstat(root)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { folders: [], status: "no_profiles" };
    return { folders: [], status: "unavailable" };
  }
  if (!rootIsDirectory) return { folders: [], status: "unavailable" };
  if (source.id === "opera-gx") {
    try {
      return (await hasProfileStore(root))
        ? { folders: [root], status: "available" }
        : { folders: [], status: "no_profiles" };
    } catch {
      return { folders: [root], status: "unavailable" };
    }
  }

  const folders: string[] = [];
  const entries = [];
  try {
    for await (const entry of await opendir(root)) {
      if (entries.length === MAX_SOURCE_ENTRIES) return { folders: [], status: "unavailable" };
      entries.push(entry);
    }
  } catch {
    return { folders: [], status: "unavailable" };
  }
  let inaccessible = false;
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      entry.name !== "Guest Profile" &&
      entry.name !== "System Profile" &&
      !(source.id === "opera" && entry.name === "Network")
    ) {
      const folder = join(root, entry.name);
      try {
        if (await hasProfileStore(folder)) folders.push(folder);
      } catch {
        folders.push(folder);
        inaccessible = true;
      }
    }
  }
  if (source.id === "opera" && folders.length === 0 && !inaccessible) {
    try {
      if (await hasProfileStore(root)) folders.push(root);
    } catch {
      folders.push(root);
      inaccessible = true;
    }
  }
  const sorted = folders.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return {
    folders: sorted,
    status: inaccessible ? "unavailable" : sorted.length > 0 ? "available" : "no_profiles",
  };
}

async function resolveLinuxDataRoot(
  home: string,
  browser: ChromiumInventorySourceId,
): Promise<string | null> {
  for (const candidate of linuxDataPaths[browser] ?? []) {
    const root = join(home, candidate);
    if (await isRealDirectory(root)) return root;
  }
  return null;
}

async function hasProfileStore(folder: string) {
  return (
    (await isRealFile(join(folder, "Cookies"))) ||
    (await isRealFile(join(folder, "Network", "Cookies"))) ||
    (await isRealFile(join(folder, "Login Data")))
  );
}

export async function isBoundedChromiumDatabase(
  path: string,
  limit = MAX_CHROMIUM_DATABASE_BYTES,
): Promise<boolean> {
  for (const file of [path, `${path}-wal`, `${path}-journal`]) {
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.size > limit) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || file === path) return false;
    }
  }
  return true;
}

async function isOversizedChromiumDatabase(path: string): Promise<boolean> {
  for (const file of [path, `${path}-wal`, `${path}-journal`]) {
    try {
      const stat = await lstat(file);
      if (stat.isFile() && stat.size > MAX_CHROMIUM_DATABASE_BYTES) return true;
    } catch {
      // Other source failures are reported as unavailable without being mislabeled as a size limit.
    }
  }
  return false;
}

async function countRows(
  path: string,
  table: "cookies" | "logins",
  query: string,
): Promise<{
  count: number | null;
  status: "available" | "unavailable" | "locked";
  code?: "source_too_large";
}> {
  let database: DatabaseSync | undefined;
  try {
    if (!(await isBoundedChromiumDatabase(path)))
      return {
        count: null,
        status: "unavailable",
        ...((await isOversizedChromiumDatabase(path)) ? { code: "source_too_large" as const } : {}),
      };
    database = new DatabaseSync(path, { readOnly: true, timeout: 100 });
    database.exec("BEGIN");
    if (
      database.prepare("SELECT type FROM sqlite_schema WHERE name = ?").get(table)?.type !== "table"
    )
      return { count: null, status: "unavailable" };
    const pages = database.prepare("PRAGMA page_count").get() as { page_count: number };
    const size = database.prepare("PRAGMA page_size").get() as { page_size: number };
    if (pages.page_count * size.page_size > MAX_CHROMIUM_DATABASE_BYTES)
      return { count: null, status: "unavailable", code: "source_too_large" };
    const row = database.prepare(query).get() as { count?: number | bigint } | undefined;
    if (row?.count === undefined) return { count: null, status: "unavailable" };
    const value = Number(row.count);
    return Number.isSafeInteger(value) && value >= 0 && value <= 100_000
      ? { count: value, status: "available" }
      : { count: null, status: "unavailable" };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    const code = failure.code;
    return {
      count: null,
      status:
        code === "SQLITE_BUSY" ||
        code === "SQLITE_LOCKED" ||
        /database is locked/i.test(failure.message)
          ? "locked"
          : "unavailable",
    };
  } finally {
    database?.close();
  }
}

function storePath(folder: string, ...parts: string[]) {
  return join(folder, ...parts);
}

export async function inventoryChromiumPasswordProfile(
  home: string,
  browser: ChromiumInventorySourceId,
  profile: string,
) {
  const folder = await resolveChromiumProfileFolder(home, browser, profile);
  if (!folder || !(await isRealFile(join(folder, "Login Data")))) return undefined;
  return countRows(
    join(folder, "Login Data"),
    "logins",
    "SELECT COUNT(*) AS count FROM (SELECT 1 FROM logins WHERE blacklisted_by_user = 0 AND octet_length(password_value) > 0 LIMIT 50001)",
  );
}

async function cookieStore(
  folder: string,
  browser: ChromiumInventorySourceId,
): Promise<string | undefined> {
  const root = storePath(folder, "Cookies");
  if (["helium", "aside", "dia"].includes(browser) && (await isRealFile(root))) return root;
  const network = storePath(folder, "Network", "Cookies");
  if ((await isRealDirectory(storePath(folder, "Network"))) && (await isRealFile(network)))
    return network;
  return (await isRealFile(root)) ? root : undefined;
}

async function readLocalState(
  root: string,
): Promise<{ names: Record<string, string>; last: string[] }> {
  try {
    const limit = 8 * 1024 * 1024;
    const file = await open(
      join(root, "Local State"),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    let contents: string;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > limit) return { names: {}, last: [] };
      const buffer = Buffer.alloc(limit + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > limit) return { names: {}, last: [] };
      contents = buffer.toString("utf8", 0, bytesRead);
    } finally {
      await file.close();
    }
    const state: unknown = JSON.parse(contents);
    const record = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    if (!record(state) || !record(state.profile)) return { names: {}, last: [] };
    const profile = state.profile;
    const names: Record<string, string> = {};
    const cache = profile.info_cache;
    if (record(cache)) {
      let entries = 0;
      for (const id in cache) {
        if (++entries > MAX_SOURCE_ENTRIES) break;
        const info = cache[id];
        if (
          id.length <= 256 &&
          id !== "__proto__" &&
          record(info) &&
          typeof info.name === "string" &&
          info.name.length > 0 &&
          info.name.length <= 256
        )
          names[id] = info.name;
      }
    }
    const active = Array.isArray(profile.last_active_profiles)
      ? profile.last_active_profiles.slice(0, MAX_SOURCE_ENTRIES)
      : [];
    return {
      names,
      last: [profile.last_used, ...active].filter(
        (value): value is string => typeof value === "string" && value.length <= 256,
      ),
    };
  } catch {
    return { names: {}, last: [] };
  }
}

/** Discovers profile/store metadata; database queries require an explicit import. */
export async function listChromiumProfileInventory(
  home = homedir(),
  applicationRoots = ["/Applications", join(home, "Applications")],
): Promise<ChromiumBrowserInventory[]> {
  if (process.platform !== "darwin" && process.platform !== "linux") return [];
  const inventory: ChromiumBrowserInventory[] = [];
  for (const source of CHROMIUM_INVENTORY_SOURCES) {
    const root =
      process.platform === "linux"
        ? await resolveLinuxDataRoot(home, source.id)
        : browserDataPath(home, source.data);
    if (!root) continue;
    const appInstalled =
      process.platform === "linux" ? true : await installed(source, applicationRoots);
    if (appInstalled === false) continue;
    if (appInstalled === null) {
      inventory.push({
        id: source.id,
        name: source.name,
        profileStatus: "unavailable",
        profiles: [],
      });
      continue;
    }
    const discovery = await profileFolders(source, home, root);
    const localState = await readLocalState(root);
    const profiles = discovery.folders.map((folder) => {
      const id = folder === root ? source.name : folder.slice(root.length + 1);
      return (async () => {
        let cookies: string | undefined;
        try {
          cookies = await cookieStore(folder, source.id);
        } catch {
          cookies = undefined;
        }
        const loginStore = storePath(folder, "Login Data");
        const cookieAvailable =
          cookies !== undefined &&
          (await isBoundedChromiumDatabase(
            cookies,
            ["helium", "aside", "dia"].includes(source.id)
              ? 64 * 1024 * 1024
              : MAX_CHROMIUM_DATABASE_BYTES,
          ));
        const passwordAvailable = await isBoundedChromiumDatabase(loginStore);
        return {
          id,
          name: Object.hasOwn(localState.names, id)
            ? localState.names[id]!
            : id === source.name
              ? source.name
              : id,
          isDefault:
            id === source.name ||
            localState.last[0] === id ||
            (localState.last.length === 0 && id === "Default"),
          cookieCount: null,
          passwordCount: null,
          cookieStatus: cookieAvailable ? ("available" as const) : ("unavailable" as const),
          passwordStatus: passwordAvailable ? ("available" as const) : ("unavailable" as const),
        };
      })();
    });
    inventory.push({
      id: source.id,
      name: source.name,
      profileStatus: discovery.status,
      profiles: await Promise.all(profiles),
    });
  }
  return inventory;
}

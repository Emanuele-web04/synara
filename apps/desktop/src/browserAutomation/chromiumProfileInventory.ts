import { DatabaseSync } from "node:sqlite";
import { lstat, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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
): Promise<{ folders: string[]; status: "available" | "no_profiles" | "unavailable" }> {
  const root = browserDataPath(home, source.data);
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
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
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

async function hasProfileStore(folder: string) {
  return (
    (await isRealFile(join(folder, "Cookies"))) ||
    (await isRealFile(join(folder, "Network", "Cookies"))) ||
    (await isRealFile(join(folder, "Login Data")))
  );
}

function countRows(
  path: string,
  query: string,
): { count: number | null; status: "available" | "unavailable" | "locked" } {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true, timeout: 100 });
    const row = database.prepare(query).get() as { count?: number | bigint } | undefined;
    if (row?.count === undefined) return { count: null, status: "unavailable" };
    const value = Number(row.count);
    return Number.isSafeInteger(value) && value >= 0
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

async function cookieStore(folder: string): Promise<string | undefined> {
  const network = storePath(folder, "Network", "Cookies");
  if ((await isRealDirectory(storePath(folder, "Network"))) && (await isRealFile(network)))
    return network;
  const root = storePath(folder, "Cookies");
  return (await isRealFile(root)) ? root : undefined;
}

async function readLocalState(
  root: string,
): Promise<{ names: Record<string, string>; last: string[] }> {
  try {
    const state = JSON.parse(await readFile(join(root, "Local State"), "utf8")) as {
      profile?: {
        info_cache?: Record<string, { name?: unknown }>;
        last_used?: unknown;
        last_active_profiles?: unknown;
      };
    };
    const profile = state.profile;
    const names: Record<string, string> = {};
    for (const [id, info] of Object.entries(profile?.info_cache ?? {})) {
      if (typeof info.name === "string" && info.name.length > 0) names[id] = info.name;
    }
    return {
      names,
      last: [
        profile?.last_used,
        ...(Array.isArray(profile?.last_active_profiles) ? profile.last_active_profiles : []),
      ].filter((value): value is string => typeof value === "string"),
    };
  } catch {
    return { names: {}, last: [] };
  }
}

/** Counts local Chromium stores without reading or decrypting any secret. */
export async function listChromiumProfileInventory(
  home = homedir(),
  applicationRoots = ["/Applications", join(home, "Applications")],
): Promise<ChromiumBrowserInventory[]> {
  if (process.platform !== "darwin") return [];
  const inventory: ChromiumBrowserInventory[] = [];
  for (const source of CHROMIUM_INVENTORY_SOURCES) {
    const appInstalled = await installed(source, applicationRoots);
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
    const root = browserDataPath(home, source.data);
    const discovery = await profileFolders(source, home);
    const localState = await readLocalState(root);
    const profiles = discovery.folders.map((folder) => {
      const id = folder === root ? source.name : folder.slice(root.length + 1);
      return (async () => {
        let cookie: {
          count: number | null;
          status: ChromiumProfileInventory["cookieStatus"];
        };
        try {
          const cookies = await cookieStore(folder);
          cookie = cookies
            ? countRows(cookies, "SELECT COUNT(*) AS count FROM cookies")
            : { count: null, status: "unavailable" };
        } catch {
          cookie = { count: null, status: "unavailable" };
        }
        let password: { count: number | null; status: ChromiumProfileInventory["passwordStatus"] };
        try {
          const loginStore = storePath(folder, "Login Data");
          password = (await isRealFile(loginStore))
            ? countRows(
                loginStore,
                "SELECT COUNT(*) AS count FROM logins WHERE blacklisted_by_user = 0 AND length(password_value) > 0",
              )
            : { count: null, status: "unavailable" };
        } catch {
          password = { count: null, status: "unavailable" };
        }
        return {
          id,
          name: localState.names[id] ?? (id === source.name ? source.name : id),
          isDefault:
            id === source.name ||
            localState.last[0] === id ||
            (localState.last.length === 0 && id === "Default"),
          cookieCount: cookie.count,
          passwordCount: password.count,
          cookieStatus: cookie.status,
          passwordStatus: password.status,
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

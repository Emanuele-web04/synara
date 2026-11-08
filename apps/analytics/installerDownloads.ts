// FILE: installerDownloads.ts
// Purpose: Captures bounded public GitHub installer counters and serves aggregate history.
// Depends on: the shared marketing artifact parser and migration 0011; never fetches binaries.

import {
  installerDownloadCount,
  installerPlatform,
  type InstallerPlatform,
} from "@synara/shared/installerDownloads";

const RELEASES_URL = "https://api.github.com/repos/Emanuele-web04/synara/releases";
const CHANNELS = ["stable", "beta", "remote", "other"] as const;
const PLATFORMS = ["darwin", "win32", "linux"] as const;
const MAX_PAGES = 10;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_ASSETS = 10_000;
const RETENTION_MS = 90 * 86_400_000;
type Channel = (typeof CHANNELS)[number];
interface AssetHead {
  id: number;
  channel: Channel;
  platform: InstallerPlatform;
  downloads: number;
}
interface SourceAsset extends AssetHead {
  createdAt: string;
}
interface ScopeCount {
  channel: Channel;
  platform: InstallerPlatform;
  total: number;
  downloads: number | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Unknown historical tags stay in a finite bucket and never become arbitrary dimensions.
function channelFor(tag: unknown): Channel {
  if (typeof tag !== "string" || tag.length > 128) throw new Error("Invalid release tag");
  if (/^v?\d+\.\d+\.\d+$/.test(tag)) return "stable";
  if (/^v?\d+\.\d+\.\d+-beta\.\d+$/.test(tag)) return "beta";
  if (/^v?\d+\.\d+\.\d+-remote\.\d+$/.test(tag)) return "remote";
  return "other";
}

// Bound decoded response bytes across the whole traversal, including chunked responses.
async function readPage(response: Response, remaining: number): Promise<Uint8Array> {
  if (!response.body || Number(response.headers.get("content-length")) > remaining) {
    await response.body?.cancel();
    throw new Error("GitHub response exceeds snapshot bounds");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > remaining) throw new Error("GitHub response exceeds snapshot bounds");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

// A partial traversal cannot replace a previous source observation, even with valid pages.
async function fetchAssets(): Promise<SourceAsset[]> {
  const signal = AbortSignal.timeout(20_000);
  const assets: SourceAsset[] = [];
  const ids = new Set<number>();
  let bytes = 0;
  let total = 0;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await fetch(`${RELEASES_URL}?per_page=100&page=${page}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "Synara-public-installer-counts",
      },
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("GitHub snapshot request failed");
    }
    const body = await readPage(response, MAX_BODY_BYTES - bytes);
    bytes += body.byteLength;
    const releases: unknown = JSON.parse(new TextDecoder().decode(body));
    if (!Array.isArray(releases) || releases.length > 100) {
      throw new Error("Invalid GitHub release page");
    }
    for (const release of releases) {
      if (!record(release) || release.draft !== false || !Array.isArray(release.assets)) {
        throw new Error("Invalid public GitHub release");
      }
      const channel = channelFor(release.tag_name);
      for (const asset of release.assets) {
        if (!record(asset) || typeof asset.name !== "string" || asset.name.length > 512) {
          throw new Error("Invalid GitHub asset");
        }
        const platform = installerPlatform(asset.name);
        if (!platform) continue;
        const downloads = installerDownloadCount(asset.download_count);
        if (
          typeof asset.id !== "number" ||
          !Number.isSafeInteger(asset.id) ||
          asset.id <= 0 ||
          ids.has(asset.id) ||
          downloads === null ||
          typeof asset.created_at !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(asset.created_at) ||
          !Number.isFinite(Date.parse(asset.created_at)) ||
          new Date(asset.created_at).toISOString().slice(0, 19) !== asset.created_at.slice(0, 19) ||
          Date.parse(asset.created_at) > Date.now()
        ) {
          throw new Error("Invalid GitHub installer counter");
        }
        ids.add(asset.id);
        total += downloads;
        if (ids.size > MAX_ASSETS || !Number.isSafeInteger(total)) {
          throw new Error("GitHub snapshot exceeds asset/count bounds");
        }
        assets.push({
          id: asset.id,
          channel,
          platform,
          downloads,
          createdAt: new Date(asset.created_at).toISOString(),
        });
      }
    }
    if (releases.length < 100) {
      if (response.headers.get("link")?.includes('rel="next"')) {
        throw new Error("Incomplete GitHub release page");
      }
      return assets;
    }
  }
  throw new Error("GitHub snapshot exceeds pagination bounds");
}

// Deltas require continuous comparable asset identities; uncertain scope coverage stays null.
function scopeCounts(
  current: SourceAsset[],
  previous: AssetHead[],
  previousAt: string | null,
): ScopeCount[] {
  const scopes = CHANNELS.flatMap((channel) =>
    PLATFORMS.map(
      (platform): ScopeCount => ({
        channel,
        platform,
        total: 0,
        downloads: previousAt === null ? null : 0,
      }),
    ),
  );
  const scope = (asset: AssetHead) =>
    scopes.find((row) => row.channel === asset.channel && row.platform === asset.platform)!;
  const oldById = new Map(previous.map((asset) => [asset.id, asset]));
  const newById = new Map(current.map((asset) => [asset.id, asset]));
  for (const asset of current) {
    const row = scope(asset);
    row.total += asset.downloads;
    const old = oldById.get(asset.id);
    if (old && (old.channel !== asset.channel || old.platform !== asset.platform)) {
      scope(old).downloads = null;
      row.downloads = null;
    } else if (
      old ? asset.downloads < old.downloads : previousAt === null || asset.createdAt <= previousAt
    ) {
      row.downloads = null;
    } else if (row.downloads !== null) {
      row.downloads += asset.downloads - (old?.downloads ?? 0);
    }
  }
  for (const old of previous) {
    if (!newById.has(old.id)) scope(old).downloads = null;
  }
  return scopes;
}

// All pages validate before one transactional D1 batch claims the new snapshot and head.
export async function captureInstallerDownloads(db: D1Database): Promise<void> {
  const startedAt = new Date().toISOString();
  const assets = await fetchAssets();
  const observedAt = new Date().toISOString();
  const latest = await db
    .prepare("SELECT MAX(observed_at) AS observedAt FROM installer_download_snapshots")
    .first<{ observedAt: string | null }>();
  const previousAt = latest?.observedAt ?? null;
  // A traversal started before a newer writer finished cannot replace that writer's head.
  if (previousAt !== null && previousAt >= startedAt) {
    throw new Error("Overlapping GitHub snapshot");
  }
  const previous = await db
    .prepare("SELECT asset_id AS id, channel, platform, downloads FROM installer_download_assets")
    .all<AssetHead>();
  const scopes = scopeCounts(assets, previous.results, previousAt);
  const cutoff = new Date(Date.parse(observedAt) - RETENTION_MS).toISOString();
  await db.batch([
    // Migration 0011 rejects duplicate, stale and racing claims, rolling back the entire batch.
    db
      .prepare(
        "INSERT INTO installer_download_snapshots (observed_at, previous_observed_at) VALUES (?, ?)",
      )
      .bind(observedAt, previousAt),
    ...scopes.map((row) =>
      db
        .prepare(
          "INSERT INTO installer_download_history (observed_at, channel, platform, total, downloads) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(observedAt, row.channel, row.platform, row.total, row.downloads),
    ),
    db.prepare("DELETE FROM installer_download_assets"),
    // One bounded JSON parameter avoids D1's per-statement bind limit on large release catalogs.
    db
      .prepare(
        `INSERT INTO installer_download_assets (asset_id, channel, platform, downloads)
         SELECT json_extract(value, '$.id'), json_extract(value, '$.channel'),
                json_extract(value, '$.platform'), json_extract(value, '$.downloads')
         FROM json_each(?)`,
      )
      .bind(JSON.stringify(assets.map(({ createdAt: _, ...asset }) => asset))),
    db.prepare("DELETE FROM installer_download_history WHERE observed_at < ?").bind(cutoff),
    db.prepare("DELETE FROM installer_download_snapshots WHERE observed_at < ?").bind(cutoff),
  ]);
}

// Product date filters select interval endpoints; the latest total is explicitly outside that range.
export async function loadInstallerDownloads(
  db: D1Database,
  filters: {
    fromTimestamp: string;
    beforeTimestamp: string;
    channel: string | null;
    surface: string | null;
  },
) {
  if (filters.surface === "ios" || filters.surface === "ipados") {
    return { status: "unsupported_store", observedAt: null, total: null, history: [] };
  }
  const clause = filters.channel ? " AND h.channel = ?" : "";
  const binds = filters.channel ? [filters.channel] : [];
  const latest = await db
    .prepare(
      `SELECT h.observed_at AS observedAt, SUM(h.total) AS total
       FROM installer_download_history h
       WHERE h.observed_at = (SELECT MAX(observed_at) FROM installer_download_snapshots)${clause}
       GROUP BY h.observed_at`,
    )
    .bind(...binds)
    .first<{ observedAt: string; total: number }>();
  const history = await db
    .prepare(
      `SELECT s.previous_observed_at AS "from", h.observed_at AS "to", SUM(h.total) AS total,
              CASE WHEN COUNT(*) = COUNT(h.downloads) THEN SUM(h.downloads) END AS downloads
       FROM installer_download_history h
       JOIN installer_download_snapshots s ON s.observed_at = h.observed_at
       WHERE h.observed_at >= ? AND h.observed_at < ?${clause}
       GROUP BY h.observed_at ORDER BY h.observed_at DESC`,
    )
    .bind(filters.fromTimestamp, filters.beforeTimestamp, ...binds)
    .all<{ from: string | null; to: string; total: number; downloads: number | null }>();
  return {
    status: latest ? "available" : "awaiting_snapshot",
    observedAt: latest?.observedAt ?? null,
    total: latest?.total ?? null,
    history: history.results,
  };
}
